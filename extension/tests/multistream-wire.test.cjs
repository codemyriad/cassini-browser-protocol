const {test}=require('node:test');
const assert=require('node:assert/strict');
const {setup,until}=require('./support/app-control-harness.cjs');
const command=(requestId,action,extra={})=>({type:'command',requestId,action,tabId:2,mode:'tracks',independent:true,...extra});
async function packet(app,value,id){
 const page=app.pages[0];page.onMessage.emit({type:'packet',request:id,packet:value});
 await until(()=>page.sent.some(m=>m.type==='ack'&&m.request===id));
 return page.sent.find(m=>m.type==='ack'&&m.request===id);
}
test('outcome packet types are enabled only by native host negotiation',async()=>{
 for(const enabled of [false,true]){
  const app=await setup(3,{},enabled?['source-outcomes-v1']:[]);
  try {
   await app.command(command('start','start'));
   assert.deepEqual(Array.from(app.audio[0].sent[0].features),['source-outcomes-v1']);
   assert.equal(app.pages[0].sent.find(m=>m.type==='start').sourceOutcomes,enabled);
   if(enabled){assert.equal((await packet(app,{type:'trackEnd',id:'span',reason:'ended',endOffsetMs:1000,droppedFrames:0},1)).error,undefined)}
   else {app.pages[0].onMessage.emit({type:'packet',request:'legacy-source',packet:{type:'sources',discoveredSources:[{sourceTrackId:'ignored',kind:'remote'}]}});assert.equal(app.audio[0].sent.some(p=>p.type==='sources'),false)}
   await app.command(command('stop','stop'));
   const stopped=app.audio[0].sent.find(m=>m.type==='stop');assert.equal(stopped.captureId,app.audio[0].sent[0].captureId);
   assert.equal(Array.isArray(stopped.discoveredSources),enabled);
  } finally{app.close()}
 }
});
test('a per-source native refusal is acknowledged without closing the recording',async()=>{
 const app=await setup(3,{},['source-outcomes-v1']);
 try {
  await app.command(command('start','start'));const port=app.audio[0],post=port.postMessage;
  port.postMessage=function(value){if(value.id==='refused'){this.sent.push(value);queueMicrotask(()=>this.onMessage.emit({type:'error',code:'source',scope:'source',id:value.id,message:'Generated refusal'}))}else post.call(this,value)};
  const refused=await packet(app,{type:'track',id:'refused',sourceTrackId:'missing-voice',kind:'remote',sampleRate:48000,channels:1},1);
  assert.equal(refused.scope,'source');assert.equal(port.closed,false);
  assert.equal((await packet(app,{type:'audio',id:'healthy',sequence:0,offsetMs:0,pcm:'AAA='},2)).error,undefined);
  assert.equal(app.api.controlStatus().sessions.length,1);
  assert.deepEqual(Array.from(app.api.controlStatus().sessions[0].failedSources),['missing-voice']);
  await app.command(command('stop','stop'));
 }finally{app.close()}
});
test('a stale capture stop does not cancel a newer pending start',async()=>{
 const app=await setup();let release;
 try {
  const get=app.chrome.tabs.get;let entered=false;const gate=new Promise(resolve=>release=resolve);
  app.chrome.tabs.get=async id=>{if(id===2){entered=true;await gate}return get(id)};
  const starting=app.api.start('tracks',2,{independent:true});await until(()=>entered);
  assert.equal((await app.command(command('wrong-stop','stop',{captureId:'old-token'}))).ok,false);
  release();await starting;assert.equal(app.audio.length,1);assert.equal(app.audio[0].closed,false);
  const current=app.api.controlStatus().sessions[0].captureId;
  assert.equal((await app.command(command('current-stop','stop',{captureId:current}))).ok,true);
 }finally{release?.();app.close()}
});
test('a metadata lookup hiccup preserves the active row and marks its count unknown',async()=>{
 const app=await setup();
 try {
  await app.command(command('start','start'));let rows=await app.api.meetings();assert.equal(rows.meetings[0].sourceCount,3);
  const get=app.chrome.tabs.get;app.chrome.tabs.get=async id=>{if(id===2)throw Error('generated tab metadata hiccup');return get(id)};
  rows=await app.api.meetings();assert.equal(rows.meetings.length,1);assert.equal(rows.meetings[0].tabId,2);
  assert.equal(rows.meetings[0].sourceCount,3);assert.equal(rows.meetings[0].sourceCountKnown,false);
  app.chrome.tabs.get=get;await app.command(command('stop','stop'));
 }finally{app.close()}
});

