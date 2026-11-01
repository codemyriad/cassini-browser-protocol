// D52 production page-hook; generated peers only, no desktop or real devices.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const moduleURL='data:text/javascript;base64,'+Buffer.from('export const capture=options=>globalThis.__cassiniPageCapture(options);').toString('base64');

async function fixture(run) {
 const messages=[],listeners=[],timers=[],captures=[];let now=0,uuid=0,contextError=false,nativeFinished=false;
 class Peer {
  constructor(){this.connectionState='connected';this.iceConnectionState='connected';this.signalingState='stable';this.slots=[];this.senders=[]}
  addEventListener(){}getTransceivers(){return this.slots}getSenders(){return this.senders}close(){this.signalingState='closed'}
 }
 for(const name of ['getStats','createOffer','createAnswer','setLocalDescription','setRemoteDescription','addTrack','addTransceiver'])Peer.prototype[name]=()=>{};
 Peer.prototype.setRemoteDescription=function(){return this.descriptionTask || Promise.resolve()};
 class Stream {constructor(tracks){this.tracks=tracks}getAudioTracks(){return this.tracks}}
 class Context {constructor(){if(contextError)throw Error('generated context attach failure')}sampleRate=48000;state='running';async close(){this.state='closed'}}
 const control=async data=>{for(const fn of listeners)await fn({source:window,data:{channel:'cassini-control',...data}})};
 const window={location:{href:'https://meet.test/call-A'},RTCPeerConnection:Peer,addEventListener:(_n,fn)=>listeners.push(fn),postMessage(message){
  messages.push(message);
  if(message.type==='packet')queueMicrotask(()=>control({type:'ack',token:message.token,request:message.request,...(nativeFinished?{error:'Native capture already saved',scope:'command',code:'state'}:{})}));
 }};
 globalThis.__cassiniPageCapture=async options=>{
  const item={...options,stopped:false};captures.push(item);
  await options.send({type:'track',id:options.id,label:options.label,kind:options.kind,sampleRate:48000,channels:1,sourceTrackId:options.sourceTrackId});
  return {failed:false,async stop(){item.stopped=true}};
 };
 const context=vm.createContext({window,navigator:{},document:{querySelectorAll:()=>[]},MediaStream:Stream,AudioContext:Context,
  crypto:{randomUUID:()=>`id-${++uuid}`},performance:{now:()=>now},setInterval:fn=>(timers.push(fn),timers.length),clearInterval(){},
  setTimeout,clearTimeout,queueMicrotask});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../page-hook.js'),'utf8'),context,{importModuleDynamically:vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
 const peer=new window.RTCPeerConnection();
 function remote(label='Guest',target=peer){
  const slot={currentDirection:'recvonly',packets:0};
  slot.receiver={track:{id:`remote-${peer.slots.length}`,label,kind:'audio',readyState:'live',enabled:true,muted:false},
   getStats:async()=>new Map([['rtp',{id:'rtp',type:'inbound-rtp',kind:'audio',packetsReceived:slot.packets}]])};
  target.slots.push(slot);return slot;
 }
 const tick=async()=>{now+=1000;await timers[0]();};
 const scan=async()=>{assert.ok(timers[1],'capture scan exists');await timers.at(-1)();};
 let activeToken='recording';
 try {await run({peer,window,remote,tick,scan,captures,messages,nativeStopFirst(){nativeFinished=true},breakContext(){contextError=true},async stop(){await control({type:'stop',token:activeToken})},async start(token='recording',options={}){activeToken=token;await control({type:'start',token,origin:0,moduleURL,workletURL:'',...options})}})}
 finally {await control({type:'stop',token:activeToken});delete globalThis.__cassiniPageCapture;}
}

