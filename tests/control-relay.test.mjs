// Unit tests for the control-pipe observation of shared test 2 (D68, conformance/live-folder
// scenario.json resumeObservation), without a browser: the frame reader, the relay process
// (byte-exact passthrough, unparsable frames, end of input) and the observing launcher
// (exec keeps the host the spawner's child, connections in launch order, the parent check,
// resume requests in pipe order). The test process plays the browser.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { open, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FrameReader, frameRecord, isResumeRequest, MAX_FRAME } from '../scenarios/control-relay.mjs';
import { controlConnections, parentPid, resumeRequests, RELAY, stopRelays, verifyControlPipe, writeNativeHost } from '../scenarios/native-launcher.mjs';
import { poll } from '../scenarios/folder-clock.mjs';

const scratch = await mkdtemp(path.join(os.tmpdir(), 'control-relay-'));
// A failing test must not leave hosts or relays behind (they would keep this process alive).
const children = new Set(), hosts = [];
test.after(async () => {
  for (const child of children) {
    child.stdin?.destroy(); child.stdout?.destroy();  // a host behind a wrapper sees its stdin end
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const host of hosts) await stopRelays(host);
  await rm(scratch, { recursive: true, force: true });
});
const track = child => { children.add(child); return child; };
const LE = os.endianness() === 'LE';
const BOUND = 10000;  // bound on each wait below; every wait ends on its event

function frame(value, { text = JSON.stringify(value), endianness = os.endianness() } = {}) {
  const body = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
  const head = Buffer.alloc(4);
  endianness === 'LE' ? head.writeUInt32LE(body.length) : head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}
const resume = (requestId, captureId = 'capture-1', timelineOriginMs = 1793880000000) =>
  ({ type: 'command', requestId, action: 'start', mode: 'tracks', tabId: 7, resumeCapture: { captureId, timelineOriginMs } });
const exited = child => new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
function collect(stream) {
  const chunks = [];
  stream.on('data', chunk => chunks.push(chunk));
  return { bytes: () => Buffer.concat(chunks), done: new Promise(resolve => stream.once('end', resolve)) };
}

test('frames are read across any chunk boundary, native-endian, stamped when complete', () => {
  const messages = [{ type: 'hello', text: 'caffè ☕' }, resume('r-1'), { type: 'command', action: 'stop', requestId: 'r-2' }];
  const bytes = Buffer.concat(messages.map(m => frame(m)));
  for (const size of [1, 2, 3, 5, 7, bytes.length]) {
    const reader = new FrameReader();
    const frames = [];
    for (let at = 0, tick = 0; at < bytes.length; at += size, tick++) frames.push(...reader.push(bytes.subarray(at, at + size), tick));
    assert.deepEqual(frames.map(f => f.message), messages, `chunks of ${size}`);
    assert.deepEqual(frames.map(f => f.index), [0, 1, 2]);
    let end = 0;
    for (const [index, m] of messages.entries()) {
      end += 4 + Buffer.byteLength(JSON.stringify(m));
      assert.equal(frames[index].atWall, Math.ceil(end / size) - 1, `frame ${index} is stamped by the chunk that completes it (chunks of ${size})`);
    }
    assert.equal(reader.end(), null);
  }
  // The other byte order is not this host's frame.
  const swapped = new FrameReader({ endianness: LE ? 'BE' : 'LE' });
  assert.deepEqual(swapped.push(frame({ a: 1 }, { endianness: LE ? 'BE' : 'LE' }), 0).map(f => f.message), [{ a: 1 }]);
  assert.equal(new FrameReader().push(frame({ a: 1 }, { endianness: LE ? 'BE' : 'LE' }), 0).length, 0);
});

test('an unreadable frame stops the reading and says why', () => {
  const cases = [
    [frame(null, { text: '{"type":' }), /frame 1 \(8 bytes\)/],
    [frame(null, { text: Buffer.from([0x7b, 0xff, 0x7d]) }), /frame 1 \(3 bytes\)/],
    [(() => { const b = Buffer.alloc(4); LE ? b.writeUInt32LE(MAX_FRAME + 1) : b.writeUInt32BE(MAX_FRAME + 1); return b; })(), /declares 1048577 bytes/],
  ];
  for (const [bad, reason] of cases) {
    const reader = new FrameReader();
    const frames = reader.push(Buffer.concat([frame({ ok: true }), bad, frame({ later: true })]), 1);
    assert.deepEqual(frames.map(f => f.message), [{ ok: true }], 'frames before the bad one are kept');
    assert.match(reader.failure.reason, reason);
    assert.equal(reader.failure.offset, 4 + 11);
    assert.deepEqual(reader.push(frame({ more: true }), 2), [], 'nothing is read after a failure');
  }
  const cut = new FrameReader();
  assert.deepEqual(cut.push(frame({ whole: 1 }).subarray(0, 6), 0), []);
  assert.match(cut.end().reason, /input ended inside frame 0 \(6 bytes buffered\)/);
});

