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
