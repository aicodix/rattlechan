// Transmitting: audio out of the default output, at the AudioContext's own
// rate when ROBUSTO has modules for it (44100 or 48000), otherwise at 48000,
// which the browser then resamples. The transmitter is keyed by VOX: the
// first frame's leading noise opens it.

import { RATES, loadEncoder } from './robusto.js';

let ctx = null;
const encoders = new Map();

// the output's AudioContext; call from a user gesture, so it may start
export async function output() {
	if (!ctx || ctx.state === 'closed') {
		ctx = new AudioContext();
		if (!RATES.includes(ctx.sampleRate)) {
			await ctx.close();
			ctx = new AudioContext({ sampleRate: 48000 });
		}
	}
	await ctx.resume();
	return ctx;
}

// the ROBUSTO encoder for a rate, loaded once
export function encoderFor(rate) {
	if (!encoders.has(rate))
		encoders.set(rate, loadEncoder(rate));
	return encoders.get(rate);
}

// Play samples at the output's rate. Returns { done, stop() }: done
// resolves to true when everything was played, false when stopped.
export function play(context, samples) {
	const buffer = context.createBuffer(1, samples.length, context.sampleRate);
	buffer.copyToChannel(samples, 0);
	const source = context.createBufferSource();
	source.buffer = buffer;
	source.connect(context.destination);
	let stopped = false;
	const done = new Promise((resolve) => {
		source.onended = () => resolve(!stopped);
	});
	source.start();
	return {
		done,
		stop: () => {
			stopped = true;
			source.stop();
		},
	};
}