test('a resume request is a start command with a resumeCapture member, logged as written', () => {
  assert.equal(isResumeRequest(resume('r')), true);
  assert.equal(isResumeRequest({ type: 'command', action: 'start', resumeCapture: null }), true);
  for (const other of [{ type: 'command', action: 'start' }, { type: 'command', action: 'stop', resumeCapture: {} },
    { type: 'event', action: 'start', resumeCapture: {} }, [1], null, 'start'])
    assert.equal(isResumeRequest(other), false, JSON.stringify(other));
  assert.deepEqual(frameRecord({ index: 4, atWall: 9, bytes: 99, message: resume('r-4', 'c', 5) }),
    { frame: 4, atWall: 9, bytes: 99, type: 'command', action: 'start', requestId: 'r-4', resumeCapture: { captureId: 'c', timelineOriginMs: 5 } });
  assert.deepEqual(frameRecord({ index: 0, atWall: 1, bytes: 2, message: { type: 'command', action: 'start', resumeCapture: 'odd' } }).resumeCapture,
    { captureId: null, timelineOriginMs: null });
  assert.deepEqual(frameRecord({ index: 0, atWall: 1, bytes: 2, message: [3] }),
    { frame: 0, atWall: 1, bytes: 2, type: null, action: null, requestId: null });
});

async function relayRun(name, input, chunk) {
  const fifo = path.join(scratch, `${name}.fifo`), log = path.join(scratch, `${name}.jsonl`);
  execFileSync('mkfifo', [fifo]);
  const child = track(spawn(process.execPath, [RELAY, fifo, log], { stdio: ['ignore', 'pipe', 'inherit'] }));
  const out = collect(child.stdout), exit = exited(child);
  const writer = await open(fifo, 'w');
  for (let at = 0; at < input.length; at += chunk) await writer.write(input.subarray(at, at + chunk));
  await writer.close();
  const [result] = await Promise.all([exit, out.done]);
  const entries = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { result, bytes: out.bytes(), entries };
}

test('the relay copies its input byte for byte, logs every frame and exits at the end of input', async () => {
  const filler = randomBytes(300000).toString('base64');  // frames larger than a pipe buffer
  const input = Buffer.concat([frame({ type: 'hello', filler }), frame(resume('r-1')), frame({ type: 'command', action: 'stop', requestId: 's' }),
    frame(resume('r-2', 'other', 'not a number'))]);
  const started = Date.now();
  const { result, bytes, entries } = await relayRun('passthrough', input, 4093);
  assert.deepEqual(result, { code: 0, signal: null });
  assert.ok(bytes.equals(input), 'stdout is the input, unchanged');
  assert.equal(entries[0].relay > 0 && entries[0].endianness, os.endianness());
  const frames = entries.filter(e => 'frame' in e);
  assert.deepEqual(frames.map(f => [f.frame, f.type, f.action, f.requestId, f.resumeCapture ?? null]), [
    [0, 'hello', null, null, null], [1, 'command', 'start', 'r-1', { captureId: 'capture-1', timelineOriginMs: 1793880000000 }],
    [2, 'command', 'stop', 's', null], [3, 'command', 'start', 'r-2', { captureId: 'other', timelineOriginMs: 'not a number' }]]);
  assert.ok(frames.every(f => f.atWall >= started && f.atWall <= Date.now()));
  assert.deepEqual(entries.at(-1), { ...entries.at(-1), end: true, bytes: input.length, frames: 4 });
  assert.ok(!entries.some(e => 'unparsable' in e));
});

test('the relay still forwards an unparsable frame unchanged, logs it and exits non-zero', async () => {
  const input = Buffer.concat([frame(resume('r-1')), frame(null, { text: 'not json' }), frame(resume('r-2'))]);
  const { result, bytes, entries } = await relayRun('unparsable', input, 5);
  assert.equal(result.code, 3);
  assert.ok(bytes.equals(input), 'the browser still gets every byte the host wrote');
  assert.deepEqual(entries.filter(e => 'frame' in e).map(e => e.requestId), ['r-1'], 'nothing is read after the bad frame');
  assert.match(entries.find(e => 'unparsable' in e).unparsable, /frame 1 \(8 bytes\)/);
  const cut = await relayRun('truncated', frame(resume('r-1')).subarray(0, 10), 3);
  assert.equal(cut.result.code, 3);
  assert.match(cut.entries.find(e => 'unparsable' in e).unparsable, /input ended inside frame 0/);
});

