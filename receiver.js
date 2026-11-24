// Listening: microphone -> AudioWorklet (capture_worklet.js) -> decoder
// worker (decoder_worker.js), and decoding a recording the same way. Runs
// at the AudioContext's own rate when ROBUSTO has modules for it (44100 or
// 48000), otherwise at 48000, which the browser then resamples to.

import { RATES } from './robusto.js';

const RATE_FALLBACK = 48000;

// a decoder worker for rate, ready to take samples
function startWorker(rate, port) {
	const worker = new Worker(new URL('./decoder_worker.js', import.meta.url), { type: 'module' });
	return new Promise((resolve, reject) => {
		worker.onerror = (e) => {
			worker.terminate();
			reject(new Error(e.message || 'decoder worker failed to start'));
		};
		worker.onmessage = (e) => {
			if (e.data.ready) {
				resolve(worker);
			} else if (e.data.failed) {
				worker.terminate();
				reject(new Error(e.data.failed));
			}
		};
		worker.postMessage({ rate, port }, port ? [port] : []);
	});
}

async function audioContext() {
	let ctx = new AudioContext();
	if (!RATES.includes(ctx.sampleRate)) {
		await ctx.close();
		ctx = new AudioContext({ sampleRate: RATE_FALLBACK });
	}
	return ctx;
}

// Start listening on an input device (its deviceId, or the default).
// onReport({ events, peak, busy }) is called as the decoder reports, and
// onEnded() when the microphone ends by itself (iOS ends it when the app
// goes to the background). Call from a user gesture, so the AudioContext
// may start. Returns { rate, deviceId, label, health(), stop() }; health()
// gives the context's state and the microphone's for when nothing comes.
// As on the modem's page, the microphone is asked for before the context:
// Safari reconfigures the audio hardware when the microphone starts, which
// stalls a context that already runs.
export async function listen({ deviceId = null, onReport, onEnded = () => {} }) {
	const stream = await navigator.mediaDevices.getUserMedia({
		audio: {
			deviceId: deviceId ? { exact: deviceId } : undefined,
			channelCount: 1,
			echoCancellation: false,
			noiseSuppression: false,
			autoGainControl: false,
		},
	});
	const parts = { stream };
	// never waits on the context: on iOS closing it may never settle
	let stopped = false;
	const stop = () => {
		stopped = true;
		parts.stream.getTracks().forEach((t) => t.stop());
		parts.worker?.terminate();
		parts.ctx?.close().catch(() => {});
	};
	try {
		parts.ctx = await audioContext();
		const ctx = parts.ctx;
		await ctx.audioWorklet.addModule(new URL('./capture_worklet.js', import.meta.url));
		const channel = new MessageChannel();
		parts.worker = await startWorker(ctx.sampleRate, channel.port2);
		parts.worker.onmessage = (e) => {
			if (e.data.events)
				onReport(e.data);
		};
		const node = new AudioWorkletNode(ctx, 'rattlechan-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
		node.port.postMessage({ port: channel.port1 }, [channel.port1]);
		ctx.createMediaStreamSource(stream).connect(node);
		// some browsers only run nodes that lead to the speakers; it outputs silence
		node.connect(ctx.destination);
		// not waited for: on iOS it may never settle
		ctx.resume().catch(() => {});
	} catch (err) {
		stop();
		throw err;
	}
	const track = stream.getAudioTracks()[0];
	track?.addEventListener('ended', () => {
		if (!stopped)
			onEnded();
	});
	const health = () => ({ context: parts.ctx.state, track: track?.readyState ?? 'none', muted: !!track?.muted });
	return { rate: parts.ctx.sampleRate, deviceId: track?.getSettings().deviceId ?? null, label: track?.label ?? '', health, stop };
}

// The audio inputs, with labels once the user allowed the microphone
export async function inputs() {
	const all = await navigator.mediaDevices.enumerateDevices();
	return all.filter((d) => d.kind === 'audioinput');
}

// Decode a recording (any format the browser decodes), resampled to the
// given rate. Returns the decoder's events.
export async function decodeRecording(bytes, rate = RATE_FALLBACK) {
	const audio = await new OfflineAudioContext(1, 1, rate).decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
	const samples = audio.getChannelData(0).slice();
	const worker = await startWorker(rate);
	try {
		return await new Promise((resolve) => {
			const events = [];
			worker.onmessage = (e) => {
				events.push(...e.data.events);
				if (e.data.flushed)
					resolve(events);
			};
			worker.postMessage({ samples, flush: true }, [samples.buffer]);
		});
	} finally {
		worker.terminate();
	}
}
