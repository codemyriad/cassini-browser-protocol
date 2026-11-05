export function base64(buffer) {
  const bytes = new Uint8Array(buffer);
  let text = "";
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
  return btoa(text);
}

async function bounded(promise, message, schedule = setTimeout, cancel = clearTimeout) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = schedule(() => reject(new Error(message)), 4000); })]);
  } finally { cancel(timer); }
}

// D68.1: Chromium moves an AudioContext whose output has been all zeros for about 30 s (its
// silent sink suspender) off the audio device onto a timer, which on some machines delivers far
// less than real time (0.3-0.5 on some CI virtual machines). The capture graph's output is silent by design,
// and the worklet stamps every frame by its context's render clock, so every track would fall
// behind the session. An inaudible constant (6e-8, -144 dBFS, below one 16-bit step) into the
// destination keeps the context on the device clock. Once per context, shared ones included;
// it never reaches the PCM (the worklet reads only its source).
export const KEEP_REAL_TIME_LEVEL = 6e-8;
const keepingRealTime = new WeakMap();
export function keepRealTime(context) {
  if (keepingRealTime.has(context)) return keepingRealTime.get(context);
  const constant = context.createConstantSource();
  constant.offset.value = KEEP_REAL_TIME_LEVEL;
  constant.connect(context.destination);
  constant.start();
  keepingRealTime.set(context, constant);
  return constant;
}

// D58 (R79): a classified start failure. `resultCode` is the open control-result
// vocabulary (SPEC-CONTROL "Result codes"), never the audio-plane `code`.
const classified = resultCode => error => {
  throw Object.assign(error instanceof Error ? error : new Error(String(error)), { resultCode });
};
// D61: one calibration per AudioContext, shared by every span on it. A pending
// calibration is its promise; a finished one is the context's clock record: the clock facts
// and clockOffset, fixed once measured, plus frame-indexed anchors that only ever add time
// (a resumed suspension, a render stall) and the stall detector's state (D61.1).
const clocks = new WeakMap();
const retirementReason = error => error?.code === "callChanged" ? "callChanged" :
  error?.code === "state" && error.scope === "source" && error.retired === true ? "ended" :
  error?.code === "state" && ["source", "command"].includes(error.scope) ? "stopped" : null;
const resuming = new WeakMap();
function resumeSuspended(context) {
  if (resuming.has(context)) return resuming.get(context);
  const began = performance.now(), render = context.currentTime || 0;
  const task = bounded(Promise.resolve().then(() => context.resume()), "Audio capture did not resume within four seconds.").then(() => {
    if (context.state !== "running") throw new Error("Audio capture remains suspended.");
    const gap = Math.max(0, performance.now() - began - ((context.currentTime || 0) - render) * 1000);
    const clock = clocks.get(context);
    if (!clock?.anchors) return;
    // Frames rendered before the suspension keep their mapping; the wall estimate applies
    // from the frame it began at. The detector then reseeds, so it never counts it twice,
    // unless a rise is still open.
    if (gap > 0) clock.anchors.push({ fromFrame: Math.round(render * clock.rate), addMs: gap });
    if (clock.pending && clock.level !== null) {
      // A rise still unsettled when the context suspended is not dropped: the level and its
      // readings move by the wall estimate, so what the stall lost stays a deviation to judge.
      clock.level += gap;
      for (const reading of clock.pending.readings) reading.x += gap;
    } else { clock.level = null; clock.ref = null; clock.pending = null; }
    observe(context, clock);
  });
  resuming.set(context, task);
  task.then(() => resuming.delete(context), () => resuming.delete(context));
  return task;
}