// A stand-in control host: prints [pid, ppid, argv] on stderr's stead (a file), writes the
// frames it is given (base64 in argv) to stdout, then waits for the browser to close stdin.
const HOST = `const fs=require('fs');const [out,...frames]=process.argv.slice(1, process.argv.indexOf('--browser'));
fs.writeFileSync(out,JSON.stringify({pid:process.pid,ppid:process.ppid,argv:process.argv.slice(process.argv.indexOf('--browser'))}));
for(const f of frames)fs.writeSync(1,Buffer.from(f,'base64'));process.stdin.on('data',()=>{}).on('end',()=>process.exit(0));`;

async function observedHost(name) {
  const directory = path.join(scratch, name);
  const host = await writeNativeHost({ manifestDirectory: path.join(directory, 'NativeMessagingHosts'), launcherDirectory: path.join(directory, "it's here"),
    pidDirectory: path.join(directory, 'pids'), observe: path.join(directory, 'control pipe'), name: 'io.example.control',
    command: [process.execPath, '-e', HOST], allowedOrigins: ['chrome-extension://abc/'] });
  hosts.push(host);
  return host;
}
// Launch as the browser does: the launcher is the test process's direct child.
async function launch(host, report, frames, spawner = null) {
  const args = [report, ...frames.map(f => f.toString('base64')), '--browser', 'chrome-extension://abc/', '--parent-window=0'];
  const child = track(spawner ? spawner(host.launcher, args) : spawn(host.launcher, args, { stdio: ['pipe', 'pipe', 'inherit'] }));
  const out = collect(child.stdout);
  const expected = Buffer.concat(frames);
  await poll(() => out.bytes().length >= expected.length, 'the browser end receives every byte the host wrote', BOUND, { pollMs: 5 });
  await poll(async () => { try { return JSON.parse(await readFile(report, 'utf8')); } catch { return false; } }, 'the host reports', BOUND, { pollMs: 5 });
  return { child, out, expected, report: JSON.parse(await readFile(report, 'utf8')) };
}

