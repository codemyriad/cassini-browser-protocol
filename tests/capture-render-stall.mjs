// R93 finding 1 reproduction: a real render stall of a capture AudioContext, and what the
// production capture() (extension/capture.js + pcm-worklet.js, served as the page loads them)
// then stamps on each chunk.
//
// A meeting frame shares one AudioContext and one calibration (D61). This opens source A on a
// shared capture context, waits for PRE seconds of A's audio, then stops a Chromium process with
// SIGSTOP for STALL seconds (STALL_TARGET: "audio" = the out-of-process audio service, "renderer"
// = every renderer process, which hosts the page, its AudioContexts and the AudioWorklet thread),
// and SIGCONT. After POST seconds of A's audio past the resume it starts source B on the same
// shared context (calibration cached) and control source C on a fresh context (its own
// calibration), and runs until B and C each have TAIL seconds.
//
// Truth is the page's monotonic clock: origin = Date.now() is read next to performance.now()
// once, and every chunk's arrival in send() is performance.now() - that reading. A chunk arrives
// after its last frame was rendered, so offsetMs + duration - arrival is a steady negative
// latency (about one 8192-frame batch); a stall that loses rendered time moves it down for good.
// A sampler (diagnostic cadence, not a wait) records currentTime, getOutputTimestamp(),
// outputLatency/baseLatency, state and playoutStats every SAMPLE_MS.
//
// Every wait is on an event (an audio count reached or a failure) bounded by one deadline; the
// only timer that is not a bound is the stall itself, which is the stimulus.
//
// Output: JSON lines in $STALL_OUT (default /out/stall.jsonl) and a summary on stdout.
import { createServer } from 'node:http';
import { readFile, readdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

const RATE = 48000;
const PRE = Number(process.env.PRE || 8);
const STALL = Number(process.env.STALL || 3);
const POST = Number(process.env.POST || 8);
const TAIL = Number(process.env.TAIL || 8);
const TARGET = process.env.STALL_TARGET || 'audio';
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 50);
const OUT = process.env.STALL_OUT || '/out/stall.jsonl';
const BOUND = (PRE + STALL + POST + TAIL + 60) * 1000;
const extraArgs = (process.env.CHROMIUM_ARGS || '').split(' ').filter(Boolean);

await writeFile(OUT, '');
const log = record => appendFile(OUT, JSON.stringify(record) + '\n');

const server = createServer(async (request, response) => {
  if (request.url === '/') { response.end('<!doctype html><title>Capture render stall</title><body>'); return; }
  if (!['/capture.js', '/pcm-worklet.js'].includes(request.url)) { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', 'text/javascript');
  response.end(await readFile(path.join(root, 'extension', request.url.slice(1))));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}/`;

// Chromium's process tree from /proc: descendants of the browser pid with their --type.
async function processes(browserPid) {
  const all = [];
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = await readFile(`/proc/${name}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const cmd = (await readFile(`/proc/${name}/cmdline`, 'utf8')).split(/[\0 ]/);
      all.push({ pid: Number(name), ppid, cmd });
    } catch { /* exited */ }
  }
  // The browser is the chrome process whose parent is not chrome (Playwright keeps no public pid).
  const chrome = all.filter(p => /chrom|headless_shell/.test(p.cmd[0] || ''));
  browserPid ??= chrome.find(p => !p.cmd.some(a => a.startsWith('--type=')))?.pid;
  const tree = new Set([browserPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of all) if (!tree.has(p.pid) && tree.has(p.ppid)) { tree.add(p.pid); grew = true; }
  }
  return all.filter(p => tree.has(p.pid)).map(p => ({
    pid: p.pid,
    type: (p.cmd.find(a => a.startsWith('--type=')) || '--type=browser').slice(7),
    sub: (p.cmd.find(a => a.startsWith('--utility-sub-type=')) || '').slice(19),
  }));
}

const counts = { A: 0, B: 0, C: 0 };
const waiters = [];
let failure = null;
const until = (predicate, what) => new Promise((resolve, reject) => {
  const waiter = { predicate, resolve, reject, what };
  if (failure) reject(failure); else if (predicate()) resolve(); else waiters.push(waiter);
});
const poke = () => {
  for (const w of [...waiters]) {
    if (failure) { w.reject(failure); waiters.splice(waiters.indexOf(w), 1); }
    else if (w.predicate()) { w.resolve(); waiters.splice(waiters.indexOf(w), 1); }
  }
};
const failWith = error => { failure ??= error; poke(); };

