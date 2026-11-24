// Transmitting: audio out of the default output, at the AudioContext's own
// rate when ROBUSTO has modules for it (44100 or 48000), otherwise at 48000,
// which the browser then resamples. The transmitter is keyed by VOX: the
// first frame's leading noise opens it.

import { RATES, loadEncoder } from './robusto.js';

let own = null;
const encoders = new Map();

// The AudioContext for a transmission, as on the modem's page (aicodix/modem,
// robusto branch, index.html): the receiver's own while it listens and runs,
// as Safari reconfigures the audio hardware when a microphone starts, which
// stalls a context that already runs, otherwise a new one each time, as
// iOS can break a context in the background that then still claims to run.
// Call it first thing in a click handler, before any await: iOS only lets a
// context start from a user gesture, and the gesture is gone after the first
// await. It never waits: on iOS resume() and close() may never settle.
export function wake(shared = null) {
	if (shared?.state === 'running') {
		quiet();
		return shared;
	}
	quiet();
	own = new AudioContext();
	if (!RATES.includes(own.sampleRate)) {
		own.close().catch(() => {});
		own = new AudioContext({ sampleRate: 48000 });
	}
	own.resume().catch(() => {});
	return own;
}

// closes the context wake() made, if any
export function quiet() {
	own?.close().catch(() => {});
	own = null;
}

// the ROBUSTO encoder for a rate, loaded once
export function encoderFor(rate) {
	if (!encoders.has(rate))
		encoders.set(rate, loadEncoder(rate));
	return encoders.get(rate);
}

// The output level, per device: dB below the modem's full scale
export const LEVEL_DEFAULT = -20;
export const LEVEL_MIN = -40;

// Play samples at the output's rate, level dB below full scale. Returns
// { done, stop() }: done resolves to true when everything was played,
// false when stopped.
export function play(context, samples, level = 0) {
	const buffer = context.createBuffer(1, samples.length, context.sampleRate);
	buffer.copyToChannel(samples, 0);
	const source = context.createBufferSource();
	source.buffer = buffer;
	const gain = context.createGain();
	gain.gain.value = 10 ** (Math.min(0, level) / 20);
	source.connect(gain).connect(context.destination);
	let stopped = false, ended;
	const done = new Promise((resolve) => {
		ended = resolve;
		source.onended = () => resolve(!stopped);
	});
	source.start();
	return {
		done,
		// resolves done at once: a closed context may never end its sources
		stop: () => {
			stopped = true;
			ended(false);
			try {
				source.stop();
			} catch {}
		},
	};
}

// Play parts, an iterable of sample arrays at the output's rate, back to
// back without a gap, level dB below full scale. Each part is taken only
// when fewer than two are waiting or those run out within ahead seconds,
// so a long transmission is never held whole. Returns { done, stop() } like play().
export const AHEAD = 12;

export function playParts(context, parts, level = 0, { destination = context.destination, ahead = AHEAD } = {}) {
	const gain = context.createGain();
	gain.gain.value = 10 ** (Math.min(0, level) / 20);
	gain.connect(destination);
	const it = parts[Symbol.iterator]();
	const live = new Set();
	// when the next part starts, set once the first is made: making it
	// takes a moment, and a start in the past would play it late
	let next = null;
	let stopped = false, finished = false, over = false, ended;
	const done = new Promise((resolve) => {
		ended = (complete) => {
			if (over)
				return;
			over = true;
			try {
				gain.disconnect();
			} catch {}
			resolve(complete);
		};
	});
	const schedule = () => {
		while (!stopped && !finished && (live.size < 2 || next - context.currentTime < ahead)) {
			const r = it.next();
			if (r.done) {
				finished = true;
				break;
			}
			const buffer = context.createBuffer(1, r.value.length, context.sampleRate);
			buffer.copyToChannel(r.value, 0);
			const source = context.createBufferSource();
			source.buffer = buffer;
			source.connect(gain);
			source.onended = () => {
				live.delete(source);
				if (stopped) {
					if (!live.size)
						ended(false);
					return;
				}
				schedule();
				if (finished && !live.size)
					ended(true);
			};
			next ??= context.currentTime + 0.05;
			source.start(next);
			next += r.value.length / context.sampleRate;
			live.add(source);
		}
		if (finished && !live.size)
			ended(!stopped);
	};
	schedule();
	return {
		done,
		// resolves done at once: a closed context may never end its sources
		stop: () => {
			if (stopped)
				return;
			stopped = true;
			ended(false);
			for (const source of live) {
				try {
					source.stop();
				} catch {}
			}
		},
	};
}
