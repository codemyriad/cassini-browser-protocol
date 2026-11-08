// Actual worker/AppControl with modeled browser script results; no real inputs.
const {test}=require('node:test');const assert=require('node:assert/strict');
const {setup,until}=require('./support/app-control-harness.cjs');
const pair=['call-signals-v1','verified-auto-admission-v1'];
async function fixture(trusted=true){
  const app=await setup(0);let clock=0,reads=0;
  app.pages[0].onDisconnect.emit();
  const port=app.frame(2,1,0,'chrome-A');
  const hello=port.sent.find(message=>message.type==='relayHello');
  port.onMessage.emit({...hello,type:'relayReady',observerDocumentStart:trusted});
  port.onMessage.emit({type:'discovery',sourceCount:1,heard:true,documentGeneration:'hook-A',callGeneration:'0'});
  const raw={version:1,documentGeneration:'hook-A',hookGeneration:'0',revision:2,ageMs:0,
    receivedPeers:1,capturedSendingPeers:1,samePeerCount:1,unboundReceiverCount:0,
    receivedVersion:1,sentVersion:1,ended:false,sessionEpoch:1};
  app.chrome.scripting={async executeScript(request){
    if(request.world==='MAIN'){reads++;return [{frameId:0,documentId:'chrome-A',result:{...raw}}]}
    return [{frameId:0,documentId:'chrome-A'}];
  }};
  app.api.genericProducer.now=()=>clock;
  const control=app.api.appControl,wire=app.ports[0].sent;
  async function publish(){control.publishSignals();await until(()=>!control.signalRun)}
  async function configure(capabilities=pair){control.port.onMessage.emit({type:'configure',capabilities});await until(()=>!control.signalRun);await control.publishing}
  const last=()=>wire.filter(message=>message.type==='callSignals').at(-1);
  return {app,raw,port,control,wire,publish,configure,last,setClock(value){clock=value},get reads(){return reads}};
}
test('worker advertises pair, publishes current namespace mapping only after ACK, and preserves raw RTP',async()=>{
  const f=await fixture();
  try{
    assert.ok(f.wire[0].capabilities.includes('verified-auto-admission-v1'));
    assert.equal('browserDocumentId' in (await f.app.api.meetings()).meetings[0],false);
    assert.equal(f.wire.some(message=>message.type==='callSignals'),false);
    await f.configure();
    const row=f.last().tabs[0],meeting=(await f.app.api.meetings({verified:true})).meetings[0];
    assert.equal(row.callEvidence.state,'active');assert.equal(row.documentGeneration,'chrome-A');
    assert.equal(row.sourceDocumentGeneration,'hook-A');assert.notEqual(row.callEvidence.callGeneration,'0');
    assert.equal(meeting.browserDocumentId,row.documentGeneration);assert.equal(meeting.documentGeneration,row.sourceDocumentGeneration);
    assert.equal(meeting.callGeneration,row.callEvidence.callGeneration);
    assert.equal(meeting.sourceCount,1);assert.equal(meeting.heard,true);
    await f.configure(['call-signals-v1']);assert.equal(f.last().tabs.length,0);
    await f.control.publishing;
    assert.equal('browserDocumentId' in f.wire.filter(message=>message.type==='meetings').at(-1).meetings[0],false);
  }finally{f.app.close()}
});
test('only new bidirectional progress renews unchanged active rows; pong never renews proof',async()=>{
  const f=await fixture();
  try{
    await f.configure();const first=f.last();
    f.setClock(1000);await f.publish();assert.equal(f.last().sequence,first.sequence);
    f.raw.receivedVersion++;f.raw.sentVersion++;f.raw.revision++;await f.publish();
    assert.equal(f.last().tabs[0].callEvidence.state,'active');assert.ok(f.last().sequence>first.sequence);
    const count=f.wire.filter(message=>message.type==='callSignals').length;
    f.control.port.onMessage.emit({type:'ping',seq:9});
    assert.equal(f.wire.at(-1).type,'pong');assert.equal(f.wire.filter(message=>message.type==='callSignals').length,count);
    f.setClock(4000);f.raw.ageMs=3000;await f.publish();
    assert.equal(f.last().tabs[0].callEvidence.state,'unknown');assert.equal(f.last().tabs[0].callEvidence.callGeneration,null);
    assert.equal((await f.app.api.meetings()).meetings[0].heard,true);
    const timer=f.app.timers.get(f.control.signalTimer);assert.ok(timer&&timer.ms<=1000);
  }finally{f.app.close()}
});
test('repaired/old frames and forged discovery facts cannot create verified call evidence',async()=>{
  const f=await fixture(false);
  try{
    f.port.onMessage.emit({type:'discovery',sourceCount:1,heard:true,documentGeneration:'hook-A',callGeneration:'0',
      observerDocumentStart:true,callEvidence:{state:'active'},samePeerCount:1});
    await f.configure();assert.equal(f.last().tabs[0].callEvidence.state,'unknown');assert.equal(f.reads,0);
  }finally{f.app.close()}
});
test('explicit terminal endpoint end retains generation for callEnded; a new observed episode rotates only background identity',async()=>{
  const f=await fixture();
  try{
    await f.configure();const first=f.last().tabs[0];
    f.raw.ended=true;f.raw.samePeerCount=0;f.raw.receivedPeers=0;f.raw.capturedSendingPeers=0;f.raw.ageMs=null;
    f.setClock(3000);await f.publish();const end=f.last().tabs[0];
    assert.equal(end.callEvidence.state,'inactive');assert.equal(end.callEvidence.reason,'callEnded');
    assert.equal(end.callEvidence.callGeneration,first.callEvidence.callGeneration);
    Object.assign(f.raw,{ended:false,sessionEpoch:2,samePeerCount:1,receivedPeers:1,capturedSendingPeers:1,ageMs:0,receivedVersion:2,sentVersion:2});
    f.setClock(4000);await f.publish();const next=f.last().tabs[0];
    assert.equal(next.callEvidence.state,'active');assert.notEqual(next.callEvidence.callGeneration,first.callEvidence.callGeneration);
    assert.equal(next.documentGeneration,first.documentGeneration);assert.equal(next.sourceDocumentGeneration,first.sourceDocumentGeneration);
    assert.equal((await f.app.api.meetings({verified:true})).meetings[0].callGeneration,next.callEvidence.callGeneration);
  }finally{f.app.close()}
});
test('replacement control connection requires a fresh ACK/read and never replays cached active publication',async()=>{
  const f=await fixture();
  try{
    await f.configure();const oldGeneration=f.last().tabs[0].callEvidence.callGeneration;
    const port=await f.app.reconnect();assert.equal(port.sent.some(message=>message.type==='callSignals'),false);
    const before=f.reads;f.raw.ageMs=3000;
    port.onMessage.emit({type:'configure',capabilities:pair});await until(()=>port.sent.some(message=>message.type==='callSignals'));
    const row=port.sent.filter(message=>message.type==='callSignals').at(-1).tabs[0];
    assert.ok(f.reads>before);assert.equal(row.callEvidence.state,'unknown');assert.equal(row.callEvidence.callGeneration,null);
    assert.equal(f.app.api.callInfo(2).generation,oldGeneration);
  }finally{f.app.close()}
});

test('reconfiguration sends an initial unknown snapshot without renewing the same native proof',async()=>{
  const f=await fixture();
  try{
    await f.configure();const before=f.last();
    await f.configure();
    assert.ok(f.last().sequence>before.sequence);assert.equal(f.last().tabs[0].callEvidence.state,'unknown');
    f.setClock(1000);f.raw.receivedVersion++;f.raw.sentVersion++;await f.publish();
    assert.equal(f.last().tabs[0].callEvidence.state,'active');
  }finally{f.app.close()}
});

test('one-way progress cannot renew active proof; both directions must advance',async()=>{
  const f=await fixture();
  try{
    await f.configure();const sequence=f.last().sequence;
    f.setClock(1000);f.raw.receivedVersion++;await f.publish();assert.equal(f.last().sequence,sequence);
    f.setClock(2100);await f.publish();assert.equal(f.last().tabs[0].callEvidence.state,'unknown');
    f.raw.sentVersion++;f.setClock(2200);await f.publish();assert.equal(f.last().tabs[0].callEvidence.state,'active');
  }finally{f.app.close()}
});