test('remote span waits for a connected peer and a positive packet delta',()=>fixture(async f=>{
 const remote=f.remote();f.peer.connectionState='new';f.peer.iceConnectionState='new';
 await f.tick();await f.start();assert.equal(f.captures.length,0);
 f.peer.connectionState='connected';await f.tick();await f.scan();assert.equal(f.captures.length,0,'first appearance establishes only a baseline');
 remote.packets=1;await f.tick();await f.scan();assert.equal(f.captures.length,1);
 assert.ok(f.captures[0].sourceTrackId);
}));
test('equal labels have different identities; a receiver replacement retains its root identity',()=>fixture(async f=>{
 const a=f.remote(),b=f.remote();await f.tick();a.packets=b.packets=10;await f.tick();await f.start();
 assert.equal(f.captures.length,2);assert.notEqual(f.captures[0].sourceTrackId,f.captures[1].sourceTrackId);
 const first=f.captures[0];a.receiver.track={...a.receiver.track,id:'replacement'};
 await f.scan();assert.equal(first.stopped,true);assert.equal(f.captures.length,2,'replacement requires its own packet evidence');
 a.packets=20;await f.tick();await f.scan();assert.equal(f.captures.length,3);
 assert.equal(f.captures[2].sourceTrackId,first.sourceTrackId);assert.notEqual(f.captures[2].id,first.id);
 assert.equal(f.captures[1].stopped,false,'the other participant continues');
}));
test('sender replace/mute/restore keeps one source key without overlapping spans',()=>fixture(async f=>{
 const sender={track:{id:'mic-a',label:'Microphone',kind:'audio',readyState:'live',enabled:true,muted:false},getParameters:()=>({encodings:[]})};
 f.peer.senders=[sender];await f.start();const first=f.captures[0];assert.ok(first);
 sender.track=null;await f.scan();assert.equal(f.captures.length,1);assert.equal(first.stopped,false);
 sender.track={id:'mic-b',label:'Microphone',kind:'audio',readyState:'live',enabled:true,muted:false};await f.scan();
 assert.equal(first.stopped,true);assert.equal(f.captures.length,2);assert.equal(f.captures[1].sourceTrackId,first.sourceTrackId);
}));

test('an in-page call switch retires A and never opens a B source under A token',()=>fixture(async f=>{
 const a=f.remote();await f.tick();a.packets=10;await f.tick();await f.start('A');const first=f.captures[0];
 f.window.location.href='https://meet.test/call-B';
 const next=new f.window.RTCPeerConnection(),b=f.remote('Guest',next);
 await f.tick();b.packets=10;await f.tick();await f.scan();
 assert.equal(first.stopped,true);assert.equal(f.captures.length,1,'old token cannot admit the new call');
 await f.stop();await f.start('B');assert.equal(f.captures.length,2);
 assert.notEqual(f.captures[1].sourceTrackId,first.sourceTrackId);
 assert.deepEqual(f.messages.filter(m=>m.type==='packet'&&m.packet.type==='track').map(m=>m.token),['A','B']);
 assert.equal(f.peer.signalingState,'stable','old A peer deliberately closes late');
}));


test('a reused peer needs a fresh applied remote description and fresh RTP in the new call',()=>fixture(async f=>{
 const a=f.remote();await f.tick();a.packets=10;await f.tick();await f.start('A');
 const first=f.captures[0];f.window.location.href='https://meet.test/call-B';
 await f.tick();await f.scan();assert.equal(first.stopped,true);
 await f.stop();await f.start('B');a.packets=20;await f.tick();await f.scan();
 assert.equal(f.captures.length,1,'old connected peer stays fenced without new negotiation');
 await f.peer.setRemoteDescription({type:'answer',sdp:'B'});await f.tick();await f.scan();
 assert.equal(f.captures.length,1,'a fresh stats baseline alone is not audio evidence');
 a.packets=30;await f.tick();await f.scan();
 assert.equal(f.captures.length,2,'a reused receiver can record the new call');
 assert.equal(f.captures[1].sourceTrackId,first.sourceTrackId);
 assert.notEqual(f.captures[1].id,first.id);
 assert.deepEqual(f.messages.filter(m=>m.type==='packet'&&m.packet.type==='track').map(m=>m.token),['A','B']);
}));