test('call address change retires A, publishes a new generation, and rejects late A commands',async()=>{
 const app=await setup(3,{},['source-outcomes-v1']);
 try {
  await app.command(command('start-A','start',{keepOnNavigation:true}));
  const old=app.api.controlStatus().sessions[0],port=app.audio[0];
  const page=app.pages[0],post=page.postMessage;let release;
  page.postMessage=function(message){if(message.type==='stop')release=()=>this.onMessage.emit({type:'stopped'});else post.call(this,message)};
  app.chrome.tabs.onUpdated.emit(2,{url:'https://meet.example/call-B'});
  await until(()=>release);assert.equal(app.api.controlStatus().sessions[0].stopping,true);
  const refused=await packet(app,{type:'audio',id:'old-span',sequence:0,offsetMs:0,pcm:'AAA='},1);
  assert.equal(refused.scope,'source');assert.ok(!port.sent.some(p=>p.type==='audio'));
  const lateSource=await packet(app,{type:'sources',discoveredSources:[{sourceTrackId:'late-A',kind:'remote',failed:true}]},2);
  assert.equal(lateSource.code,'callChanged');assert.deepEqual(Array.from(app.api.controlStatus().sessions[0].failedSources),[]);
  release();await until(()=>port.closed);
  const stop=port.sent.find(p=>p.type==='stop');assert.equal(stop.reason,'callEnded');assert.equal(stop.captureId,old.captureId);
  app.tabs.get(2).url='https://meet.example/call-B';app.pages[0].onMessage.emit({type:'discovery',sourceCount:1,heard:true});
  const row=(await app.api.meetings()).meetings[0];assert.notEqual(row.callGeneration,old.callGeneration);
  assert.equal((await app.command(command('stale-A','start',{callGeneration:old.callGeneration}))).ok,false);
  assert.equal(app.audio.length,1);
 }finally{app.close()}
});

test('live source batches retain 257 never-opened sources and Stop waits for their native ACK',async()=>{
 const app=await setup(3,{},['source-outcomes-v1']);let release;
 try{
  await app.command(command('start','start'));const port=app.audio[0],post=port.postMessage;
  port.postMessage=function(value){if(value.type==='sources'){this.sent.push(value);release=()=>this.onMessage.emit({type:'ack'})}else post.call(this,value)};
  const sources=Array.from({length:257},(_,i)=>({sourceTrackId:`never-opened-${i}`,kind:'remote',label:'Guest',failed:true}));
  const update=packet(app,{type:'sources',discoveredSources:sources},257);
  await until(()=>release);
  assert.equal(port.sent.filter(p=>p.type==='track').length,0);
  assert.equal(app.api.controlStatus().sessions[0].failedSources.length,257);
  const stopping=app.command(command('stop','stop'));
  await until(()=>app.pages[0].sent.some(m=>m.type==='stop'));
  assert.equal(port.sent.some(p=>p.type==='stop'),false,'native Stop cannot overtake unacknowledged source records');
  release();await update;await stopping;
  assert.equal(port.sent.find(p=>p.type==='sources').discoveredSources.length,257);
  assert.deepEqual(Array.from(port.sent.find(p=>p.type==='stop').discoveredSources),[]);
 }finally{release?.();app.close()}
});

test('a legacy full discovery update is streamed without the old 64/256 truncation',async()=>{
 const app=await setup(3,{},['source-outcomes-v1']);
 try{
  await app.command(command('start','start'));
  app.pages[0].onMessage.emit({type:'warning',discoveredSources:Array.from({length:600},(_,i)=>({sourceTrackId:`source-${i}`,kind:'remote',label:'🙂'.repeat(200),failed:true}))});
  await until(()=>app.audio[0].sent.filter(p=>p.type==='sources').flatMap(p=>p.discoveredSources).length===600);
  const packets=app.audio[0].sent.filter(p=>p.type==='sources');
  assert.equal(new Set(packets.flatMap(p=>p.discoveredSources).map(s=>s.sourceTrackId)).size,600);
  assert.ok(packets.length>1,'multibyte source labels require more than one native frame');
  assert.ok(packets.every(p=>Buffer.byteLength(JSON.stringify(p))<=400000));
  await app.command(command('stop','stop'));
 }finally{app.close()}
});

test('whole-tab discovery is durable before offscreen setup and setup failure marks that source',async()=>{
 const app=await setup(3,{},['source-outcomes-v1']);
 try{
  app.chrome.tabCapture.getMediaStreamId=async()=>'granted-stream';
  app.chrome.offscreen.createDocument=async()=>{
   assert.equal(app.audio[0].sent.filter(p=>p.type==='sources').length,1,'the tab source is announced before any offscreen work');
   throw Error('generated offscreen setup failure');
  };
  await assert.rejects(app.api.start('tab',2),/generated offscreen setup failure/);
  const updates=app.audio[0].sent.filter(p=>p.type==='sources').flatMap(p=>p.discoveredSources);
  assert.equal(updates.length,2);assert.equal(updates[0].kind,'tab');assert.equal(updates[0].failed,false);assert.equal(updates[1].failed,true);
  assert.equal(updates[0].sourceTrackId,updates[1].sourceTrackId);
  assert.equal(app.audio[0].sent.filter(p=>p.type==='track').length,0);
 }finally{app.close()}
});

test('source batches validate UTF-8 bounds atomically without closing other audio',async()=>{
 const app=await setup(3,{},['source-outcomes-v1']);
 try{
  await app.command(command('start','start'));
  const invalid=await packet(app,{type:'sources',discoveredSources:[{sourceTrackId:'would-be-accepted',kind:'remote'},{sourceTrackId:'é'.repeat(101),kind:'remote'}]},1);
  assert.equal(invalid.scope,'command');assert.equal(app.audio[0].sent.some(p=>p.type==='sources'),false);
  assert.equal((await packet(app,{type:'sources',discoveredSources:[{sourceTrackId:'é'.repeat(100),kind:'remote',failed:false}]},2)).error,undefined);
  assert.equal((await packet(app,{type:'audio',id:'unrelated',sequence:0,offsetMs:0,pcm:'AAA='},3)).error,undefined);
  assert.equal(app.audio[0].closed,false);await app.command(command('stop','stop'));
 }finally{app.close()}
});
