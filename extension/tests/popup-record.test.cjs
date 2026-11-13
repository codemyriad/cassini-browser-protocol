// popup-record-v1: the popup's Start/Stop asks the connected app over the
// control port; the app records through its ordinary command. VM fixture only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup, until } = require('./support/app-control-harness.cjs');

const popup = { id: 'extension', url: 'chrome-extension://extension/popup.html' };
function rpc(app, message, sender = popup) {
  return new Promise(resolve => app.chrome.runtime.onMessage.emit({ target: 'background', ...message }, sender, resolve));
}
const plain = value => JSON.parse(JSON.stringify(value));
const sent = (port, type) => port.sent.filter(message => message.type === type);
async function optIn(app, enabled = true) {
  const port = app.ports.at(-1);
  port.onMessage.emit({ type: 'recordRequests', enabled });
  await until(() => sent(port, 'recordRequestsConfigured').length);
  return sent(port, 'recordRequestsConfigured').at(-1);
}
async function asked(app, count = 1) {
  const port = app.ports.at(-1);
  await until(() => sent(port, 'recordRequest').length >= count);
  return sent(port, 'recordRequest')[count - 1];
}

test('popup record: hello advertises the capability; requests need the app to opt in on this connection', async () => {
  const app = await setup();
  try {
    assert.ok(app.ports[0].sent[0].capabilities.includes('popup-record-v1'));
    let reply = await rpc(app, { type: 'status', tabId: 2 });
    assert.equal(reply.appRecording, 'unsupported');
    reply = await rpc(app, { type: 'recordRequest', action: 'start', tabId: 2 });
    assert.equal(reply.code, 'unsupported');
    assert.match(reply.error, /cannot start or stop recordings from the browser/);
    assert.equal(sent(app.ports[0], 'recordRequest').length, 0);
    // Malformed opt-ins are ignored without an acknowledgement.
    for (const bad of [{ type: 'recordRequests' }, { type: 'recordRequests', enabled: 'yes' }, { type: 'recordRequests', enabled: true, extra: 1 }])
      app.ports[0].onMessage.emit(bad);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent(app.ports[0], 'recordRequestsConfigured').length, 0);
    assert.deepEqual(plain(await optIn(app)), { type: 'recordRequestsConfigured', enabled: true });
    assert.equal((await rpc(app, { type: 'status', tabId: 2 })).appRecording, 'available');
    const next = await app.reconnect();
    assert.equal((await rpc(app, { type: 'status', tabId: 2 })).appRecording, 'unsupported', 'reconnect starts without opt-in');
    assert.equal(sent(next, 'recordRequestsConfigured').length, 0);
    assert.deepEqual(plain(await optIn(app, false)), { type: 'recordRequestsConfigured', enabled: false });
  } finally { app.close(); }
});

test('popup record: Start asks the app, which records through its own command', async () => {
  const app = await setup();
  try {
    await optIn(app);
    const reply = rpc(app, { type: 'recordRequest', action: 'start', tabId: 2 });
    const ask = await asked(app);
    assert.deepEqual(Object.keys(ask).sort(), ['action', 'callGeneration', 'requestId', 'tabId', 'type']);
    assert.equal(ask.action, 'start'); assert.equal(ask.tabId, 2);
    assert.equal(ask.callGeneration, app.api.callInfo(2).generation);
    assert.equal(app.audio.length, 0, 'the extension never starts native capture for the ask itself');
    const pending = await rpc(app, { type: 'status', tabId: 2 });
    assert.deepEqual(plain(pending.recordRequest), { action: 'start', state: 'pending' });
    assert.equal((await rpc(app, { type: 'recordRequest', action: 'start', tabId: 2 })).code, 'busy', 'one ask per tab at a time');
    app.ports[0].onMessage.emit({ type: 'recordRequestResult', requestId: 'someone-else', ok: false, error: 'ignored' });
    app.ports[0].onMessage.emit({ type: 'recordRequestResult', requestId: ask.requestId, ok: true });
    const accepted = await reply;
    assert.equal(accepted.error, undefined);
    assert.deepEqual(plain(accepted.recordRequest), { action: 'start', state: 'accepted' });
    // The app's own manual Start: its options, its requestId.
    const result = await app.command({ type: 'command', requestId: 'app-manual-1', action: 'start', tabId: 2, mode: 'tracks', independent: true, keepOnNavigation: true, callGeneration: ask.callGeneration });
    assert.equal(result.ok, true);
    assert.equal(app.audio.at(-1).sent[0].requestId, 'app-manual-1');
    const recording = await rpc(app, { type: 'status', tabId: 2 });
    assert.equal(recording.recording, true);
    assert.equal(recording.recordRequest, undefined, 'the accepted ask clears once capture reflects it');
    // Stop names the running capture, and the app stops it with its own command.
    const stopReply = rpc(app, { type: 'recordRequest', action: 'stop', tabId: 2 });
    const stopAsk = await asked(app, 2);
    assert.deepEqual(plain(stopAsk), { type: 'recordRequest', requestId: stopAsk.requestId, action: 'stop', tabId: 2, captureId: recording.captureId });
    assert.notEqual(stopAsk.requestId, ask.requestId);
    app.ports[0].onMessage.emit({ type: 'recordRequestResult', requestId: stopAsk.requestId, ok: true });
    assert.deepEqual(plain((await stopReply).recordRequest), { action: 'stop', state: 'accepted' });
    assert.equal((await app.command({ type: 'command', requestId: 'app-stop-1', action: 'stop', tabId: 2, independent: true, reason: 'user', captureId: recording.captureId })).ok, true);
    const idle = await rpc(app, { type: 'status', tabId: 2 });
    assert.equal(idle.recording, false); assert.equal(idle.recordRequest, undefined);
    assert.equal(app.audio.at(-1).sent.find(packet => packet.type === 'stop').reason, 'user');
  } finally { app.close(); }
});