test('an old remote-description completion cannot rebind an old peer to the new call',()=>fixture(async f=>{
 const a=f.remote();await f.tick();a.packets=10;await f.tick();await f.start('A');
 let release;f.peer.descriptionTask=new Promise(resolve=>release=resolve);
 const pending=f.peer.setRemoteDescription({type:'answer',sdp:'old-A'});
 f.window.location.href='https://meet.test/call-B';await f.tick();release();await pending;
 await f.scan();await f.stop();await f.start('B');a.packets=20;await f.tick();await f.scan();
 assert.equal(f.captures.length,1,'delayed old negotiation remains fenced');
 f.peer.descriptionTask=Promise.reject(new Error('new negotiation failed'));
 await assert.rejects(f.peer.setRemoteDescription({type:'answer',sdp:'failed-B'}));
 a.packets=30;await f.tick();await f.scan();
 assert.equal(f.captures.length,1,'failed new negotiation cannot rebind the peer either');
}));

test('a late old peer sender is not recorded by the new call',()=>fixture(async f=>{
 f.peer.senders=[{track:{id:'old-mic',kind:'audio',readyState:'live',enabled:true,muted:false},getParameters:()=>({encodings:[]})}];
 await f.start('A');assert.equal(f.captures.length,1);
 f.window.location.href='https://meet.test/call-B';await f.tick();await f.scan();
 await f.stop();await f.start('B');
 assert.equal(f.captures.length,1,'old call sender cannot leak into B');
}));

test('discovery is acknowledged before an AudioContext attach failure and the failure is sent before Stop',()=>fixture(async f=>{
 const remote=f.remote();await f.tick();remote.packets=10;await f.tick();f.breakContext();
 await f.start('failed-source',{sourceOutcomes:true});await f.stop();
 const updates=f.messages.filter(m=>m.type==='packet'&&m.packet.type==='sources');
 assert.equal(updates.length,2);assert.equal(updates[0].packet.discoveredSources[0].failed,false);
 assert.equal(updates[1].packet.discoveredSources[0].failed,true);
 assert.equal(updates[0].packet.discoveredSources[0].sourceTrackId,updates[1].packet.discoveredSources[0].sourceTrackId);
 assert.equal(f.captures.length,0,'no WAV/track was opened');
 assert.ok(f.messages.indexOf(updates[1])<f.messages.findIndex(m=>m.type==='stopped'));
 assert.equal(f.messages.find(m=>m.type==='stopped').discoveredSources,undefined,'Stop is not the only discovery carrier');
}));

test('257 discovered sources are announced without a diagnostic cap; only 64 WAV spans are opened',()=>fixture(async f=>{
 const slots=Array.from({length:257},()=>f.remote());await f.tick();for(const slot of slots)slot.packets=10;
 await f.tick();await f.start('many-sources',{sourceOutcomes:true});await f.stop();
 const sources=new Map();for(const message of f.messages.filter(m=>m.type==='packet'&&m.packet.type==='sources'))
  for(const source of message.packet.discoveredSources)sources.set(source.sourceTrackId,source);
 assert.equal(sources.size,257);assert.equal(f.captures.length,64);
 assert.equal([...sources.values()].filter(s=>s.failed).length,193);
 assert.ok(f.messages.filter(m=>m.type==='packet'&&m.packet.type==='sources').every(m=>m.packet.discoveredSources.length===1));
}));

test('native-first Stop refuses a late discovery without creating a retry or false source failure',()=>fixture(async f=>{
 const remote=f.remote();await f.tick();remote.packets=10;await f.tick();f.nativeStopFirst();
 await f.start('native-finished',{sourceOutcomes:true});await f.stop();
 const sources=f.messages.filter(m=>m.type==='packet'&&m.packet.type==='sources');
 assert.equal(sources.length,1);assert.equal(sources[0].packet.discoveredSources[0].failed,false);
 assert.equal(f.captures.length,0);
 assert.deepEqual(f.messages.filter(m=>m.type==='warning'||m.type==='error'),[]);
}));
