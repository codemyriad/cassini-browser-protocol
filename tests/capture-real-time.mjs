// D68.1 regression check: a capture longer than 30 s keeps real time.
//
// Chromium moves an AudioContext whose output has been all zeros for about 30 s (its silent sink
// suspender) off the audio device onto a timer. On hosted macOS that timer delivers 30-50% of
// real time. The extension's capture graph outputs silence by design, and the worklet stamps every
// frame by its context's render clock, so a suspended capture context makes every track's frames
// and timestamps fall behind the session. This drives the production capture() (extension/capture.js
// and pcm-worklet.js, served as the page loads them) for 45 s of audio and checks it took real time.
// The input does not matter: the capture context's own render clock sets the frames.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

const AUDIO_SECONDS = 45;   // well past the suspender's 30 s
const AFTER_SECONDS = 31;   // the rate is measured from here on, after the suspender would engage
const BOUND_SECONDS = 90;   // from the capture's start, before any audio too
const MIN_RATE = 0.97;      // audio seconds per wall second after AFTER_SECONDS of audio

const server = createServer(async (request, response) => {
  if (request.url === '/') { response.end('<!doctype html><title>Capture keeps real time</title><body>'); return; }
  if (!['/capture.js', '/pcm-worklet.js'].includes(request.url)) { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', 'text/javascript');
  response.end(await readFile(path.join(root, 'extension', request.url.slice(1))));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}/`;
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  await page.goto(address);
  const arrivals = [];  // [wall ms, cumulative frames] at each audio packet, recorded in Node
  const retries = [];
  let failure = null, frames = 0;
  await page.exposeFunction('recordAudio', count => { frames += count; arrivals.push([Date.now(), frames]); });
  await page.exposeFunction('recordFailure', message => { failure = message; });
  await page.exposeFunction('recordRetry', message => { retries.push(message); });
  const started = Date.now();
  await page.evaluate(async () => {
    const { capture } = await import('/capture.js');
    // A source track from its own context; its content and pace do not matter here.
    const source = new AudioContext({ sampleRate: 48000 }), oscillator = source.createOscillator(), output = source.createMediaStreamDestination();
    oscillator.connect(output); oscillator.start(); await source.resume();
    const send = async packet => { if (packet.type === 'audio') await window.recordAudio(atob(packet.pcm).length / 2); };
    window.capturing = await capture({ stream: output.stream, id: 'real-time', label: 'Real time', kind: 'local', origin: Date.now(),
      workletURL: location.origin + '/pcm-worklet.js', send, fail: message => window.recordFailure(String(message)),
      warn: message => window.recordRetry(String(message)) });
  });
  // Event wait: until the capture holds AUDIO_SECONDS of frames, bounded from the capture's start
  // (so a capture that never delivers audio fails here too, with its retries).
  for (;;) {
    assert.equal(failure, null, `capture failed: ${failure}`);
    if (frames / 48000 >= AUDIO_SECONDS) break;
    const elapsed = (Date.now() - started) / 1000;
    assert.ok(elapsed < BOUND_SECONDS, `only ${(frames / 48000).toFixed(1)} s of audio after ${elapsed.toFixed(1)} s` +
      (retries.length ? `; capture retries: ${JSON.stringify(retries)}` : ': the capture context fell behind real time'));
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  // The rate after the suspender would engage: between the first arrival past AFTER_SECONDS of audio
  // and the last, both counted at arrival, so no packet's frames are credited before its time.
  const from = arrivals.find(([, total]) => total / 48000 >= AFTER_SECONDS), to = arrivals.at(-1);
  const audio = (to[1] - from[1]) / 48000, wall = (to[0] - from[0]) / 1000, rate = audio / wall;
  const overall = (to[1] - arrivals[0][1]) / 48000 / ((to[0] - arrivals[0][0]) / 1000);
  console.log(`capture-real-time: after ${AFTER_SECONDS} s, ${audio.toFixed(2)} s of audio in ${wall.toFixed(2)} s of wall time ` +
    `(rate ${rate.toFixed(3)}; overall ${overall.toFixed(3)}; retries ${retries.length})`);
  assert.ok(rate >= MIN_RATE, `after ${AFTER_SECONDS} s the capture clock ran at ${rate.toFixed(3)} of real time (minimum ${MIN_RATE})`);
  await page.evaluate(() => window.capturing.stop());
} finally {
  await browser?.close();
  server.close();
}