// D61.1 (extension 0.2.14): a render stall. While a context's rendering stalls its frames are
// never rendered, so render frames alone would place every later chunk early by the stall, and
// a later span on the context would inherit that. The audio thread writes each
// getOutputTimestamp pair, so its performanceTime - contextTime - outputLatency (the render
// instant minus the render position) is a level that main-thread jank cannot move; it rises by
// exactly the rendered time a stall lost. The detector tracks that level, tolerates jitter within
// STALL_STEP_MS and follows drift no faster than STALL_DRIFT (2 ms per rendered second), so a
// loss spread thinly over many readings still adds up to a step. A rise beyond STALL_STEP_MS
// that holds on a later fresh stamp, read at least STALL_CONFIRM_MS later (agreeing within
// STALL_AGREE_MS), re-anchors the context forward by the smaller agreeing step, from the
// stalled frame on. The wall separation matters after a
// renderer stall: the page then reads a backlog of chunks within a millisecond while rendering
// catches up faster than real time, so their stamps fall steadily and neighbours agree by chance.
// A rise that neither confirms nor reverts settles at its smallest reading SETTLE_MS after it
// opened; one that keeps flipping sign settles at no step then, so no chunk is held longer. At a
// span's Stop an unsettled rise places only that span's held chunks, at its smallest reading,
// and stays open for the context's other and later spans. A rise seen first against the
// calibration seed (plus the roundTrip uncertainty) is a freeze between calibration and the
// first device callbacks. Offsets never move backward; a confirmed fall only offsets a later
// rise. The origin is never re-read and the clock facts never change.
// The lost time reaches the host as an offset jump, its `jump` gap.
export const STALL_STEP_MS = 50, STALL_AGREE_MS = 20, STALL_CONFIRM_MS = 100, STALL_DRIFT = 0.002;
const SETTLE_READINGS = 4, SETTLE_MS = 1000;
function clockRecord({ level0, seedSlack, seedTime, stampTime, ...measured }) {
  return { ...measured, anchors: [{ fromFrame: 0, addMs: 0 }], level: level0, seedSlack, seeded: false,
    lastStampTime: stampTime, ref: { contextTime: seedTime }, pending: null, credit: 0, spans: new Set() };
}
function offsetFor(clock, frame) {
  let addMs = 0;
  for (const anchor of clock.anchors) if (anchor.fromFrame <= frame) addMs += anchor.addMs;
  return clock.clockOffset + addMs + frame / clock.rate * 1000;
}
// What settling the pending rise or fall on `readings` would do, without doing it.
function settlement(clock, readings) {
  const { sign } = clock.pending, xs = readings.map(reading => reading.x), before = clock.ref;
  const x = sign > 0 ? Math.min(...xs) : Math.max(...xs), total = clock.credit + x - clock.level;
  if (!(total > 0)) return { x, total, anchor: null };
  // Frames before the last fresh stamp were rendered before the stall: queued chunks of
  // them keep their mapping. Chunks a span already admitted are never moved.
  let held = Infinity;
  for (const span of clock.spans) if (span.heldFrom !== null) held = Math.min(held, span.heldFrom);
  const fromFrame = Math.max(before ? Math.round(before.contextTime * clock.rate) : 0, held === Infinity ? 0 : held);
  return { x, total, anchor: { fromFrame, addMs: total } };
}
function settle(clock, readings) {
  const { x, total, anchor } = settlement(clock, readings);
  // The level becomes the reading the step was taken at, so a rise that went on past it (a
  // continuous loss) is still a deviation, judged next.
  clock.level = x; clock.ref = readings.at(-1); clock.pending = null; clock.seeded = true;
  if (anchor) { clock.anchors.push(anchor); clock.credit = 0; } else clock.credit = total;
}
function read(clock, reading) {
  if (clock.level === null) { clock.level = reading.x; clock.ref = reading; clock.seeded = true; return; }
  const threshold = STALL_STEP_MS + (clock.seeded ? 0 : clock.seedSlack), deviation = reading.x - clock.level;
  if (Math.abs(deviation) <= threshold) {
    if (!clock.seeded) clock.level = reading.x;
    else {
      const most = Math.max(0, reading.contextTime - clock.ref.contextTime) * 1000 * STALL_DRIFT;
      clock.level += Math.max(-most, Math.min(most, deviation));
    }
    clock.ref = reading; clock.pending = null; clock.seeded = true;
    return;
  }
  const sign = Math.sign(deviation), pending = clock.pending;
  if (!pending || pending.sign !== sign) {
    // A flip keeps the time the context has been unsettled: the bound is per hold, not per sign.
    clock.pending = pending ? { sign, readings: [reading], since: pending.since, flipped: true } : { sign, readings: [reading], since: performance.now() };
    return;
  }
  const previous = pending.readings.findLast(earlier => reading.at - earlier.at >= STALL_CONFIRM_MS);
  pending.readings.push(reading);
  if (previous && Math.abs(reading.x - previous.x) <= STALL_AGREE_MS) settle(clock, [previous, reading]);
}
function observe(context, clock) {
  if (!clock?.anchors) return;
  const stamp = context.state === "running" ? context.getOutputTimestamp?.() : undefined;
  if (stamp?.contextTime > 0 && stamp?.performanceTime > 0 && stamp.contextTime !== clock.lastStampTime) {
    clock.lastStampTime = stamp.contextTime;
    read(clock, { x: stamp.performanceTime - stamp.contextTime * 1000 - latencyMs(context.outputLatency), contextTime: stamp.contextTime, at: performance.now() });
  }
  // Checked on events, never slept on.
  const pending = clock.pending;
  if (pending && performance.now() - pending.since >= SETTLE_MS) {
    // Readings on both sides of the level confirm nothing: release the hold with no step.
    if (pending.flipped) clock.pending = null;
    else settle(clock, pending.readings);
  }
  for (const span of [...clock.spans]) span.release();
}

