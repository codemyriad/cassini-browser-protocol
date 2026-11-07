const {test}=require('node:test');const assert=require('node:assert/strict');
const {setup,until}=require('./support/app-control-harness.cjs');
function currentFrame(app){
 const port=app.frame(2,2,0,'browser-current'),post=port.postMessage;
 port.postMessage=function(message){post.call(this,message);if(message.type==='discover')queueMicrotask(()=>this.onMessage.emit({type:'discovery',sourceCount:2,heard:true,documentGeneration:'page-current',callGeneration:'0'}))};
 const frame=[...app.api.frames].find(f=>f.port===port);
 return {port,frame};
}
const proof=()=>[{frameId:0,documentId:'browser-current',result:null}];

test('status-only loading restores the same browser document and requests fresh discovery',async()=>{
 const app=await setup(0);let release;
 try {
  const {port,frame}=currentFrame(app);let request;
  app.chrome.scripting={executeScript:value=>{request=value;return new Promise(resolve=>release=resolve)}};
  app.chrome.tabs.onUpdated.emit(2,{status:'loading'});
  assert.equal(frame.obsolete,true);assert.equal(frame.sourceCount,0);
  assert.equal((await app.api.meetings()).meetings.length,0);
  assert.equal(request.target.tabId,2);assert.deepEqual([...request.target.frameIds],[0]);assert.equal(request.world,'ISOLATED');
  release(proof());await until(()=>!frame.obsolete&&frame.sourceCount===2);
  const inventory=await app.api.meetings();assert.equal(inventory.meetings[0].sourceCount,2);assert.equal(inventory.meetings[0].heard,true);assert.equal(inventory.meetings[0].pageState,'present');
  assert.equal(app.api.browserHealth().tabs[0].state,'ready');assert.ok(port.sent.some(m=>m.type==='discover'));
  assert.equal(app.audio.length,0,'verification is not a recording command');
 } finally {release?.(null);app.close()}
});

for(const [name,result] of [
 ['another document',[{frameId:0,documentId:'browser-old',result:{documentId:'browser-current'}}]],
 ['page result without browser metadata',[{frameId:0,result:{documentId:'browser-current'}}]],
 ['another frame',[{frameId:5,documentId:'browser-current',result:null}]],
 ['missing result',[]]
])test('current-document proof rejects '+name,async()=>{
 const app=await setup(0);
 try {
  const {frame,port}=currentFrame(app);app.chrome.scripting={executeScript:async()=>result};
  app.chrome.tabs.onUpdated.emit(2,{status:'loading'});await until(()=>!frame.documentCheck);
  port.onMessage.emit({type:'discovery',sourceCount:2,heard:true,documentGeneration:'browser-current',callGeneration:'0'});
  assert.equal(frame.obsolete,true);assert.equal(frame.sourceCount,0);assert.equal((await app.api.meetings()).meetings.length,0);
  assert.equal(port.sent.some(m=>m.type==='discover'),false);
 } finally {app.close()}
});

test('a later loading event invalidates an in-flight browser proof',async()=>{
 const app=await setup(0),checks=[];
 try {
  const {frame,port}=currentFrame(app);app.chrome.scripting={executeScript:()=>new Promise(resolve=>checks.push(resolve))};
  app.chrome.tabs.onUpdated.emit(2,{status:'loading'});app.chrome.tabs.onUpdated.emit(2,{status:'loading'});
  assert.equal(checks.length,2);checks[0](proof());
  await new Promise(resolve=>setImmediate(resolve));assert.equal(frame.obsolete,true);assert.equal(port.sent.some(m=>m.type==='discover'),false);
  checks[1]([]);await until(()=>!frame.documentCheck);assert.equal(frame.obsolete,true);
 } finally {for(const resolve of checks)resolve([]);app.close()}
});

