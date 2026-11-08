// Native media is modeled here; the CI study runs the packaged hook on real RTC.
const {test}=require('node:test');const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {until}=require('./support/app-control-harness.cjs');
function fixture(){
  let now=0;const origin=1000000,timers=[],listeners=[],messages=[];
  class Track {constructor(){this.kind='audio';this.readyState='live';this.enabled=true;this.muted=false}clone(){return new Track()}}
  class Sender {
    constructor(track){this.track=track;this.packets=0;this.age=0;this.pending=null}
    async getStats(){if(this.pending)await this.pending;return new Map([['out',{id:'out',type:'outbound-rtp',kind:'audio',packetsSent:this.packets,timestamp:origin+now-this.age}]])}
  }
  class Peer {
    constructor(){this.connectionState='connected';this.iceConnectionState='connected';this.signalingState='stable';this.slots=[]}
    addEventListener(){}getTransceivers(){return this.slots}getSenders(){return this.slots.map(slot=>slot.sender)}getReceivers(){return this.slots.map(slot=>slot.receiver)}
    close(){this.signalingState='closed';this.connectionState='closed'}
  }
  for(const name of ['getStats','createOffer','createAnswer','setLocalDescription','setRemoteDescription','addTrack','addTransceiver'])Peer.prototype[name]=()=>{};
  const window={RTCPeerConnection:Peer,location:{href:'https://neutral.invalid/call'},postMessage:packet=>messages.push(packet),addEventListener:(name,fn)=>listeners.push(fn)};
  const context=vm.createContext({window,RTCRtpSender:Sender,MediaStreamTrack:Track,
    navigator:{mediaDevices:{async getUserMedia(){const track=new Track();return {getAudioTracks:()=>[track]}}}},
    crypto:{randomUUID:()=> 'hook-document'},performance:{timeOrigin:origin,now:()=>now},
    setInterval:fn=>timers.push(fn),setTimeout,clearTimeout});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../page-hook.js'),'utf8'),context);
  async function peer(kind='captured'){
    let track=kind==='synthetic'?new Track():(await context.navigator.mediaDevices.getUserMedia()).getAudioTracks()[0];
    if(kind==='clone')track=track.clone();
    const pc=new window.RTCPeerConnection(),sender=new Sender(track);
    const receiver={track:new Track(),packets:0,age:0,async getStats(){return new Map([['in',{id:'in',type:'inbound-rtp',kind:'audio',packetsReceived:this.packets,timestamp:origin+now-this.age}]])}};
    pc.slots.push({sender,receiver,currentDirection:'sendrecv'});
    return {pc,sender,receiver,track};
  }
  const read=()=>context.__cassiniCallEvidenceV1.read();
  const advance=ms=>{now+=ms};
  async function tick(peers){advance(1000);for(const {sender,receiver} of peers){sender.packets+=20;receiver.packets+=20}await timers[0]()}
  return {context,window,listeners,messages,peer,read,advance,tick};
}
test('real capture provenance and proven clones require two fresh progress samples; preview and synthetic senders do not qualify',async()=>{
  for(const kind of ['captured','clone','synthetic']){
    const f=fixture(),peer=await f.peer(kind);
    await f.tick([peer]);assert.equal(f.read().samePeerCount,0);
    await f.tick([peer]);assert.equal(f.read().samePeerCount,kind==='synthetic'?0:1);
    peer.pc.slots[0].currentDirection='recvonly';assert.equal(f.read().samePeerCount,0);
  }
});
test('expired, disabled, replaced or ended captured tracks withdraw proof immediately without falsifying source observation',async()=>{
  for(const mutate of [f=>f.advance(2501),(_f,p)=>{p.track.enabled=false},(_f,p)=>{p.track.readyState='ended'},
    (_f,p)=>{p.sender.track=p.track.clone()},(_f,p)=>p.pc.close()]){
    const f=fixture(),peer=await f.peer();await f.tick([peer]);await f.tick([peer]);
    assert.equal(f.read().samePeerCount,1);mutate(f,peer);assert.equal(f.read().samePeerCount,0);
  }
});
test('stale stats timestamps never qualify even as counters increase and legacy source/heard remain truthful',async()=>{
  for(const stale of ['sender','receiver']){
    const f=fixture(),peer=await f.peer();peer[stale].age=4000;
    await f.tick([peer]);await f.tick([peer]);await f.tick([peer]);
    assert.equal(f.read().samePeerCount,0);
    const discovery=f.messages.filter(packet=>packet.type==='discovery').at(-1);
    assert.equal(discovery.sourceCount,1);assert.equal(discovery.heard,true);
  }
});
test('split PCs, forged page messages and mutable returned snapshots cannot supply a same-PC proof',async()=>{
  const f=fixture(),sending=await f.peer(),receiving=await f.peer('synthetic');
  sending.pc.slots[0].currentDirection='sendonly';receiving.pc.slots[0].currentDirection='recvonly';
  await f.tick([sending,receiving]);await f.tick([sending,receiving]);
  for(const listener of f.listeners)listener({source:f.window,data:{channel:'cassini-page',type:'discovery',samePeerCount:1,callEvidence:{state:'active'}}});
  const copy=f.read();copy.samePeerCount=1;
  assert.equal(f.read().samePeerCount,0);
  const descriptor=Object.getOwnPropertyDescriptor(f.context,'__cassiniCallEvidenceV1');
  assert.equal(descriptor.writable,false);assert.equal(descriptor.configurable,false);
});
test('a sender disabled while native stats are pending cannot complete positive proof',async()=>{
  const f=fixture(),peer=await f.peer();await f.tick([peer]);
  let release,entered=false;
  peer.sender.pending=new Promise(resolve=>release=resolve);
  const original=peer.sender.getStats; // The hook uses the captured native prototype method.
  const descriptor=Object.getOwnPropertyDescriptor(peer.sender,'pending');
  Object.defineProperty(peer.sender,'pending',{get(){entered=true;return descriptor.value}});
  const sampling=f.tick([peer]);await until(()=>entered);peer.track.enabled=false;release();await sampling;
  assert.equal(f.read().samePeerCount,0);assert.equal(typeof original,'function');
});