let browser, deadline;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}), args: ['--autoplay-policy=no-user-gesture-required', ...extraArgs] });
  const browserPid = undefined;
  const page = await browser.newPage();
  page.on('console', m => log({ kind: 'console', text: m.text() }));
  await page.goto(address);
  deadline = setTimeout(() => failWith(new Error(`bound ${BOUND} ms reached: ${JSON.stringify(counts)}`)), BOUND);
  await page.exposeFunction('report', batch => {
    for (const r of batch) {
      if (r.kind === 'chunk') counts[r.src] += r.frames / RATE;
      void log(r);
    }
    poke();
  });
  await page.exposeFunction('reportFailure', (src, message) => failWith(new Error(`${src} capture failed: ${message}`)));
  const procs = await processes(browserPid);
  await log({ kind: 'processes', browserPid, procs });
  const info = await page.evaluate(async ({ SAMPLE_MS }) => {
    const { capture } = await import('/capture.js');
    const a = Date.now(), p = performance.now(), b = Date.now();
    const origin = Math.round((a + b) / 2), originPerf = p - ((a + b) / 2 - origin);
    const session = () => performance.now() - originPerf;
    window.lab = { origin, originPerf, captures: {}, contexts: {}, buffer: [] };
    const flush = () => { if (window.lab.buffer.length) { const out = window.lab.buffer; window.lab.buffer = []; window.report(out); } };
    const push = r => { window.lab.buffer.push(r); if (r.kind === 'chunk') flush(); };
    const shared = new AudioContext({ sampleRate: 48000 });
    window.lab.contexts.shared = shared;
    const stat = context => {
      const ots = context.getOutputTimestamp?.();
      const ps = context.playoutStats;
      return { ct: context.currentTime, otsCt: ots?.contextTime, otsPt: ots?.performanceTime === undefined ? undefined : ots.performanceTime - originPerf,
        state: context.state, outLat: context.outputLatency, baseLat: context.baseLatency,
        ...(ps ? { ps: { fb: ps.fallbackDuration, fbN: ps.fallbackFramesEvents, total: ps.totalDuration, lat: ps.averageLatency } } : {}) };
    };
    // A diagnostic sampler on each capture context (cadence, not a wait).
    setInterval(() => {
      for (const [name, context] of Object.entries(window.lab.contexts)) push({ kind: 'sample', ctx: name, at: session(), ...stat(context) });
      if (window.lab.buffer.length > 40) flush();
    }, SAMPLE_MS);
    shared.onstatechange = () => push({ kind: 'state', ctx: 'shared', at: session(), state: shared.state });
    const input = async (freq) => {
      const context = new AudioContext({ sampleRate: 48000 }), output = context.createMediaStreamDestination();
      const oscillator = context.createOscillator(); oscillator.frequency.value = freq; oscillator.connect(output); oscillator.start();
      await context.resume();
      return output.stream;
    };
    window.lab.start = async (src, ctx, freq) => {
      const context = ctx === 'shared' ? shared : new AudioContext({ sampleRate: 48000 });
      if (ctx !== 'shared') { window.lab.contexts[ctx] = context; context.onstatechange = () => push({ kind: 'state', ctx, at: session(), state: context.state }); }
      const requested = session();
      const send = async packet => {
        const at = session();
        if (packet.type === 'audio') {
          const bytes = atob(packet.pcm).length;
          push({ kind: 'chunk', src, ctx, seq: packet.sequence, offsetMs: packet.offsetMs, frames: bytes / 2, at, ...stat(context) });
        } else push({ kind: 'packet', src, ctx, at, packet });
      };
      window.lab.captures[src] = await capture({ stream: await input(freq), id: src, label: src, kind: 'remote', origin,
        workletURL: location.origin + '/pcm-worklet.js', send, sharedContext: context,
        fail: message => window.reportFailure(src, String(message)),
        warn: (message, details) => push({ kind: 'warn', src, at: session(), message: String(message), details }) });
      push({ kind: 'started', src, ctx, requested, at: session() });
      flush();
    };
    return { origin, hasPlayoutStats: 'playoutStats' in shared, ua: navigator.userAgent };
  }, { SAMPLE_MS });
  await log({ kind: 'info', ...info, PRE, STALL, POST, TAIL, TARGET, extraArgs, channel: process.env.BROWSER_CHANNEL || 'headless-shell', pulse: !!process.env.PULSE_SERVER });
  const sessionNow = () => Date.now() - info.origin;

  await page.evaluate(() => window.lab.start('A', 'shared', 440));
  await until(() => counts.A >= PRE, `A ${PRE} s`);

  const victims = (await processes(browserPid)).filter(p => TARGET === 'audio' ? p.sub.includes('audio') : p.type === TARGET);
  if (!victims.length) throw new Error(`no ${TARGET} process in ${JSON.stringify(await processes(browserPid))}`);
  const stoppedAt = sessionNow();
  for (const v of victims) process.kill(v.pid, 'SIGSTOP');
  await log({ kind: 'stall', phase: 'stop', at: stoppedAt, victims, aSeconds: counts.A });
  await new Promise(resolve => setTimeout(resolve, STALL * 1000));  // the stimulus, not a wait
  const resumedAt = sessionNow();
  for (const v of victims) process.kill(v.pid, 'SIGCONT');
  await log({ kind: 'stall', phase: 'cont', at: resumedAt, aSeconds: counts.A });
  const aAtResume = counts.A;
  await until(() => counts.A >= aAtResume + POST, `A ${POST} s after resume`);

  await page.evaluate(() => Promise.all([window.lab.start('B', 'shared', 660), window.lab.start('C', 'fresh', 880)]));
  await until(() => counts.B >= TAIL && counts.C >= TAIL, `B and C ${TAIL} s`);
  await page.evaluate(() => Promise.all(Object.values(window.lab.captures).map(c => c.stop())));
  await log({ kind: 'done', at: sessionNow(), counts });
  console.log(`capture-render-stall: target=${TARGET} stall=${STALL}s done; ${JSON.stringify(counts)}; log ${OUT}`);
} catch (error) {
  await log({ kind: 'error', message: String(error?.stack || error) });
  console.error(error);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await browser?.close();
  server.close();
}
