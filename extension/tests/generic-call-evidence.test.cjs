// Model browser-owned executeScript results; real media is tested separately.
const {test}=require('node:test');const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {until}=require('./support/app-control-harness.cjs');
const context=vm.createContext({URL,TextEncoder,setTimeout,clearTimeout});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../call-signals.js'),'utf8').replace(/^export /gm,'')+'\nglobalThis.Generic=GenericCallEvidenceProducer;',context);
const Generic=context.Generic;
function fixture(){
  const frame={tabId:2,frameId:0,browserUrl:'https://neutral.invalid/call',browserDocumentId:'chrome-A',
    documentGeneration:'hook-A',callGeneration:'hook-session-A',obsoleteEpoch:0,sourceCount:1,heard:true};
  const sample={version:1,documentGeneration:'hook-A',hookGeneration:'hook-session-A',revision:2,ageMs:10,
    receivedPeers:1,capturedSendingPeers:1,samePeerCount:1,unboundReceiverCount:0};
  let live=true,identity='background-A',reads=0;
  const producer=new Generic({identity:()=> 'profile-A',tabs:{async query(){return [{id:2,url:frame.browserUrl}]}},
    frames:()=>[frame],current:value=>value===frame&&live,callIdentity:()=>identity,
    async executeScript(request){reads++;assert.equal(request.world,'MAIN');assert.deepEqual([...request.target.documentIds],['chrome-A']);
      return [{frameId:0,documentId:'chrome-A',result:{...sample}}]}});
  return {frame,sample,producer,get reads(){return reads},retire(){live=false},rotate(){identity='background-B'}};
}
test('only acknowledged generic snapshots expose unequal mapped IDs and the background-owned generation',async()=>{
  const f=fixture();assert.equal((await f.producer.snapshot()).tabs.length,0);assert.equal(f.reads,0);
  const row=(await f.producer.snapshot({verified:true})).tabs[0];
  assert.equal(row.documentGeneration,'chrome-A');assert.equal(row.sourceDocumentGeneration,'hook-A');
  assert.equal(row.callEvidence.callGeneration,'background-A');assert.equal(row.callEvidence.state,'active');
  assert.equal(row.remoteAudio,'separated');assert.notEqual(row.documentGeneration,row.sourceDocumentGeneration);
});
test('passive, split-PC, stale and malformed observations remain unknown while real source facts are untouched',async()=>{
  for(const mutation of [s=>{s.samePeerCount=0;s.capturedSendingPeers=0;s.unboundReceiverCount=1},
    s=>{s.samePeerCount=0;s.receivedPeers=2;s.unboundReceiverCount=2},s=>{s.ageMs=2501},
    s=>{s.documentGeneration='chrome-A'},s=>{s.hookGeneration='retired-hook-session'},
    s=>{s.samePeerCount=2},s=>{s.revision=0},s=>{s.ageMs=NaN}]){
    const f=fixture();mutation(f.sample);
    const row=(await f.producer.snapshot({verified:true})).tabs[0];
    assert.equal(row.callEvidence.state,'unknown');assert.equal(row.callEvidence.callGeneration,null);
    assert.equal(f.frame.sourceCount,1);assert.equal(f.frame.heard,true);
    assert.equal(row.remoteAudio,'separated');
  }
});
test('an unbound additional receiver prevents claiming a scoped separated capture route',async()=>{
  const f=fixture();f.sample.unboundReceiverCount=1;f.sample.receivedPeers=2;
  const row=(await f.producer.snapshot({verified:true})).tabs[0];
  assert.equal(row.callEvidence.state,'active');assert.equal(row.remoteAudio,'unknown');
});
test('fenced port, Chrome/hook identity and background-generation changes cannot complete an old read',async()=>{
  for(const mutate of [f=>f.retire(),f=>{f.frame.browserDocumentId='chrome-B'},f=>{f.frame.documentGeneration='hook-B'},
    f=>{f.frame.callGeneration='hook-session-B'},f=>{f.frame.obsoleteEpoch++},f=>f.rotate()]){
    const f=fixture();let release;
    f.producer.executeScript=()=>new Promise(resolve=>release=resolve);
    const pending=f.producer.snapshot({verified:true});
    await until(()=>release);
    mutate(f);release([{frameId:0,documentId:'chrome-A',result:f.sample}]);
    assert.equal((await pending).tabs.length,0);
  }
});
test('a hung browser read withdraws positive evidence at a bounded deadline',async()=>{
  const f=fixture();let expire;
  f.producer.executeScript=()=>new Promise(()=>{});
  f.producer.timers={later(fn){expire=fn;return 1},cancel(){}};
  const pending=f.producer.snapshot({verified:true});
  // The query completes first; wait on execution of the read, not elapsed time.
  let entered=false;f.producer.executeScript=()=>{entered=true;return new Promise(()=>{})};
  await until(()=>entered);
  expire();const row=(await pending).tabs[0];
  assert.equal(row.callEvidence.state,'unknown');assert.equal(row.callEvidence.callGeneration,null);
});

test('browser round-trip time consumes proof freshness instead of refreshing old media',async()=>{
  const f=fixture();let clock=0;f.producer.now=()=>clock;
  f.sample.ageMs=2000;
  f.producer.executeScript=async()=>{clock=600;return [{frameId:0,documentId:'chrome-A',result:f.sample}]};
  const row=(await f.producer.snapshot({verified:true})).tabs[0];
  assert.equal(row.callEvidence.state,'unknown');assert.equal(row.callEvidence.callGeneration,null);
});
