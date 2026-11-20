// Worker running the ROBUSTO decoder off the main thread. Messages in:
//   { rate, port? }   load the decoder for rate; samples may come over port
//                     (from capture_worklet.js) or as messages
//   { samples }       a Float32Array of samples
//   { flush: true }   feed silence until a frame in progress is done
// Messages out: { ready: true }, { failed: message }, and
//   { events, peak, busy, flushed } with the decoder's events since the
//   last one, the peak level of the samples and whether a frame is being
//   received; sent for every event and otherwise about five times a
//   second; flushed is true on the report that answers a flush.

import { loadDecoder } from './robusto.js';

let decoder = null;
let peak = 0;
let quiet = 0;

function report(events, force, flushed = false) {
	quiet += 1;
	if (!force && !events.length && quiet < 2)
		return;
	for (const e of events)
		if (e.payload)
			e.payload = e.payload.slice();
	postMessage({ events, peak, busy: decoder.busy(), flushed }, events.filter((e) => e.payload).map((e) => e.payload.buffer));
	peak = 0;
	quiet = 0;
}

function feed(data) {
	if (!decoder)
		return;
	if (data.peak !== undefined)
		peak = Math.max(peak, data.peak);
	if (data.samples)
		report(decoder.feed(data.samples), false);
	if (data.flush)
		report(decoder.flush(), true, true);
}

onmessage = async (e) => {
	const data = e.data;
	if (data.rate) {
		try {
			decoder = await loadDecoder(data.rate);
		} catch (err) {
			postMessage({ failed: String(err.message ?? err) });
			return;
		}
		if (data.port)
			data.port.onmessage = (m) => feed(m.data);
		postMessage({ ready: true });
		return;
	}
	feed(data);
};
