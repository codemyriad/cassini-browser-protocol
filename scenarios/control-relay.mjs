// The control-pipe relay of shared test 2 (D68, conformance/live-folder scenario.json
// resumeObservation). scenarios/native-launcher.mjs starts it detached, its stdout the
// browser's pipe from the launcher and its input a private FIFO the app's control host
// writes into, then execs the host. The relay copies the FIFO to stdout byte for byte,
// unchanged and unbuffered (one blocking write per read, before the next read), and exits
// at the end of its input. On the way it reads the bytes as native messaging frames
// (4-byte native-endian length, then that many bytes of UTF-8 JSON) and appends one JSON
// line per frame to its log, stamped with Date.now() once the whole frame has been read
// and before it is forwarded. A frame it cannot read is logged as `unparsable`; it keeps
// copying (the browser sees what the host wrote) but reads no further frames, and the
// driver fails the run. The browser-to-host direction never passes through here.
//
//   node control-relay.mjs <fifo> <log.jsonl>
import { closeSync, createReadStream, openSync, writeSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const MAX_FRAME = 1024 * 1024;  // Chrome's limit for host-to-browser messages
const decoder = new TextDecoder('utf-8', { fatal: true });

// Frames out of a byte stream that may arrive in any chunking. push(chunk, atWall) returns
// the frames completed by that chunk ({index, atWall, bytes, message}); once a frame is
// unreadable, `failure` says why and every later push returns []. end() reports a frame
// cut off by the end of input.
export class FrameReader {
  constructor({ endianness = os.endianness(), maxFrame = MAX_FRAME } = {}) {
    this.little = endianness === 'LE';
    this.maxFrame = maxFrame;
    this.buffer = Buffer.alloc(0);
    this.offset = 0;      // stream offset of buffer[0]
    this.count = 0;
    this.failure = null;
  }
  push(chunk, atWall) {
    if (this.failure) return [];
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    const frames = [];
    while (this.buffer.length >= 4) {
      const length = this.little ? this.buffer.readUInt32LE(0) : this.buffer.readUInt32BE(0);
      if (length > this.maxFrame) return this.fail(`frame ${this.count} declares ${length} bytes, over ${this.maxFrame}`, frames);
      if (this.buffer.length < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length);
      let message;
      try { message = JSON.parse(decoder.decode(body)); }
      catch (error) { return this.fail(`frame ${this.count} (${length} bytes): ${error.message}`, frames); }
      frames.push({ index: this.count++, atWall, bytes: length, message });
      this.buffer = this.buffer.subarray(4 + length);
      this.offset += 4 + length;
    }
    return frames;
  }
  fail(reason, frames) {
    this.failure = { reason, offset: this.offset };
    this.buffer = Buffer.alloc(0);
    return frames;
  }
  end() {
    if (!this.failure && this.buffer.length)
      this.failure = { reason: `input ended inside frame ${this.count} (${this.buffer.length} bytes buffered)`, offset: this.offset };
    return this.failure;
  }
}

// A resume request as scenario.json resumeObservation.request defines it.
export const isResumeRequest = message => message !== null && typeof message === 'object' && !Array.isArray(message) &&
  message.type === 'command' && message.action === 'start' && Object.hasOwn(message, 'resumeCapture');

// One log line per frame: type, action and requestId as written, and for a resume request
// resumeCapture's captureId and timelineOriginMs as written (null when absent).
export function frameRecord({ index, atWall, bytes, message }) {
  const object = message !== null && typeof message === 'object' && !Array.isArray(message);
  const record = { frame: index, atWall, bytes, type: object ? message.type ?? null : null,
    action: object ? message.action ?? null : null, requestId: object ? message.requestId ?? null : null };
  if (isResumeRequest(message)) {
    const target = message.resumeCapture;
    const field = name => (target !== null && typeof target === 'object' && Object.hasOwn(target, name) ? target[name] : null);
    record.resumeCapture = { captureId: field('captureId'), timelineOriginMs: field('timelineOriginMs') };
  }
  return record;
}

// Blocking write of the whole chunk (a pipe may take part of it, or be non-blocking).
function writeAll(fd, chunk) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let at = 0; at < chunk.length;) {
    try { at += writeSync(fd, chunk, at, chunk.length - at); }
    catch (error) { if (error.code !== 'EAGAIN') throw error; Atomics.wait(pause, 0, 0, 1); }
  }
}

export function relay(input, logPath, { output = 1 } = {}) {
  const log = openSync(logPath, 'a', 0o600);
  const note = value => writeSync(log, JSON.stringify(value) + '\n');
  note({ relay: process.pid, startedWall: Date.now(), endianness: os.endianness() });
  const reader = new FrameReader();
  let total = 0, reported = false;
  const report = () => { if (reader.failure && !reported) { reported = true; note({ unparsable: reader.failure.reason, offset: reader.failure.offset, atWall: Date.now() }); } };
  return new Promise(resolve => {
    const stream = createReadStream(input, { highWaterMark: 65536 });
    const finish = code => { try { closeSync(log); } catch {} resolve(code); };
    stream.on('data', chunk => {
      const atWall = Date.now();
      for (const frame of reader.push(chunk, atWall)) note(frameRecord(frame));
      report();
      try { writeAll(output, chunk); total += chunk.length; }
      catch (error) {
        // The browser end is gone: stop reading, so the host meets a closed pipe as it would.
        note({ outputError: error.code || error.message, atWall: Date.now(), bytes: total });
        stream.destroy(); finish(1);
      }
    });
    stream.on('error', error => { note({ inputError: error.code || error.message, atWall: Date.now(), bytes: total }); finish(1); });
    stream.on('end', () => {
      reader.end(); report();
      note({ end: true, atWall: Date.now(), bytes: total, frames: reader.count });
      finish(reader.failure ? 3 : 0);
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [input, logPath] = process.argv.slice(2);
  if (!input || !logPath) { process.stderr.write('usage: control-relay.mjs <fifo> <log.jsonl>\n'); process.exit(64); }
  process.exitCode = await relay(input, logPath);
}
