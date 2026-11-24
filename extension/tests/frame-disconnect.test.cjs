const {test}=require('node:test');const assert=require('node:assert/strict');
const {setup,until}=require('./support/app-control-harness.cjs');
const bfcache='The page keeping the extension port is moved into back/forward cache, so the message channel is closed.';
function disconnect(app,port,message) {
 let reads=0;
 Object.defineProperty(app.chrome.runtime,'lastError',{configurable:true,get(){reads++;return message===undefined?undefined:{message}}});
 try {port.onDisconnect.emit();return reads;}
 finally {delete app.chrome.runtime.lastError;}
}
for(const message of [bfcache,'The frame unexpectedly disappeared.',undefined]) {
 test('frame disconnect consumes callback lastError and removes idle frame: '+String(message),async()=>{
  const app=await setup(0);
  try {
   const port=app.pages[0],frame=[...app.api.frames].find(f=>f.port===port);let finished=0;frame.finished=()=>finished++;
   assert.equal(disconnect(app,port,message),1,'read the receiving callback error synchronously');
   assert.equal(app.api.frames.has(frame),false);assert.equal(finished,1);
   assert.equal(app.api.browserHealth().state,'idle');assert.equal((await app.api.meetings()).meetings.length,0);
   assert.equal(app.audio.length,0);
  }finally{app.close()}
 });
 test('consuming lastError preserves ordinary capture loss: '+String(message),async()=>{
  const app=await setup(3);
  try {
   assert.equal((await app.command({type:'command',requestId:'start',action:'start',mode:'tracks',tabId:2,independent:true})).ok,true);
   assert.equal(disconnect(app,app.pages[0],message),1);
   await until(()=>app.audio[0].sent.some(p=>p.type==='stop')&&!app.api.status().recording);
   const stops=app.audio[0].sent.filter(p=>p.type==='stop');
   assert.equal(stops.length,1);assert.equal(stops[0].failureReason,'lost');assert.equal(stops[0].cause,'frameClosed');
   assert.equal(app.audio[0].closed,true);assert.equal(app.api.frames.size,0);
   await app.api.repairTab(2,0);assert.equal(app.api.browserHealth().tabs[0].state,'reloadRequired');
  }finally{await app.api.stop();app.close()}
 });
}

test('BFCache-like retained disconnect keeps the same capture and accepts a fresh handshaken relay',async()=>{
 const app=await setup(3);
 try {
  const started=await app.command({type:'command',requestId:'keep',action:'start',mode:'tracks',tabId:2,independent:true,keepOnNavigation:true});
  assert.equal(started.ok,true);const captureId=started.status.captureId;
  app.chrome.tabs.onUpdated.emit(2,{status:'loading'});
  assert.equal(disconnect(app,app.pages[0],bfcache),1);
  assert.equal(app.api.frames.size,0);assert.equal(app.api.status().recording,true);assert.equal(app.api.status().pageState,'navigating');
  assert.equal(app.audio[0].sent.some(p=>p.type==='stop'),false);
  const restored=app.frame(2,3);
  assert.equal(app.api.status().captureId,captureId);assert.equal(app.api.status().pageState,'present');
  assert.equal(app.api.browserHealth().tabs[0].state,'ready');
  assert.equal(restored.sent.filter(p=>p.type==='start').length,1);
  assert.equal(app.audio.length,1);assert.equal(app.audio[0].sent.filter(p=>p.type==='start').length,1);
 }finally{await app.api.stop();app.close()}
});

test('decorative zero-RTP child frame is never attached for capture and its departure never stops a non-retained session',async()=>{
 const app=await setup(3,{},['source-outcomes-v1']);
 const send=async(page,packet,id)=>{page.onMessage.emit({type:'packet',request:id,packet});await until(()=>page.sent.some(m=>m.type==='ack'&&m.request===id));return page.sent.find(m=>m.type==='ack'&&m.request===id)};
 try {
  const child1=app.frame(2,0,4);
  assert.equal((await app.command({type:'command',requestId:'start',action:'start',mode:'tracks',tabId:2,independent:true})).ok,true);
  assert.equal(app.pages[0].sent.some(p=>p.type==='start'),true);
  assert.equal(child1.sent.some(p=>p.type==='start'),false,'zero-RTP child frame must not receive start');
  child1.onMessage.emit({type:'packet',request:99,packet:{type:'track',id:'child-dom-media',kind:'media',sampleRate:48000,channels:1}});
  assert.equal((await send(app.pages[0],{type:'track',id:'main-remote',kind:'remote',sampleRate:48000,channels:1},1)).error,undefined);
  assert.equal((await send(app.pages[0],{type:'audio',id:'main-remote',sequence:0,offsetMs:0,pcm:'AAA='},2)).error,undefined);
  assert.equal(app.audio[0].sent.some(p=>p.id==='child-dom-media'),false,'unrelated child DOM media never reaches the native host');
  assert.equal(disconnect(app,child1,undefined),1);
  const child2=app.frame(2,0,5);
  assert.equal(child2.sent.some(p=>p.type==='start'),false,'late zero-RTP child frame must not receive start');
  assert.equal(disconnect(app,child2,undefined),1);
  assert.equal(app.api.status().recording,true);
  assert.equal(app.audio[0].closed,false);
  assert.equal((await send(app.pages[0],{type:'audio',id:'main-remote',sequence:1,offsetMs:20,pcm:'AAA='},3)).error,undefined);
  assert.equal((await app.command({type:'command',requestId:'stop',action:'stop',tabId:2,independent:true})).ok,true);
  assert.equal(app.audio[0].sent.find(p=>p.type==='stop').failureReason,undefined);
 }finally{await app.api.stop();app.close()}
});

test('an attached child frame that contributed no sources does not end main capture on disconnect, while a contributing child frame does',async()=>{
 const app=await setup(2,{},['source-outcomes-v1']);
 const send=async(page,packet,id)=>{page.onMessage.emit({type:'packet',request:id,packet});await until(()=>page.sent.some(m=>m.type==='ack'&&m.request===id));return page.sent.find(m=>m.type==='ack'&&m.request===id)};
 try {
  const idleChild=app.frame(2,1,4);
  assert.equal((await app.command({type:'command',requestId:'start',action:'start',mode:'tracks',tabId:2,independent:true})).ok,true);
  assert.equal(idleChild.sent.some(p=>p.type==='start'),true);
  assert.equal((await send(app.pages[0],{type:'track',id:'main-voice',kind:'remote',sampleRate:48000,channels:1},1)).error,undefined);
  idleChild.onMessage.emit({type:'discovery',sourceCount:0,heard:false});
  assert.equal(disconnect(app,idleChild,undefined),1);
  assert.equal(app.api.status().stopping,false,'empty departing child must not fail main capture');
  assert.equal(app.api.status().recording,true,'empty departing child must not fail main capture');
  assert.equal(app.audio[0].closed,false);
  const speakingChild=app.frame(2,1,6);
  await until(()=>speakingChild.sent.some(p=>p.type==='start'));
  assert.equal((await send(speakingChild,{type:'track',id:'child-voice',kind:'remote',sampleRate:48000,channels:1},2)).error,undefined);
  assert.equal(disconnect(app,speakingChild,undefined),1);
  await until(()=>app.audio[0].closed&&!app.api.status().recording);
  const stop=app.audio[0].sent.find(p=>p.type==='stop');
  assert.equal(stop.failureReason,'lost');
  assert.equal(stop.cause,'frameClosed');
 }finally{await app.api.stop();app.close()}
});