for(const edge of ['disconnect','tab closed'])test('browser proof cannot resurrect a '+edge+' frame',async()=>{
 const app=await setup(0);let release;
 try {
  const {frame,port}=currentFrame(app);app.chrome.scripting={executeScript:()=>new Promise(resolve=>release=resolve)};
  app.chrome.tabs.onUpdated.emit(2,{status:'loading'});
  if(edge==='disconnect')port.onDisconnect.emit();else app.chrome.tabs.onRemoved.emit(2);
  release(proof());await until(()=>!frame.documentCheck);
  assert.equal(frame.obsolete,true);assert.equal(port.sent.some(m=>m.type==='discover'),false);
 } finally {release?.([]);app.close()}
});

test('connected repair probes also verify obsolete document identity',async()=>{
 const app=await setup(0);
 try {
  const {frame}=currentFrame(app);app.chrome.scripting={executeScript:async()=>[]};
  app.chrome.tabs.onUpdated.emit(2,{status:'loading'});await until(()=>!frame.documentCheck);assert.equal(frame.obsolete,true);
  app.chrome.tabs.sendMessage=async()=>({connected:true,protocol:1,instanceId:app.api.browserHealth().extensionInstance});
  await app.api.repairTab(2);assert.equal(frame.obsolete,true,'a connected relay is not proof of a current document');
  app.chrome.scripting.executeScript=async()=>proof();await app.api.repairTab(2);await until(()=>frame.sourceCount===2);
  assert.equal(frame.obsolete,false);assert.equal((await app.api.meetings()).meetings[0].heard,true);
 } finally {app.close()}
});

test('a hung browser proof expires without restoring or blindly retrying',async()=>{
 const app=await setup(0),timers=new Map();let serial=0;
 try {
  const {frame,port}=currentFrame(app);let calls=0;
  app.api.relayTimers.later=(fn,ms)=>{const id=++serial;timers.set(id,{fn,ms});return id};app.api.relayTimers.cancel=id=>timers.delete(id);
  app.chrome.scripting={executeScript:()=>{calls++;return new Promise(()=>{})}};
  app.chrome.tabs.onUpdated.emit(2,{status:'loading'});assert.equal(timers.size,1);assert.equal([...timers.values()][0].ms,2500);
  [...timers.values()][0].fn();await until(()=>!frame.documentCheck);
  assert.equal(timers.size,0);assert.equal(calls,1);assert.equal(frame.obsolete,true);assert.equal(port.sent.some(m=>m.type==='discover'),false);
 } finally {app.close()}
});

test('a port without a browser document ID cannot be restored from page evidence',async()=>{
 const app=await setup(1);
 try {
  const frame=[...app.api.frames][0];app.chrome.scripting={executeScript:async()=>{assert.fail('there is no browser document ID to verify')}};
  app.chrome.tabs.onUpdated.emit(2,{status:'loading'});
  app.pages[0].onMessage.emit({type:'discovery',sourceCount:2,heard:true,documentGeneration:'browser-current',callGeneration:'0'});
  assert.equal(frame.obsolete,true);assert.equal((await app.api.meetings()).meetings.length,0);
 } finally {app.close()}
});

test('same-document loading recovers inventory without duplicating an existing capture',async()=>{
 const app=await setup(0);
 try {
  const {frame}=currentFrame(app);app.chrome.scripting={executeScript:async()=>proof()};
  assert.equal((await app.command({type:'command',requestId:'record',action:'start',mode:'tracks',tabId:2,independent:true,keepOnNavigation:true})).ok,true);
  app.chrome.tabs.onUpdated.emit(2,{status:'loading'});await until(()=>!frame.obsolete&&frame.sourceCount===2);
  assert.equal(app.api.controlStatus().sessions[0].recording,true);assert.equal(app.audio.length,1);
  assert.equal(app.audio[0].sent.filter(m=>m.type==='start').length,1);assert.equal(app.audio[0].sent.some(m=>m.type==='stop'),false);
  await app.api.stop();
 } finally {while(app.api.status().recording)await app.api.stop();app.close()}
});
