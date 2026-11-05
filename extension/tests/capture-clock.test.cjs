const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../capture.js'), 'utf8');

// D61: Date.now() is the wall clock the session origin comes from; performance.now()
// is the document's monotonic clock. timeOrigin is deliberately unrelated to both,
// so a calibration that reads it moves every offset.
async function exercise(timestamp, { timeOrigin = 100000, currentTime = 0, clockFrame = 4800, frames = [0, 2048], spans = 1, retries = [], outputLatency, baseLatency } = {}) {
  const originals = new Map(['AudioContext', 'AudioWorkletNode', 'performance'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const wall = Date.now;
  let now = 100;
  const nodes = [], packets = [], failures = [], warnings = [], clockRequests = [], contexts = [];
  class GraphNode {
    connect(target) { return target; }
    disconnect() {}
  }
  class Context {
    sampleRate = 48000;
    currentTime = currentTime;
    outputLatency = outputLatency;
    baseLatency = baseLatency;
    state = 'running';
    destination = new GraphNode();
    audioWorklet = { addModule: async () => {} };
    constants = [];
    constructor() { contexts.push(this); }
    createMediaStreamSource() { return new GraphNode(); }
    createGain() { return Object.assign(new GraphNode(), { gain: { value: 1 } }); }
    createConstantSource() {
      const constant = Object.assign(new GraphNode(), { offset: { value: 1 }, started: false, targets: [] });
      constant.connect = target => { constant.targets.push(target); return target; };
      constant.start = () => { constant.started = true; };
      this.constants.push(constant);
      return constant;
    }
    async resume() { this.state = "running"; }
    async close() { this.state = 'closed'; }
  }
  if (timestamp !== undefined) Context.prototype.getOutputTimestamp = () => timestamp;
  class Worklet extends GraphNode {
    connect(target) { queueMicrotask(()=>this.port.onmessage?.({data:{ready:true}})); return target; }
    constructor() {
      super(); nodes.push(this);
      this.port = { onmessage: null, postMessage: message => {
        if (message === "stop") this.port.onmessage({ data: { stopped: true } });
        // A 10 ms round trip: the render frame is read at its midpoint.
        if (message === "clock") { clockRequests.push(now); now += 5; queueMicrotask(() => { now += 5; this.port.onmessage?.({ data: { clockFrame } }); }); }
      } };
    }
  }
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { timeOrigin, now: () => now } });
  Date.now = () => 100000 + now;
  globalThis.AudioContext = Context;
  globalThis.AudioWorkletNode = Worklet;
  try {
    const { capture } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    const sharedContext = spans > 1 ? new Context() : undefined, recorders = [];
    for (let span = 0; span < spans; span++) {
      recorders.push(await capture({ stream: {}, id: 'test-' + span, label: 'Test', kind: 'local', origin: 100100, sharedContext,
        workletURL: 'unused', send: async packet => packets.push(packet), fail: message => failures.push(message), warn: message => warnings.push(message) }));
      now += 250;
    }
    // Delayed delivery of a batch must not stretch the recorded sample timeline.
    for (const frame of frames) {
      now += 1000;
      for (const node of nodes) node.port.onmessage({ data: { pcm: new ArrayBuffer(4096), frame } });
      await new Promise(resolve => setImmediate(resolve));
    }
    for (const recorder of recorders) await recorder.stop();
    assert.deepEqual(failures, []);
    assert.deepEqual(warnings, retries, 'no span aborted or retried unless expected');
    return { audio: packets.filter(packet => packet.type === 'audio'), tracks: packets.filter(packet => packet.type === 'track'), clockRequests, contexts };
  } finally {
    Date.now = wall;
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.001, `${message}: ${actual}, expected ${expected}`);
const clockFields = track => ({ clockMethod: track.clockMethod, clockUncertaintyMs: track.clockUncertaintyMs, clockClampMs: track.clockClampMs });

test('output timestamp calibration preserves delayed AudioContext startup and declares its method', async () => {
  const { audio, tracks, clockRequests } = await exercise({ contextTime: 0.02, performanceTime: 880 });
  close(audio[0].offsetMs, 760, 'first batch start');
  close(audio[1].offsetMs - audio[0].offsetMs, 2048 / 48, 'render-frame spacing');
  // ceil(map 1 ms + one 128-frame quantum at 48 kHz); no clamp, no round trip.
  assert.deepEqual(clockFields(tracks[0]), { clockMethod: 'outputTimestamp', clockUncertaintyMs: 4, clockClampMs: undefined });
  assert.equal('clockClampMs' in tracks[0], false);
  assert.deepEqual(clockRequests, []);
});

test('without a positive output timestamp the worklet round trip calibrates with a strictly larger bound', async () => {
  for (const timestamp of [undefined, { contextTime: 0, performanceTime: 0 }]) {
    const { audio, tracks, clockRequests } = await exercise(timestamp, { currentTime: 0.1, frames: [4800, 6848] });
    // Frame 4800 read at 105 ms (midpoint of 100..110); the origin maps to 100 ms.
    close(audio[0].offsetMs, 105 - 100 - 100 + 4800 / 48, 'round-trip start');
    close(audio[1].offsetMs - audio[0].offsetMs, 2048 / 48, 'render-frame spacing');
    assert.equal(clockRequests.length, 1, 'one round trip per AudioContext');
    // ceil(map 1 + quantum 2.67 + half the 10 ms round trip).
    assert.deepEqual(clockFields(tracks[0]), { clockMethod: 'roundTrip', clockUncertaintyMs: 9, clockClampMs: undefined });
    const stamped = await exercise({ contextTime: 0.02, performanceTime: 880 });
    assert.ok(tracks[0].clockUncertaintyMs > stamped.tracks[0].clockUncertaintyMs, 'the round trip adds its measured half');
  }
});

test('both methods place a render frame at the instant it reaches the output, within their bounds', async () => {
  // One device: frame 4800 is rendered at 105 ms and reaches the output 40 ms later,
  // which is what getOutputTimestamp reports; the callback moves 20 ms of frames at once.
  const device = { currentTime: 0.1, frames: [4800, 6848], outputLatency: 0.04, baseLatency: 0.02 };
  const stamped = await exercise({ contextTime: 0.1, performanceTime: 145 }, device), trip = await exercise(undefined, device);
  close(stamped.audio[0].offsetMs, 45, 'output timestamp start');
  close(trip.audio[0].offsetMs, 45, 'round trip start, moved by outputLatency');
  // ceil(map 1 + the 20 ms callback in place of one quantum + half the 10 ms round trip).
  assert.deepEqual(clockFields(trip.tracks[0]), { clockMethod: 'roundTrip', clockUncertaintyMs: 26, clockClampMs: undefined });
  assert.ok(Math.abs(stamped.audio[0].offsetMs - trip.audio[0].offsetMs) <= stamped.tracks[0].clockUncertaintyMs + trip.tracks[0].clockUncertaintyMs);
});

test('a start raised to the origin is never a rounding hair below it', async () => {
  // These exact values make first -464 ms, and (offset + 464) + start == -2.8e-14 ms.
  const { audio, tracks } = await exercise({ contextTime: 171.723, performanceTime: 171106.75 }, { currentTime: 12108 / 48000, frames: [12108, 14156] });
  assert.equal(tracks[0].clockClampMs, 464);
  assert.equal(audio[0].offsetMs, 0);
  close(audio[1].offsetMs - audio[0].offsetMs, 2048 / 48, 'spacing stays exact');
});

test('a start more than a day before the origin is a fault, not a clamp', async () => {
  const { tracks } = await exercise({ contextTime: 90000, performanceTime: 1 }, { frames: [], retries: ['Audio timing fell before the recording start.'] });
  assert.deepEqual(tracks, [], 'no track is declared with a clamp past the schema maximum');
});

test('a chunk timed before the origin aborts its span visibly instead of clamping', async () => {
  // Frame 0 precedes the declared currentTime: no real worklet delivers it.
  const { audio } = await exercise(undefined, { currentTime: 0.1, frames: [0], retries: Array(2).fill('Audio timing fell before the recording start.') });
  // Reported once as the retry warning and once when Stop finds the span failed.
  assert.deepEqual(audio, []);
});

test('the track is declared calibrated, before any PCM is admitted', async () => {
  const { tracks } = await exercise({ contextTime: 0.02, performanceTime: 880 }, { frames: [] });
  assert.equal(tracks.length, 1);
  assert.equal(typeof tracks[0].clockUncertaintyMs, 'number');
});

test('a calibration before the origin raises the whole span once and records clockClampMs', async () => {
  // performanceTime 120 - origin 100 - contextTime 50 ms = -30 ms at currentTime 0.
  const { audio, tracks } = await exercise({ contextTime: 0.05, performanceTime: 120 }, { frames: [0, 2048, 4096] });
  assert.equal(tracks[0].clockClampMs, 30);
  assert.ok(tracks[0].clockUncertaintyMs >= tracks[0].clockClampMs, 'a clamp proves an error at least that large');
  close(audio[0].offsetMs, 0, 'the raised first chunk');
  for (let i = 1; i < audio.length; i++) close(audio[i].offsetMs - audio[i - 1].offsetMs, 2048 / 48, 'spacing stays exact');
  assert.ok(audio.every(packet => packet.offsetMs >= 0));
});

test('a skewed document timeOrigin leaves every offset unchanged', async () => {
  for (const timestamp of [{ contextTime: 0.02, performanceTime: 880 }, undefined]) {
    const clocks = { currentTime: 0.1, frames: [4800, 6848] };
    const straight = await exercise(timestamp, clocks), skewed = await exercise(timestamp, { ...clocks, timeOrigin: 100500 });
    assert.deepEqual(skewed.audio.map(packet => packet.offsetMs), straight.audio.map(packet => packet.offsetMs));
    assert.deepEqual(skewed.tracks.map(clockFields), straight.tracks.map(clockFields));
  }
});

test('a second span on a shared context repeats every clock field without recalibrating', async () => {
  // Frame 4800 at 105 ms with currentTime 0: the start is 95 ms before the origin.
  const { audio, tracks, clockRequests } = await exercise(undefined, { spans: 2 });
  assert.equal(tracks.length, 2);
  assert.equal(clockRequests.length, 1);
  assert.deepEqual(clockFields(tracks[0]), { clockMethod: 'roundTrip', clockUncertaintyMs: 95, clockClampMs: 95 });
  assert.deepEqual(clockFields(tracks[1]), clockFields(tracks[0]));
  const byId = id => audio.filter(packet => packet.id === id).map(packet => packet.offsetMs);
  assert.deepEqual(byId('test-1'), byId('test-0'), 'one calibration places both spans on one timeline');
  close(byId('test-0')[0], 0, 'frame 0 of the calibration raised by 95 ms');
});

// D68.1: Chromium suspends a context whose output stays all zeros for 30 s onto a timer that can
// run far slower than real time. Each capture context, a page's shared one included, gets exactly
// one inaudible constant into its destination, started, and never into the worklet's input.
test('each capture context keeps real time with one inaudible constant into its destination', async () => {
  for (const [label, options] of [['its own context', {}], ['a shared context with two spans', { spans: 2 }]]) {
    const { contexts } = await exercise(undefined, options);
    assert.equal(contexts.length, 1, label);
    const [context] = contexts;
    assert.equal(context.constants.length, 1, `${label}: one constant per context`);
    const [constant] = context.constants;
    assert.equal(constant.offset.value, 6e-8, `${label}: -144 dBFS, below one 16-bit step`);
    assert.equal(constant.targets.length, 1, `${label}: one connection`);
    assert.equal(constant.targets[0], context.destination, `${label}: into the destination itself`);
    assert.ok(constant.started, `${label}: started`);
  }
});

// D39 installers replace an installed companion only with a strictly newer one, so the D68.1
// capture fix shipped as 0.2.13 and the D61.1 stall re-anchor ships as 0.2.14 or later.
test('the companion that keeps capture on real time and re-anchors a stall is 0.2.14 or later', () => {
  const { version } = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'manifest.json'), 'utf8'));
  const [major, minor, patch] = version.split('.').map(Number);
  assert.ok(major > 0 || minor > 2 || (minor === 2 && patch >= 14), `manifest version ${version}`);
  assert.match(source, /export function keepRealTime\(context\)/, 'capture.js keeps each context on real time');
  assert.match(source, /export const STALL_STEP_MS = 50, STALL_AGREE_MS = 20, STALL_CONFIRM_MS = 100, STALL_DRIFT = 0.002;/, 'capture.js re-anchors a render stall');
});