// D61: the session origin is a wall-clock Date.now(). Map it onto this document's
// performance.now() once, so every later time is performance.now(),
// performanceTime or render frames: never performance.timeOrigin, which each
// document fixes on its own. Both methods place a render frame at the instant it
// reaches the output, as getOutputTimestamp does. The uncertainty is the part of the
// span's start error the extension measures; the browser's own latency estimates
// and input latency it never reports are outside it.
const latencyMs = value => Number.isFinite(value) && value > 0 ? value * 1000 : 0;
async function measure(context, node, origin, wait) {
  const a = Date.now(), p = performance.now(), b = Date.now();
  const originNow = p - ((a + b) / 2 - origin), rate = context.sampleRate, quantum = 128 / rate * 1000;
  let clockMethod = "outputTimestamp", clockOffset, uncertainty = b - a + 1 + quantum, level0, seedTime, seedSlack = 0;
  const stamp = context.getOutputTimestamp?.(), stampTime = stamp?.contextTime > 0 && stamp?.performanceTime > 0 ? stamp.contextTime : 0;
  if (stampTime) {
    clockOffset = stamp.performanceTime - originNow - stamp.contextTime * 1000;
    level0 = stamp.performanceTime - stamp.contextTime * 1000 - latencyMs(context.outputLatency);
    seedTime = stamp.contextTime;
  } else {
    // The worklet reads its render frame between t0 and t1, so half the round trip bounds
    // when; the frame moves once per device callback (baseLatency), and reaches the
    // output outputLatency after it is rendered.
    clockMethod = "roundTrip";
    const t0 = performance.now();
    const { frame, t1 } = await wait(new Promise(resolve => {
      node.port.onmessage = ({ data }) => { if (Number.isFinite(data?.clockFrame)) resolve({ frame: data.clockFrame, t1: performance.now() }); };
      node.port.postMessage("clock");
    }), "Audio render clock did not answer.");
    clockOffset = (t0 + t1) / 2 + latencyMs(context.outputLatency) - originNow - frame / rate * 1000;
    uncertainty += (t1 - t0) / 2 + Math.max(0, latencyMs(context.baseLatency) - quantum);
    level0 = (t0 + t1) / 2 - frame / rate * 1000;
    seedTime = frame / rate;
    seedSlack = Math.ceil(uncertainty);
  }
  // No PCM precedes currentTime. A negative start moves the whole span once, keeps
  // its spacing exact and is recorded; it proves an error at least that large. One a
  // day early is a fault, not a clamp. Chunks add the same start, so rounding cannot
  // leave the raised first chunk a hair below zero.
  const start = (context.currentTime || 0) * 1000, first = clockOffset + start, clockClampMs = first < 0 ? Math.ceil(-first) : 0;
  if (clockClampMs > 86400000) throw new Error("Audio timing fell before the recording start.");
  const raised = clockOffset + clockClampMs + start < 0 ? -start : clockOffset + clockClampMs;
  return { clockOffset: raised, clockMethod, originNow, rate, level0, seedSlack, seedTime, stampTime,
    clockUncertaintyMs: Math.min(86400000, Math.max(Math.ceil(uncertainty), clockClampMs)), ...(clockClampMs ? { clockClampMs } : {}) };
}
function calibrate(context, node, origin, wait) {
  if (!clocks.has(context)) {
    const task = measure(context, node, origin, wait).then(clockRecord);
    clocks.set(context, task);
    task.then(clock => { if (clocks.get(context) === task) clocks.set(context, clock); },
      () => { if (clocks.get(context) === task) clocks.delete(context); });
  }
  return Promise.resolve(clocks.get(context));
}

