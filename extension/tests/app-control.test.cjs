const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { runCase, setup } = require('./support/app-control-harness.cjs');
const root = path.resolve(__dirname, '../..');
const contract = fs.existsSync(path.join(root, 'conformance/control/vectors.json')) ? root : path.join(root, 'browser-protocol');
const vectors = JSON.parse(fs.readFileSync(path.join(contract, 'conformance/control/vectors.json')));
for (const vector of vectors) test('app control: ' + vector.name, () => runCase(vector));
test('app control: ignores uncorrelatable commands and reconnects with the Chrome 116 alarm', async () => {
  const app = await setup();
  try {
    const before = app.ports[0].sent.length;
    app.ports[0].onMessage.emit({ type: 'command', requestId: {}, action: 'start', tabId: 2, mode: 'tracks' });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(app.audio.length, 0); assert.equal(app.ports[0].sent.length, before);
    app.ports[0].disconnect(); assert.equal(app.alarms.get('cassini-app-control').periodInMinutes, 1);
    app.chrome.alarms.onAlarm.emit({ name: 'cassini-app-control' }); assert.equal(app.ports.length, 2);
  } finally { app.close(); }
});
