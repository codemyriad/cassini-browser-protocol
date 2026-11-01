const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function processor(channels) {
  const packets = [];
  const context = vm.createContext({ currentFrame: 96000, AudioWorkletProcessor: class {
    constructor() { this.port = { postMessage: message => packets.push(message) }; }
  }, registerProcessor: (_, type) => { context.type = type; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../pcm-worklet.js'), 'utf8'), context);
  return { node: new context.type({ processorOptions: { channels } }), packets, context };
}

test('worklet batches interleaved PCM, clips samples and retains render timestamps', () => {
  const { node, packets } = processor(2);
  node.process([[new Float32Array(8192).fill(2), new Float32Array(8192).fill(-2)]]);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].frame, 96000);
  const pcm = new Int16Array(packets[0].pcm);
  assert.equal(pcm.length, 16384);
  assert.deepEqual([...pcm.slice(0, 4)], [32767, -32767, 32767, -32767]);
});
test('stop flushes a partial block before acknowledging completion', () => {
  const { node, packets } = processor(1);
  node.process([[new Float32Array(128).fill(0.5)]]);
  assert.equal(packets.length, 0);
  node.port.onmessage({ data: 'stop' });
  assert.equal(packets[0].pcm.byteLength, 256);
  assert.equal(packets[0].frame, 96000);
  assert.equal(packets[1].stopped, true);
  assert.equal(node.process([[]]), false);
});
test('missing and non-finite samples become silence', () => {
  const { node, packets } = processor(2);
  node.process([[new Float32Array(128).fill(NaN)]]);
  node.port.onmessage({ data: 'stop' });
  assert.ok([...new Int16Array(packets[0].pcm)].every(sample => sample === 0));
});

for(const quantum of [128,256,512])test(`empty input preserves the real ${quantum}-frame quantum and has no phantom timestamp gap`,()=>{
 const {node,packets,context}=processor(1);context.currentFrame=0;
 for(let index=0;index<64;index++){
  const input=index<14?[[]]:[[new Float32Array(quantum).fill(.25)]];
  node.process(input,[[new Float32Array(quantum)]]);context.currentFrame+=quantum;
 }
 node.port.onmessage({data:'stop'});
 let frames=0;
 for(const packet of packets.filter(p=>p.pcm)){
  assert.equal(packet.frame,frames,'missing input must not consume fewer samples than the render clock');
  frames+=packet.pcm.byteLength/2;
 }
 assert.equal(frames,64*quantum);
 const samples=packets.filter(p=>p.pcm).flatMap(p=>[...new Int16Array(p.pcm)]);
 assert.ok(samples.slice(0,14*quantum).every(value=>value===0));assert.ok(samples.slice(14*quantum).every(value=>value>0));
});

test('temporarily empty input channels do not lose fourteen render quanta inside the first batch',()=>{
 const {node,packets,context}=processor(1);context.currentFrame=0;
 for(let index=0;index<80;index++){
  const input=index===0?[[]]:index<=14?[[new Float32Array(0)]]:[[new Float32Array(128).fill(.25)]];
  node.process(input,[[new Float32Array(128)]]);context.currentFrame+=128;
 }
 node.port.onmessage({data:'stop'});let frames=0;
 for(const packet of packets.filter(p=>p.pcm)){assert.equal(packet.frame,frames);frames+=packet.pcm.byteLength/2}
 assert.equal(frames,80*128,'an empty channel must not lose 1792 samples while currentFrame advances');
});