test('popup record: the app refusal reaches the popup; an accepted ask that never starts expires', async () => {
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  const app = await setup(3, {}, [], null, 'token-', null, { Date: Clock });
  try {
    await optIn(app);
    let reply = rpc(app, { type: 'recordRequest', action: 'start', tabId: 2 });
    let ask = await asked(app);
    app.ports[0].onMessage.emit({ type: 'recordRequestResult', requestId: ask.requestId, ok: false, error: 'Choose what to record in Cassini first.', code: 'needsSetup' });
    reply = await reply;
    assert.equal(reply.error, 'Choose what to record in Cassini first.'); assert.equal(reply.code, 'needsSetup');
    assert.equal((await rpc(app, { type: 'status', tabId: 2 })).recordRequest, undefined);
    reply = rpc(app, { type: 'recordRequest', action: 'start', tabId: 2 });
    ask = await asked(app, 2);
    app.ports[0].onMessage.emit({ type: 'recordRequestResult', requestId: ask.requestId, ok: false, error: 'x'.repeat(3000), code: 'not a code' });
    reply = await reply;
    assert.equal(reply.error.length, 2000); assert.equal(reply.code, undefined);
    reply = rpc(app, { type: 'recordRequest', action: 'start', tabId: 2 });
    ask = await asked(app, 3);
    app.ports[0].onMessage.emit({ type: 'recordRequestResult', requestId: ask.requestId, ok: true });
    assert.equal((await reply).recordRequest.state, 'accepted');
    now += 9999;
    assert.equal((await rpc(app, { type: 'status', tabId: 2 })).recordRequest.state, 'accepted');
    now += 1;
    assert.equal((await rpc(app, { type: 'status', tabId: 2 })).recordRequest, undefined, 'an ask the app never acted on stops claiming progress');
    assert.equal(app.audio.length, 0);
  } finally { app.close(); }
});

test('popup record: Start is refused locally, before any ask, when the tab cannot be recorded', async () => {
  const app = await setup();
  try {
    await optIn(app);
    app.tabs.set(5, { id: 5, title: 'Settings', url: 'chrome://settings/' });
    const cases = [
      [{ action: 'start', tabId: 99 }, 'noSources'],
      [{ action: 'start', tabId: 5 }, 'notWebPage'],
      [{ action: 'start', tabId: 404 }, 'gone'],
      [{ action: 'stop', tabId: 2 }, 'gone'],
      [{ action: 'record', tabId: 2 }, 'invalid'],
      [{ action: 'start', tabId: -1 }, 'invalid'],
      [{ action: 'start', tabId: '2' }, 'invalid'],
    ];
    for (const [message, code] of cases) assert.equal((await rpc(app, { type: 'recordRequest', ...message })).code, code, JSON.stringify(message));
    assert.equal(sent(app.ports[0], 'recordRequest').length, 0);
    const other = await rpc(app, { type: 'recordRequest', action: 'start', tabId: 2 }, { id: 'extension', url: 'chrome-extension://extension/other.html' });
    assert.match(other.error, /Only the extension popup/);
    assert.equal(sent(app.ports[0], 'recordRequest').length, 0);
  } finally { app.close(); }
});

test('popup record: a disconnected or silent app fails the ask; it is never retried', async () => {
  const app = await setup();
  try {
    await optIn(app);
    let reply = rpc(app, { type: 'recordRequest', action: 'start', tabId: 2 });
    await asked(app);
    const timer = [...app.timers.entries()].find(([, value]) => value.ms === 10000);
    assert.ok(timer, 'the ask has a bounded answer deadline');
    app.timers.delete(timer[0]); timer[1].fn();
    reply = await reply;
    assert.equal(reply.code, 'timeout'); assert.match(reply.error, /did not answer in time/);
    assert.equal((await rpc(app, { type: 'status', tabId: 2 })).recordRequest, undefined);
    reply = rpc(app, { type: 'recordRequest', action: 'start', tabId: 2 });
    await asked(app, 2);
    app.ports[0].disconnect();
    reply = await reply;
    assert.equal(reply.code, 'appUnavailable');
    const status = await rpc(app, { type: 'status', tabId: 2 });
    assert.equal(status.appRecording, 'disconnected'); assert.equal(status.recordRequest, undefined);
    assert.equal((await rpc(app, { type: 'recordRequest', action: 'start', tabId: 2 })).code, 'appUnavailable');
    assert.equal(sent(app.ports[0], 'recordRequest').length, 2);
    assert.equal(app.audio.length, 0);
  } finally { app.close(); }
});