test('the observing launcher execs the host as the browser\'s child, numbers connections in launch order and yields resume requests', async () => {
  const host = await observedHost('connections');
  const manifest = JSON.parse(await readFile(host.manifest, 'utf8'));
  assert.equal(manifest.path, host.launcher);
  const first = await launch(host, path.join(scratch, 'first.json'), [frame({ type: 'hello' }), frame(resume('r-1'))]);
  const second = await launch(host, path.join(scratch, 'second.json'), [frame({ type: 'hello' }), frame(resume('r-2')), frame(resume('r-3', 'old', 1))]);
  for (const run of [first, second]) {
    assert.equal(run.report.pid, run.child.pid, 'exec keeps the launcher\'s pid');
    assert.equal(run.report.ppid, process.pid, 'the host is the browser\'s direct child');
    assert.deepEqual(run.report.argv, ['--browser', 'chrome-extension://abc/', '--parent-window=0']);
    assert.ok(run.out.bytes().equals(run.expected), 'host-to-browser bytes arrive unchanged');
    assert.equal(await parentPid(run.child.pid), process.pid);
  }
  // The browser-to-host direction is the host's own stdin: a byte written there reaches it.
  first.child.stdin.write('x');
  let connections = await poll(async () => {
    const value = await verifyControlPipe(host, process.pid, 'test');
    return value.length === 2 && value.every(c => c.resumes.length) && value[1].resumes.length === 2 ? value : null;
  }, 'both relays logged their frames', BOUND, { pollMs: 5 });
  assert.deepEqual(connections.map(c => [c.connection, c.pid, c.launchParent, c.live, c.parent]),
    [[1, first.child.pid, process.pid, true, process.pid], [2, second.child.pid, process.pid, true, process.pid]]);
  await assert.rejects(verifyControlPipe(host, process.pid + 100000, 'kill'), /kill: control host \d+ \(connection 1\) is not the browser's child/);
  const origin = connections[0].resumes[0].atWall - 1000;
  const requests = resumeRequests(connections, origin, Date.now());
  assert.deepEqual(requests.map(r => [r.via, r.connection, r.requestId, r.captureId, r.timelineOriginMs]), [
    ['control-pipe', 1, 'r-1', 'capture-1', 1793880000000], ['control-pipe', 2, 'r-2', 'capture-1', 1793880000000], ['control-pipe', 2, 'r-3', 'old', 1]]);
  assert.equal(requests[0].atMs, 1000);
  assert.ok(requests.every((r, i) => i === 0 || r.atMs >= requests[i - 1].atMs), 'pipe order');
  assert.deepEqual(resumeRequests(connections, origin, origin), [], 'nothing before the window ends: []');
  // Pipe order is relay time across connections: a later connection's earlier frame comes first.
  const at = (frame, atWall, requestId) => ({ frame, atWall, requestId, resumeCapture: { captureId: 'c', timelineOriginMs: 1 } });
  assert.deepEqual(resumeRequests([{ connection: 1, resumes: [at(0, 1300, 'a'), at(1, 1300, 'b')] }, { connection: 2, resumes: [at(0, 1200, 'c'), at(1, 1300, 'd')] }], 1000, 1300)
    .map(r => [r.atMs, r.connection, r.requestId]), [[200, 2, 'c'], [300, 1, 'a'], [300, 1, 'b'], [300, 2, 'd']]);
  // The browser closes the port: each host exits, its relay sees the end of input and exits.
  for (const run of [first, second]) { const exit = exited(run.child); run.child.stdin.end(); assert.deepEqual(await exit, { code: 0, signal: null }); await run.out.done; }
  connections = await poll(async () => { const value = await controlConnections(host); return value.every(c => c.ended) ? value : null; },
    'both relays end with their input', BOUND, { pollMs: 5 });
  assert.deepEqual(connections.map(c => [c.live, c.parent, c.frames.length]), [[false, null, 2], [false, null, 3]]);
  assert.deepEqual(await verifyControlPipe(host, process.pid, 'stop').then(c => c.length), 2, 'an exited host is checked by its launch parent');
  assert.deepEqual(await stopRelays(host), [], 'no relay left running');
});

test('a host that is not the browser\'s child, or an unparsable frame, fails the run', async () => {
  const host = await observedHost('wrong-parent');
  // A shell between the browser and the launcher (it does not exec the launcher: `; true`).
  const run = await launch(host, path.join(scratch, 'wrapped.json'), [frame(resume('r-1'))],
    (launcher, args) => spawn('/bin/sh', ['-c', '"$0" "$@"; true', launcher, ...args], { stdio: ['pipe', 'pipe', 'inherit'] }));
  assert.notEqual(run.report.ppid, process.pid);
  await assert.rejects(verifyControlPipe(host, process.pid, 'record'), /record: control host \d+ \(connection 1\) is not the browser's child: launched by \d+/);
  const exit = exited(run.child); run.child.stdin.end(); await exit;
  await poll(async () => (await controlConnections(host))[0].live === false, 'the wrapped host is gone', BOUND, { pollMs: 5 });
  await assert.rejects(verifyControlPipe(host, process.pid, 'stop'), /stop: control host \d+ \(connection 1\) is not the browser's child: launched by \d+, parent now null/,
    'an exited host is still held to its launch parent');

  const bad = await observedHost('unparsable');
  const broken = await launch(bad, path.join(scratch, 'broken.json'), [frame(resume('r-1')), frame(null, { text: '{nope' })]);
  assert.ok(broken.out.bytes().equals(broken.expected));
  await poll(async () => (await controlConnections(bad))[0]?.unparsable, 'the relay logs the unparsable frame', BOUND, { pollMs: 5 });
  await assert.rejects(verifyControlPipe(bad, process.pid, 'stop'), /stop: control connection 1 wrote a frame the relay cannot read/);
  const done = exited(broken.child); broken.child.stdin.end(); await done;
});

test('a relay whose input never ends is stopped by stopRelays', async () => {
  const host = await observedHost('stuck');
  // Keep the FIFO open for writing from here, so the relay never sees the end of input.
  const run = await launch(host, path.join(scratch, 'stuck.json'), [frame({ type: 'hello' })]);
  const fifo = path.join(host.observe, '1', 'out');
  const holder = await open(fifo, 'w');
  const exit = exited(run.child); run.child.stdin.end(); await exit;
  const [connection] = await controlConnections(host);
  assert.equal(connection.ended, false);
  assert.deepEqual(await stopRelays(host), [connection.relay]);
  // Gone, or a zombie: an orphaned relay's new parent (a container's pid 1) may never reap it.
  await poll(async () => {
    try { process.kill(connection.relay, 0); } catch { return true; }
    try { const stat = await readFile(`/proc/${connection.relay}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z'); }
    catch { return process.platform === 'linux'; }
  }, 'the relay exits', BOUND, { pollMs: 5 });
  await holder.close();
});