async function captureOnce({ stream, id, label, kind, origin, workletURL, send, fail, audible = false, enabled = () => true, channels = 1, sharedContext, getSharedContext, warn = () => {}, sourceTrackId, reportOutcomes = false, onAudio = () => {}, schedule, cancel }) {
  sharedContext ||= getSharedContext?.();
  const context = sharedContext || new AudioContext({ sampleRate: 48000 });
  const wait = (promise, message) => bounded(promise, message, schedule, cancel);
  let source, node, silent, remotePlayback, stopping = false, ending = false, failure = null;
  let pendingFrames = 0, sequence = 0, flushed, droppedFrames = 0, clock = null;
  // D61.1: chunks wait here, counted in pendingFrames, while the context's clock is unsettled,
  // or while it has no output stamp yet to check its calibration against (bounded like a rise).
  const waiting = [], inFlight = new Set(), held = [];
  let verified = false, holdSince = null, holds = 0;
  const span = { heldFrom: null, release: (force = false) => release(force) };
  let stateChanged, announced = false, ended = false, endOffsetMs = null;
  const end = async reason => {
    if (!reportOutcomes || !announced || ended) return;
    ended = true;
    try { await send({ type: "trackEnd", id, reason, droppedFrames, endOffsetMs }); }
    catch (error) { if (!retirementReason(error)) throw error; }
  };
  function pump() {
    while (waiting.length && inFlight.size < 4 && !failure && !ended) {
      const { message, frames } = waiting.shift();
      const task = Promise.resolve().then(() => send(message)).then(() => {
        endOffsetMs = Math.max(endOffsetMs ?? 0, message.offsetMs + frames * 1000 / context.sampleRate);
        if (!failure && !stopping && !ending && !ended) onAudio();
      }).catch(abort).finally(() => {
        pendingFrames -= frames; inFlight.delete(task); pump();
      });
      inFlight.add(task);
    }
  }
  function abort(error) {
    if (failure) return;
    failure = error;
    waiting.length = 0; held.length = 0; span.heldFrom = null;
    fail(error);
  }
  function admit(frame, pcm, frames, mapping = clock) {
    // Render frames space every chunk; arrival on the main thread never times one.
    const offsetMs = offsetFor(mapping, frame);
    if (!(offsetMs >= 0)) {
      droppedFrames += frames; pendingFrames -= frames;
      abort(new Error("Audio timing fell before the recording start."));
      return;
    }
    if (endOffsetMs !== null && offsetMs - endOffsetMs > 60000) {
      droppedFrames += frames; pendingFrames -= frames;
      abort(new Error("A suspended source needs a new audio span."));
      return;
    }
    const message = { type: "audio", id, sequence: sequence++, offsetMs, pcm: base64(pcm) };
    waiting.push({ message, frames });
    pump();
  }
  function settled() {
    if (clock.pending) return false;
    if (!verified && (clock.lastStampTime > 0 || holds >= SETTLE_READINGS || performance.now() - holdSince >= SETTLE_MS)) verified = true;
    return verified;
  }
  function release(force, mapping = clock) {
    if (!held.length || failure || (!force && !settled())) return;
    while (held.length && !failure) {
      const chunk = held.shift();
      span.heldFrom = held[0]?.frame ?? null;
      admit(chunk.frame, chunk.pcm, chunk.frames, mapping);
    }
  }
  try {
    await wait(context.audioWorklet.addModule(workletURL), "This meeting page blocks separate-track recording. Record the whole tab instead.").catch(classified("workletBlocked"));
    // Chromium may not decode a receiver for Web Audio until a media renderer exists.
    // Keep a silent renderer alive (crbug.com/40094084), without playing remote audio twice.
    if (kind === "remote") {
      remotePlayback = new Audio();
      remotePlayback.muted = true;
      remotePlayback.srcObject = stream;
      await wait(remotePlayback.play(), "A participant’s audio did not start. Record the whole tab instead.").catch(classified("audioBlocked"));
    }
    source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, "cassini-pcm", {
      channelCount: channels, channelCountMode: "explicit", outputChannelCount: [channels],
      processorOptions: { channels }
    });
    silent = context.createGain();
    silent.gain.value = 0;
    // A newly constructed worklet can observe its initial global frame before
    // the device clock catches up. Warm only the disconnected graph; no source
    // PCM is admitted or timestamp adjusted during this readiness handshake.
    const ready = new Promise(resolve => { node.port.onmessage = ({data}) => {if (data.ready) resolve();}; });
    node.connect(silent).connect(context.destination);
    keepRealTime(context);
    if (audible) source.connect(context.destination);
    await wait(context.resume(), "Click somewhere in the meeting page so the browser allows audio, then try again. Or record the whole tab.").catch(classified("audioBlocked"));
    if (context.state !== "running") throw Object.assign(new Error("Audio capture is suspended. Interact with the meeting page, then try again or use Tab audio."), { resultCode: "audioBlocked" });
    await wait(ready, "Audio render clock did not become ready.");
    source.connect(node);
    const cached = clocks.has(context);
    clock = await calibrate(context, node, origin, wait);
    holdSince = performance.now();
    clock.spans.add(span);
    // A later span takes its own reading, so it never starts on a mapping a stall made stale.
    if (cached) observe(context, clock);
    await send({ type: "track", id, label, kind, sampleRate: context.sampleRate, channels,
      ...(sourceTrackId ? { sourceTrackId } : {}), clockMethod: clock.clockMethod, clockUncertaintyMs: clock.clockUncertaintyMs,
      ...(clock.clockClampMs ? { clockClampMs: clock.clockClampMs } : {}) });
    announced = true;
    node.onprocessorerror = () => abort(new Error("Audio capture stopped unexpectedly."));
    stateChanged = () => {
      if (stopping || ending || context.state === "running") return;
      if (["suspended", "interrupted"].includes(context.state)) {
        void resumeSuspended(context).catch(abort);
      } else abort(new Error("Browser audio capture closed unexpectedly."));
    };
    context.addEventListener?.("statechange", stateChanged);
    node.port.onmessage = ({ data }) => {
      if (data.stopped) { if (stopping) ending = true; flushed?.(); return; }
      if (failure || ending || ended) return;
      // Every arrival reads the clock first, so a dropped chunk still feeds the detector.
      observe(context, clock);
      if (failure || ending || ended) return;
      const frames = data.pcm.byteLength / (channels * 2);
      if (pendingFrames + frames > context.sampleRate * 10) {
        droppedFrames += frames;
        warn("One track fell more than ten seconds behind and has a gap. The other tracks continue.", {kind:"gap"});
        return;
      }
      pendingFrames += frames;
      // For sender tracks, respect track enabled/muted state and sender suspension.
      if (!enabled()) new Uint8Array(data.pcm).fill(0);
      if (!held.length && settled()) { admit(data.frame, data.pcm, frames); return; }
      held.push({ frame: data.frame, pcm: data.pcm, frames });
      span.heldFrom ??= data.frame;
      holds++;
      release(false);
    };
    node.port.postMessage("start");
    return {
      get failed() { return !!failure; },
      get droppedFrames() { return droppedFrames; },
      async stop(reason = "stopped") {
        if (stopping) return;
        stopping = true;
        if (context.state === "running") {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Audio capture did not finish in time.")), 2000);
            flushed = () => { clearTimeout(timer); resolve(); };
            node.port.postMessage("stop");
          }).catch(abort);
        }
        // A held chunk is never lost on stop, and is placed before the end is declared. A rise
        // still unsettled places this span's chunks at its smallest reading, but is not
        // committed: one span's end is no evidence, and the context's other spans would keep it.
        observe(context, clock);
        if (clock.pending && held.length) {
          const { anchor } = settlement(clock, clock.pending.readings);
          release(true, anchor ? { ...clock, anchors: [...clock.anchors, anchor] } : clock);
        } else release(true);
        // Accept the worklet's final flush through its stopped barrier, then
        // fence even a retained callback before draining admitted PCM.
        ending = true;
        clock.spans.delete(span);
        node.port.onmessage = null; node.onprocessorerror = null;
        source.disconnect(); node.disconnect(); silent.disconnect();
        if (remotePlayback) { remotePlayback.pause(); remotePlayback.srcObject = null; }
        while (inFlight.size) await Promise.allSettled([...inFlight]);
        waiting.length = 0;
        context.removeEventListener?.("statechange", stateChanged);
        if (!sharedContext) await context.close();
        await end(retirementReason(failure) || (reason === "retry" ? "retry" : failure ? "failed" : reason));
        if (failure && !retirementReason(failure)) throw failure;
      }
    };
  } catch (error) {
    stopping = ending = true;
    if (node) { node.port.onmessage = null; node.onprocessorerror = null; }
    waiting.length = 0; held.length = 0;
    clock?.spans.delete(span);
    source?.disconnect(); node?.disconnect(); silent?.disconnect();
    if (remotePlayback) { remotePlayback.pause(); remotePlayback.srcObject = null; }
    context.removeEventListener?.("statechange", stateChanged);
    if (!sharedContext) await context.close();
    await end(retirementReason(error) || "failed").catch(() => {});
    throw error;
  }
}