test('ten-second source budget pipelines four requests, counts drops and leaves other sources running', async () => {
  const originals = new Map(['AudioContext', 'AudioWorkletNode'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const nodes = [], packets = [], failures = [], warnings = [], last = new Map();
  // D61: no offset is ever negative or earlier than its span's previous one.
  const ordered = packet => {
    if (packet.type !== 'audio') return;
    assert.ok(packet.offsetMs >= 0 && packet.offsetMs >= (last.get(packet.id) ?? 0), `offset ${packet.offsetMs}`);
    last.set(packet.id, packet.offsetMs);
  };
  let release, outstanding = 0, maximum = 0;
  const gate = new Promise(resolve => { release = resolve; });
  class GraphNode { connect(target) { return target; } disconnect() {} }
  class Context {
    sampleRate = 48000; state = 'running'; destination = new GraphNode();
    audioWorklet = { addModule: async () => {} };
    createMediaStreamSource() { return new GraphNode(); }
    createGain() { return Object.assign(new GraphNode(), { gain: { value: 1 } }); }
    createConstantSource() { return Object.assign(new GraphNode(), { offset: { value: 1 }, start() {} }); }
    async resume() { this.state = "running"; } async close() { this.state = 'closed'; }
    getOutputTimestamp() { return { contextTime: 0, performanceTime: 0 }; }
  }
  class Worklet extends GraphNode {
    connect(target) { queueMicrotask(()=>this.port.onmessage?.({data:{ready:true}})); return target; }
    constructor() {
      super(); nodes.push(this);
      this.port = { postMessage: message => {
        if (message === "stop") this.port.onmessage({ data: { stopped: true } });
        if (message === "clock") queueMicrotask(() => this.port.onmessage({ data: { clockFrame: 0 } }));
      } };
    }
  }
  globalThis.AudioContext = Context; globalThis.AudioWorkletNode = Worklet;
  try {
    const { capture } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    const recorder = await capture({ stream: {}, id: 'stalled', label: 'Stalled', kind: 'local', origin: Date.now(), workletURL: '',
      fail: message => failures.push(message), warn: message => warnings.push(message), send: async packet => {
        packets.push(packet); ordered(packet);
        if (packet.type === 'audio') { maximum = Math.max(maximum, ++outstanding); await gate; outstanding--; }
      } });
    for (let index = 0; index < 70; index++) nodes[0].port.onmessage({ data: { pcm: new ArrayBuffer(8192 * 2), frame: index * 8192 } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(maximum, 4);
    assert.equal(recorder.droppedFrames, 12 * 8192);
    assert.ok(warnings.length > 0);
    const healthyPackets = [];
    const healthy = await capture({ stream: {}, id: 'healthy', label: 'Healthy', kind: 'local', origin: Date.now(), workletURL: '',
      fail: message => failures.push(message), send: async packet => { ordered(packet); healthyPackets.push(packet); } });
    nodes[1].port.onmessage({ data: { pcm: new ArrayBuffer(8192 * 2), frame: 0 } });
    await healthy.stop();
    assert.equal(healthyPackets.filter(packet => packet.type === 'audio').length, 1);
    release(); await recorder.stop();
    assert.equal(packets.filter(packet => packet.type === 'audio').length, 58);
    assert.deepEqual(packets.filter(packet => packet.type === 'audio').map(packet => packet.sequence), Array.from({ length: 58 }, (_, i) => i));
    assert.deepEqual(failures, []);
  } finally {
    release();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

// D61.1: a scripted device for render stalls. `level` is the render instant minus the render
// position (ms). Rendering moves the wall clock and the render position together; a stall moves
// only the wall clock, so it raises the level by the rendered time it lost. Each rendered chunk
// restamps getOutputTimestamp (the audio thread's pair); a stall leaves the last stamp in place.
// Truth for a frame is the level when it was rendered plus its position: that is where the
// session timeline (origin 100000 = performance 0 here) places it.
async function device(run, { stamps = true, outputLatency = 0, retries = [] } = {}) {
  const originals = new Map(['AudioContext', 'AudioWorkletNode', 'performance'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const wall = Date.now;
  const dev = { ct: 0.1, level: 1000, outputLatency, stamps, state: 'running', noise: () => 0, extra: 0, suspendMs: 0 };
  let now = dev.level + dev.ct * 1000;
  const nodes = [], packets = [], warnings = [], failures = [], contexts = [], timers = [];
  const restamp = () => {
    dev.stamp = dev.stamps ? { contextTime: dev.ct, performanceTime: dev.level + dev.ct * 1000 + dev.outputLatency * 1000 + dev.noise() + dev.extra } : { contextTime: 0, performanceTime: 0 };
    dev.extra = 0;
  };
  restamp();
  class GraphNode { connect(target) { return target; } disconnect() {} }
  class Context {
    sampleRate = 48000; baseLatency = 0; destination = new GraphNode(); listeners = new Set();
    audioWorklet = { addModule: async () => {} };
    constructor() { contexts.push(this); }
    get currentTime() { return dev.ct; }
    get state() { return dev.state; }
    get outputLatency() { return dev.outputLatency; }
    createMediaStreamSource() { return new GraphNode(); }
    createGain() { return Object.assign(new GraphNode(), { gain: { value: 1 } }); }
    createConstantSource() { return Object.assign(new GraphNode(), { offset: { value: 1 }, start() {} }); }
    addEventListener(_name, fn) { this.listeners.add(fn); }
    removeEventListener(_name, fn) { this.listeners.delete(fn); }
    getOutputTimestamp() { return { ...dev.stamp }; }
    // A suspension lasts suspendMs of wall time; the device then stamps again.
    async resume() { if (dev.state === 'suspended') { now += dev.suspendMs; dev.level += dev.suspendMs; dev.state = 'running'; restamp(); } }
    async close() {}
  }
  class Worklet extends GraphNode {
    connect(target) { queueMicrotask(() => this.port.onmessage?.({ data: { ready: true } })); return target; }
    constructor() {
      super(); nodes.push(this);
      Object.assign(this, { armed: false, next: 0, stopped: false, chunks: [], queued: [] });
      this.port = { onmessage: null, postMessage: message => {
        if (message === 'start') { this.armed = true; this.next = Math.round(dev.ct * 48000); }
        if (message === 'clock') queueMicrotask(() => this.port.onmessage?.({ data: { clockFrame: Math.round(dev.ct * 48000) } }));
        if (message === 'stop') { this.stopped = true; this.port.onmessage?.({ data: { stopped: true } }); }
      } };
    }
  }
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { timeOrigin: 5, now: () => now } });
  Date.now = () => 100000 + now;
  globalThis.AudioContext = Context; globalThis.AudioWorkletNode = Worklet;
  const tick = () => new Promise(resolve => setImmediate(resolve));
  try {
    const { capture } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    let shared;
    const rig = {
      dev, nodes, packets, warnings, failures, timers, tick, contexts,
      get now() { return now; },
      async start(id, { own = false } = {}) {
        shared ??= new Context();
        const recorder = await capture({ stream: {}, id, label: id, kind: 'local', origin: 100000, workletURL: '', reportOutcomes: true,
          sharedContext: own ? undefined : shared, send: async packet => packets.push(packet),
          fail: message => failures.push(message), warn: (message, details) => warnings.push(details?.kind ?? message),
          schedule: (fn, ms) => { timers.push(fn); return timers.length; }, cancel: () => {}, retryDelayMs: 0 });
        const requested = now;
        return Object.assign(recorder, { requested, node: nodes.at(-1) });
      },
      // Render one 8192-frame batch on every armed worklet; `queue(node)` keeps it from the page.
      async render({ queue = () => false, drift = 0 } = {}) {
        now += 8192 / 48;
        dev.ct += 8192 / 48000;
        dev.level += drift;
        restamp();
        for (const node of nodes) {
          if (!node.armed || node.stopped) continue;
          const chunk = { frame: node.next, truth: dev.level + node.next / 48 + dev.outputLatency * 1000 };
          node.next += 8192;
          if (queue(node)) node.queued.push(chunk); else rig.deliver(node, chunk);
        }
        await tick();
      },
      deliver(node, chunk) {
        node.chunks.push(chunk);
        node.port.onmessage?.({ data: { pcm: new ArrayBuffer(8192 * 2), frame: chunk.frame } });
      },
      async flushQueued() { for (const node of nodes) for (const chunk of node.queued.splice(0)) rig.deliver(node, chunk); await tick(); },
      // After a renderer stall, rendering catches up faster than real time: the page reads a
      // backlog of batches within a millisecond, and the level falls by nearly a batch each.
      async catchUp() {
        now += 0.5; dev.ct += 8192 / 48000; dev.level -= 8192 / 48 - 0.5;
        restamp();
        for (const node of nodes) if (node.armed && !node.stopped) { rig.deliver(node, { frame: node.next, truth: NaN }); node.next += 8192; }
        await tick();
      },
      // Rendering stops: the wall clock goes on, frames and stamps do not.
      stall(ms) { now += ms; dev.level += ms; },
      audio(id) { return packets.filter(packet => packet.type === 'audio' && packet.id === id); },
      // Offset deltas beyond render-frame spacing, i.e. the jumps a host writes as gaps.
      jumps(id) {
        const chunks = rig.audio(id);
        return chunks.slice(1).map((chunk, i) => chunk.offsetMs - chunks[i].offsetMs - 8192 / 48).filter(delta => Math.abs(delta) > 0.001);
      },
    };
    await run(rig);
    assert.deepEqual(failures, []);
    assert.deepEqual(warnings, retries, 'D61.1 adds no warning: the host records the jump');
  } finally {
    Date.now = wall;
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}
// Each sent chunk of `id` against the truth of the chunk its worklet delivered in that order.
function placement(rig, recorder, id) {
  const sent = rig.audio(id);
  return sent.map((packet, i) => packet.offsetMs - recorder.node.chunks[i].truth);
}
const STEP_BOUND = 50;
const exact = (errors, message, within = 0.001) => assert.ok(errors.every(error => Math.abs(error) < within), `${message}: ${errors.map(e => e.toFixed(3)).join(', ')}`);

test('D61.1: a steady device places every chunk exactly as before, stamps fresh or constant', async () => {
  await device(async rig => {
    const a = await rig.start('A');
    for (let i = 0; i < 20; i++) await rig.render();
    await a.stop();
    exact(placement(rig, a, 'A'), 'fresh stamps on a steady level');
    assert.deepEqual(rig.jumps('A'), []);
  });
  // A stamp that never moves after calibration: every reading is stale, offsets are today's.
  await device(async rig => {
    const a = await rig.start('A');
    const frozen = { ...rig.dev.stamp };
    rig.dev.noise = () => 0;
    for (let i = 0; i < 20; i++) { await rig.render(); rig.dev.stamp = frozen; }
    await a.stop();
    exact(placement(rig, a, 'A'), 'constant stamp');
    assert.equal(rig.audio('A').length, 20);
  });
});

test('D61.1: ordinary jitter and drift never re-anchor (2 h at +-3 ms and 100 ppm; +-15 ms)', async () => {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (const [jitter, ppm, chunks] of [[3, 100, Math.ceil(7200 * 48000 / 8192)], [15, 0, 3000], [15, -100, 3000]]) {
    await device(async rig => {
      rig.dev.noise = () => (random() * 2 - 1) * jitter;
      const a = await rig.start('A');
      for (let i = 0; i < chunks; i++) await rig.render({ drift: 8192 / 48 * ppm / 1e6 });
      await a.stop();
      assert.equal(rig.audio('A').length, chunks);
      assert.deepEqual(rig.jumps('A'), [], `jitter ${jitter} ms, drift ${ppm} ppm: no anchor`);
    });
  }
});

test('D61.1: a stall that holds re-anchors once, by the stamp step, from the stalled frame', async () => {
  await device(async rig => {
    const a = await rig.start('A');
    for (let i = 0; i < 10; i++) await rig.render();
    rig.stall(491);
    for (let i = 0; i < 10; i++) await rig.render();
    await a.stop();
    const jumps = rig.jumps('A');
    assert.equal(jumps.length, 1); assert.ok(Math.abs(jumps[0] - 491) < 0.001, `jump ${jumps[0]}`);
    exact(placement(rig, a, 'A'), 'every chunk, before and after');
  });
});

test('D61.1: a renderer catch-up (5001, then 3365 twice) re-anchors by 3365 and never moves back', async () => {
  await device(async rig => {
    const a = await rig.start('A');
    for (let i = 0; i < 6; i++) await rig.render();
    rig.stall(3365);
    rig.dev.extra = 5001 - 3365; // the first stamp after resume briefly shows the whole stall
    for (let i = 0; i < 8; i++) await rig.render();
    await a.stop();
    const jumps = rig.jumps('A');
    assert.equal(jumps.length, 1); assert.ok(Math.abs(jumps[0] - 3365) < 0.001, `jump ${jumps[0]}`);
    exact(placement(rig, a, 'A'), 'every chunk');
  });
});

test('D61.1: a renderer catch-up burst re-anchors by what stays lost, not by stamps read during the burst', async () => {
  await device(async rig => {
    const a = await rig.start('A');
    for (let i = 0; i < 6; i++) await rig.render();
    rig.stall(2000);
    // 1830 ms of frames come back in one burst; 170 ms stay lost.
    while (rig.dev.level > 1000 + 170 + 8192 / 48) await rig.catchUp();
    rig.dev.level = 1170;
    for (let i = 0; i < 8; i++) await rig.render();
    await a.stop();
    const jumps = rig.jumps('A');
    assert.equal(jumps.length, 1); assert.ok(Math.abs(jumps[0] - 170) < 0.001, `jump ${jumps[0]}`);
    const errors = placement(rig, a, 'A').filter(error => !Number.isNaN(error));
    exact(errors, 'every chunk outside the burst');
  });
});

test('D61.1: a transient that reverts, a fall then an equal rise, and a latency change move nothing', async () => {
  // One stamp 300 ms high, then back.
  await device(async rig => {
    const a = await rig.start('A');
    for (let i = 0; i < 4; i++) await rig.render();
    rig.dev.extra = 300; await rig.render();
    for (let i = 0; i < 4; i++) await rig.render();
    await a.stop();
    assert.deepEqual(rig.jumps('A'), []);
  });
  // A confirmed fall of 300 is never applied; the later rise of 300 it offsets nets to zero.
  await device(async rig => {
    const a = await rig.start('A');
    for (let i = 0; i < 4; i++) await rig.render();
    rig.dev.level -= 300;
    for (let i = 0; i < 4; i++) await rig.render();
    rig.stall(300);
    for (let i = 0; i < 4; i++) await rig.render();
    await a.stop();
    assert.deepEqual(rig.jumps('A'), []);
  });
  // A device switch: performanceTime rises with outputLatency, the render level does not.
  await device(async rig => {
    const a = await rig.start('A');
    for (let i = 0; i < 4; i++) await rig.render();
    rig.dev.outputLatency += 0.15;
    for (let i = 0; i < 4; i++) await rig.render();
    await a.stop();
    assert.deepEqual(rig.jumps('A'), []);
  });
  // A stale stamp (same contextTime) never counts, whatever performanceTime it carries.
  await device(async rig => {
    const a = await rig.start('A');
    for (let i = 0; i < 4; i++) await rig.render();
    for (let i = 0; i < 4; i++) {
      const stamp = { ...rig.dev.stamp };
      await rig.render();
      rig.dev.stamp = { contextTime: stamp.contextTime, performanceTime: stamp.performanceTime + 2000 };
    }
    await a.stop();
    assert.deepEqual(rig.jumps('A'), []);
  });
});

test('D61.1: on a shared context a stall that A saw also places B and a later C, with the same facts', async () => {
  await device(async rig => {
    const a = await rig.start('A');
    for (let i = 0; i < 6; i++) await rig.render();
    rig.stall(1984);
    for (let i = 0; i < 6; i++) await rig.render();
    const b = await rig.start('B');
    for (let i = 0; i < 4; i++) await rig.render();
    const c = await rig.start('C');
    for (let i = 0; i < 4; i++) await rig.render();
    for (const recorder of [a, b, c]) await recorder.stop();
    exact(placement(rig, a, 'A'), 'A');
    exact(placement(rig, b, 'B'), 'B');
    exact(placement(rig, c, 'C'), 'C');
    assert.deepEqual(rig.jumps('B'), []); assert.deepEqual(rig.jumps('C'), []);
    const facts = rig.packets.filter(packet => packet.type === 'track').map(clockFields);
    assert.equal(facts.length, 3);
    for (const fact of facts) assert.deepEqual(fact, facts[0]);
  });
});

test('D61.1: B started on an idle context during a stall waits for the fresh stamp and starts right', async () => {
  await device(async rig => {
    const a = await rig.start('A');
    for (let i = 0; i < 4; i++) await rig.render();
    await a.stop();
    rig.stall(2000);                 // nothing renders; the stamp B reads on joining is stale
    const b = await rig.start('B');
    for (let i = 0; i < 6; i++) await rig.render();
    await b.stop();
    exact(placement(rig, b, 'B'), 'B from its first chunk');
    assert.deepEqual(rig.jumps('B'), []);
  });
});

test('D61.1: chunks rendered before the stall and queued past it keep their mapping', async () => {
  await device(async rig => {
    const a = await rig.start('A'), b = await rig.start('B');
    for (let i = 0; i < 4; i++) await rig.render();
    const late = node => node === a.node;
    await rig.render({ queue: late });   // A's batch, rendered before the stall, is still on its way;
    rig.stall(800);                       // B's arrival read the clock past it
    await rig.render({ queue: late });   // the first batch rendered after the stall
    await rig.flushQueued();              // A's queued batches arrive after the rise is seen
    for (let i = 0; i < 4; i++) await rig.render();
    await a.stop(); await b.stop();
    exact(placement(rig, a, 'A'), 'A: the queued pre-stall batch old, later ones new');
    exact(placement(rig, b, 'B'), 'B');
    for (const id of ['A', 'B']) {
      const jumps = rig.jumps(id);
      assert.equal(jumps.length, 1); assert.ok(Math.abs(jumps[0] - 800) < 0.001, `${id} jump ${jumps[0]}`);
    }
  });
});

test('D61.1: a freeze between a roundTrip calibration and the first stamp moves the whole span, with no jump', async () => {
  await device(async rig => {
    const a = await rig.start('A');
    assert.equal(rig.packets.find(packet => packet.type === 'track').clockMethod, 'roundTrip');
    rig.stall(1500);
    rig.dev.stamps = true;
    for (let i = 0; i < 8; i++) await rig.render();
    await a.stop();
    exact(placement(rig, a, 'A'), 'from the first chunk');
    assert.deepEqual(rig.jumps('A'), []);
  }, { stamps: false });
});

test('D61.1: a suspension re-anchors exactly once, by its wall estimate, from the suspended frame', async () => {
  await device(async rig => {
    const a = await rig.start('A');
    for (let i = 0; i < 4; i++) await rig.render();
    rig.dev.suspendMs = 700; rig.dev.state = 'suspended';
    for (const fn of [...rig.contexts[0].listeners]) fn();
    await rig.tick();
    assert.equal(rig.dev.state, 'running');
    for (let i = 0; i < 6; i++) await rig.render();
    await a.stop();
    const jumps = rig.jumps('A');
    assert.equal(jumps.length, 1); assert.ok(Math.abs(jumps[0] - 700) < 0.001, `jump ${jumps[0]}`);
    exact(placement(rig, a, 'A'), 'every chunk');
  });
});

test('D61.1: Stop during an unsettled rise sends the held chunks, placed, before trackEnd', async () => {
  await device(async rig => {
    const a = await rig.start('A');
    for (let i = 0; i < 4; i++) await rig.render();
    rig.stall(500);
    await rig.render();
    assert.equal(rig.audio('A').length, 4, 'the chunk after the rise is held');
    await a.stop();
    assert.equal(rig.audio('A').length, 5);
    const end = rig.packets.findIndex(packet => packet.type === 'trackEnd');
    assert.ok(end > rig.packets.lastIndexOf(rig.audio('A').at(-1)), 'audio before trackEnd');
    exact(placement(rig, a, 'A'), 'settled at its one reading');
  });
});

test('D61.1: a span that fails during an unsettled rise drops what it held', async () => {
  await device(async rig => {
    const a = await rig.start('A');
    for (let i = 0; i < 4; i++) await rig.render();
    rig.stall(500);
    await rig.render();
    rig.nodes[0].onprocessorerror();
    await a.stop();
    assert.equal(rig.audio('A').length, 4);
  }, { retries: ['retry', 'Audio capture stopped unexpectedly.'] });
});

test('D61.1: held chunks count toward the ten-second source buffer', async () => {
  await device(async rig => {
    const a = await rig.start('A');
    for (let i = 0; i < 4; i++) await rig.render();
    rig.stall(500);
    await rig.render();                  // the rise opens; this chunk is held
    const node = rig.nodes[0];
    for (let i = 0; i < 60; i++) { rig.deliver(node, { frame: node.next, truth: NaN }); node.next += 8192; }
    await rig.tick();
    assert.equal(rig.audio('A').length, 4, 'nothing is sent while the rise is unsettled');
    assert.equal(a.droppedFrames, 3 * 8192, '58 held chunks fill ten seconds');
    await rig.render();                  // the rise holds: what was held is placed and sent
    await a.stop();
    // The chunk that confirmed the rise arrived while the 58 were still pending: dropped too.
    assert.equal(a.droppedFrames, 4 * 8192);
    assert.equal(rig.audio('A').length, 4 + 58);
    const offsets = rig.audio('A').map(packet => packet.offsetMs);
    assert.ok(offsets.every((offset, i) => i === 0 || offset > offsets[i - 1]));
  }, { retries: ['gap', 'gap', 'gap', 'gap'] });
});

test('D61.1: a re-anchor of more than 60 s retires the span and the retry starts on the new anchor', async () => {
  await device(async rig => {
    const a = await rig.start('A');
    for (let i = 0; i < 4; i++) await rig.render();
    rig.stall(70000);
    await rig.render(); await rig.render();
    assert.equal(a.state, 'retrying');
    await rig.timers.pop()();          // the retry (earlier timers are the start bounds)
    for (let i = 0; i < 4; i++) await rig.render();
    await a.stop();
    const tracks = rig.packets.filter(packet => packet.type === 'track');
    assert.equal(tracks.length, 2);
    assert.deepEqual(clockFields(tracks[1]), clockFields(tracks[0]));
    const retried = { node: rig.nodes[1] };
    assert.equal(rig.audio(tracks[1].id).length, 4);
    exact(placement(rig, retried, tracks[1].id), 'the retry, on the new anchor');
  }, { retries: ['retry', 'recovered'] });
});

// R93 review: one span's Stop is no evidence about its context's clock. A rise still unsettled
// then places only that span's held chunks; the other spans keep judging it.
test('D61.1: a Stop during a one-stamp transient leaves the other spans on the context unmoved', async () => {
  await device(async rig => {
    const a = await rig.start('A'), b = await rig.start('B');
    for (let i = 0; i < 4; i++) await rig.render();
    rig.dev.extra = 300; await rig.render();          // one stamp 300 ms high, back on the next
    await a.stop();
    assert.equal(rig.audio('A').length, 5, 'A sends what it held before its end');
    for (let i = 0; i < 6; i++) await rig.render();
    await b.stop();
    assert.deepEqual(rig.jumps('B'), []);
    exact(placement(rig, b, 'B'), 'B after A stopped at the transient');
  });
});

test('D61.1: a Stop on the first stamp of a renderer catch-up leaves B to confirm the real loss', async () => {
  await device(async rig => {
    const a = await rig.start('A'), b = await rig.start('B');
    for (let i = 0; i < 4; i++) await rig.render();
    rig.stall(3365); rig.dev.extra = 5001 - 3365;
    await rig.render();
    await a.stop();
    for (let i = 0; i < 6; i++) await rig.render();
    await b.stop();
    const jumps = rig.jumps('B');
    assert.equal(jumps.length, 1); assert.ok(Math.abs(jumps[0] - 3365) < 0.001, `B jump ${jumps[0]}`);
    exact(placement(rig, b, 'B'), 'B');
  });
});

test('D61.1: a rise still unsettled when the context suspends is kept, then re-anchored with the suspension', async () => {
  await device(async rig => {
    const a = await rig.start('A');
    for (let i = 0; i < 4; i++) await rig.render();
    rig.stall(800);
    await rig.render();                                // the rise opens; this chunk is held
    rig.dev.suspendMs = 700; rig.dev.state = 'suspended';
    for (const fn of [...rig.contexts[0].listeners]) fn();
    await rig.tick();
    for (let i = 0; i < 6; i++) await rig.render();
    await a.stop();
    const jumps = rig.jumps('A');
    assert.equal(jumps.length, 2, `jumps ${jumps}`);
    assert.ok(Math.abs(jumps[0] - 800) < 0.001 && Math.abs(jumps[1] - 700) < 0.001, `jumps ${jumps}`);
    exact(placement(rig, a, 'A'), 'every chunk');
  });
});

test('D61.1: losses below the step per reading still add up to a re-anchor (ten 45 ms stalls)', async () => {
  await device(async rig => {
    const a = await rig.start('A');
    for (let i = 0; i < 4; i++) await rig.render();
    for (let k = 0; k < 10; k++) { rig.stall(45); for (let i = 0; i < 3; i++) await rig.render(); }
    await a.stop();
    const errors = placement(rig, a, 'A');
    // Main corrected none of the 450 ms. What drift tracking absorbs is bounded by STALL_DRIFT.
    assert.ok(errors.every(error => error <= 0.001 && error > -STEP_BOUND), `errors ${errors.map(e => e.toFixed(1))}`);
    assert.ok(Math.abs(errors.at(-1)) < 10, `last error ${errors.at(-1)}`);
  });
});

test('D61.1: a slow fall after a re-anchor becomes credit that offsets the next rise', async () => {
  await device(async rig => {
    const a = await rig.start('A');
    for (let i = 0; i < 4; i++) await rig.render();
    rig.stall(2000);
    for (let i = 0; i < 20; i++) await rig.render({ drift: -15 });   // 300 ms caught up slowly
    const over = placement(rig, a, 'A').at(-1);
    rig.stall(300);
    for (let i = 0; i < 6; i++) await rig.render();
    await a.stop();
    const jumps = rig.jumps('A'), errors = placement(rig, a, 'A');
    assert.ok(over > 200, `the over-correction a confirmed step cannot see coming: ${over}`);
    assert.ok(jumps.every(jump => jump > 0), 'offsets never move backward');
    // The last part of the fall, under one step, is tolerated as jitter and not credited.
    assert.ok(Math.abs(errors.at(-1)) < STEP_BOUND + 1, `the next rise is offset by the credit: ${errors.at(-1)} (was ${over})`);
  });
});

test('D61.1: stamps that keep crossing the level hold chunks at most about a second, and drop none', async () => {
  let k = 0;
  await device(async rig => {
    const a = await rig.start('A');
    for (let i = 0; i < 4; i++) await rig.render();
    rig.dev.noise = () => (k++ % 2 ? -100 : 100);
    for (let i = 0; i < 80; i++) {
      await rig.render();
      // One second is six 8192-frame batches; one more arrives before the bound is checked.
      assert.ok(rig.audio('A').length >= 4 + i + 1 - 7, `held ${4 + i + 1 - rig.audio('A').length} at batch ${i}`);
    }
    rig.dev.noise = () => 0;
    await a.stop();
    assert.equal(a.droppedFrames, 0);
    assert.equal(rig.audio('A').length, 84);
    assert.deepEqual(rig.jumps('A'), [], 'noise on both sides is no step');
  });
});

test('D61.1: rendering steadily slower than real time is re-anchored as it goes, never left to accumulate', async () => {
  await device(async rig => {
    const a = await rig.start('A');
    for (let i = 0; i < 4; i++) await rig.render();
    // 30 ms lost per 171 ms batch (rendering at 85% of real time): 1.8 s over the run.
    for (let i = 0; i < 60; i++) {
      await rig.render({ drift: 30 });
      assert.ok(rig.audio('A').length >= 4 + i + 1 - 7, `held ${4 + i + 1 - rig.audio('A').length} at batch ${i}`);
    }
    await a.stop();
    const errors = placement(rig, a, 'A');
    assert.ok(rig.jumps('A').every(jump => jump > 0), 'offsets never move backward');
    // What is left is at most a second of loss plus one step, never the 1.8 s.
    assert.ok(errors.every(error => error <= 0.001 && error > -(30 * 48000 / 8192 + STEP_BOUND)), `errors ${errors.map(e => e.toFixed(0))}`);
  });
});
