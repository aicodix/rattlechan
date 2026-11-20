// AudioWorklet processor: hands the microphone's samples, in blocks of
// about a tenth of a second, to the port it is given (the decoder worker's),
// with the peak level of each block. Its output stays silent.

const BLOCK = 4096;

class Capture extends AudioWorkletProcessor {
	constructor() {
		super();
		this.out = null;
		this.buf = new Float32Array(BLOCK);
		this.fill = 0;
		this.peak = 0;
		this.port.onmessage = (e) => {
			this.out = e.data.port;
		};
	}

	process(inputs) {
		const input = inputs[0];
		const samples = input && input[0];
		if (!samples || !this.out)
			return true;
		for (let i = 0; i < samples.length; ++i) {
			const s = samples[i];
			this.buf[this.fill++] = s;
			const a = s < 0 ? -s : s;
			if (a > this.peak)
				this.peak = a;
			if (this.fill === BLOCK) {
				this.out.postMessage({ samples: this.buf, peak: this.peak }, [this.buf.buffer]);
				this.buf = new Float32Array(BLOCK);
				this.fill = 0;
				this.peak = 0;
			}
		}
		return true;
	}
}

registerProcessor('rattlechan-capture', Capture);