// The same policy is exercised with a fake monotonic clock in both capture and
// discovery tests. Quiet PCM is healthy; only transport/source failures retry.
export function retryDelay(attempts) {
  return [1000, 5000, 15000][Math.max(0, attempts)] ?? 30000;
}

export function reconcile(state, attempts, lastHealthyAt, now) {
  if (state.stopping || state.live === false) return "giveUpAndReport";
  if (state.status === "recording") return "none";
  if (state.failedAt === null || state.failedAt === undefined) return "reattach";
  const recovered = lastHealthyAt !== null && lastHealthyAt !== undefined && state.failedAt - lastHealthyAt >= 60000;
  return now >= state.failedAt + retryDelay(recovered ? 0 : attempts) ? "reattach" : "none";
}

export async function capture(options) {
  let current = null, ending = false, terminal = null, retryTimer = null, retries = 0;
  let recovering = false, retiring = false, retiredDrops = 0, healthySince = null;
  let restarting = Promise.resolve();
  const warn = options.warn || (() => {});
  const now = options.clock || (() => performance.now());
  const later = options.schedule || ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.cancel || (timer => clearTimeout(timer));
  const live = options.live || (() => {
    const tracks = options.stream.getAudioTracks?.();
    return !tracks || tracks.some(track => track.readyState === "live");
  });
  const healthy = () => {
    if (recovering) warn(undefined, {kind:"recovered", sourceTrackId:options.sourceTrackId || options.id});
    recovering = false;
    healthySince ??= now();
    if (now() - healthySince >= 60000) retries = 0;
    options.onAudio?.();
  };
  const schedule = value => {
    if (ending || retiring || terminal || retryTimer !== null) return;
    const error = value instanceof Error ? value : new Error(String(value));
    if (retirementReason(error) && retirementReason(error) !== "ended") {
      // The token is deliberately fenced or already saved by the native app.
      retiring = true;
      if (retryTimer !== null) cancel(retryTimer);
      retryTimer = null;
      return;
    }
    const at = now();
    if (error.code === "limit" || reconcile({ live: live(), failedAt: at }, retries, healthySince, at) === "giveUpAndReport") {
      terminal = error; options.fail?.(error.message); return;
    }
    if (healthySince !== null && at - healthySince >= 60000) retries = 0;
    healthySince = null;
    recovering = true;
    warn(error.message, {kind:"retry", sourceTrackId:options.sourceTrackId || options.id});
    const delay = options.retryDelayMs ?? retryDelay(retries);
    retryTimer = later(async () => {
      retryTimer = null;
      restarting = (async () => {
        const previous = current; current = null;
        retiredDrops += previous?.droppedFrames || 0;
        await previous?.stop("retry").catch(() => {});
        if (ending) return;
        if (!live()) { terminal = error; options.fail?.(error.message); return; }
        retries++;
        try {
          const id = options.nextSpanId ? options.nextSpanId() : crypto.randomUUID();
          if (!id) throw Object.assign(new Error("This recording has reached its track limit."), {code:"limit",scope:"source"});
          current = await captureOnce({ ...options, id, fail: schedule, onAudio: healthy });
        } catch (next) { schedule(next); }
      })();
      await restarting;
    }, delay);
  };
  try { current = await captureOnce({ ...options, fail: schedule, onAudio: healthy }); }
  catch (error) { schedule(error); }
  return {
    get failed() { return !!terminal; },
    get state() { return ending || retiring ? "stopped" : terminal ? "failed" : recovering ? "retrying" : "recording"; },
    get droppedFrames() { return retiredDrops + (current?.droppedFrames || 0); },
    async stop(reason = "stopped") {
      if (ending) return;
      ending = true;
      if (retryTimer !== null) cancel(retryTimer);
      retryTimer = null;
      await restarting;
      try { await current?.stop(reason); } catch (error) { if (terminal) throw error; warn(error.message); }
      if (terminal) throw terminal;
    }
  };
}
