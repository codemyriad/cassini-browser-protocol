import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {
  installRtcTopologyProbe,
  summarizeRtcCohortComparison,
  validatePlatformTopologyFixture,
  parseProbeCliArgs
} from './rtc-topology-probe.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Generated descriptors only. Raw values stay in these fixture realms; reports
// contain the same opaque integer references as the real two-room study.
function realm(room) {
  const context=vm.createContext({room});
  vm.runInContext(`
    window=globalThis;
    class Description { constructor(value){this.value=value} get sdp(){return this.value} }
    RTCSessionDescription=Description;
    class Peer {
      getSenders(){return []} getReceivers(){return []} async getStats(){return new Map()}
      get localDescription(){return this.local} get remoteDescription(){return this.remote}
    }
    RTCPeerConnection=Peer;
    MediaStreamTrack=class {clone(){return new MediaStreamTrack()}};
    navigator={mediaDevices:{async getUserMedia(){return {getAudioTracks(){return []}}}}};
    (${installRtcTopologyProbe.toString()})();
    const description=new Description('v=0\\r\\no=- '+room+' 1 IN IP4 127.0.0.1\\r\\ns=-\\r\\na=fingerprint:sha-256 generated-shared-server\\r\\na=ssrc:1 cname:'+room+'-cname\\r\\na=msid:'+room+'-stream track\\r\\n');
    for(let i=0;i<2;i++){const pc=new RTCPeerConnection();pc.local=description;pc.remote=description}
  `,context);
  return context;
}

test('one private table distinguishes same-backend room-specific fields across realms',()=>{
  const first=realm('generated-room-a'),second=realm('generated-room-b'),groups=new Map();
  const factsA=first.cassiniRtcCohortFacts(groups),factsB=second.cassiniRtcCohortFacts(groups);
  const report=summarizeRtcCohortComparison(factsA,factsB);
  assert.equal(report.notAdmissionRule,true);
  assert.deepEqual(report.sharedRemoteGroups.fingerprint,[0],'the backend fingerprint is deliberately shared');
  assert.deepEqual(report.sharedRemoteGroups.originSession,[]);
  assert.deepEqual(report.sharedRemoteGroups.rtcpCname,[]);
  assert.deepEqual(report.sharedRemoteGroups.streamId,[]);
  assert.deepEqual(report.sharedRemoteGroups.sessionName,[],'placeholder session names never identify a room');
  assert.equal(factsA.peers[0].remote.rtcpCname[0],factsA.peers[1].remote.rtcpCname[0],'within-room equality is preserved');
  assert.notEqual(factsA.peers[0].remote.rtcpCname[0],factsB.peers[0].remote.rtcpCname[0]);
  assert.doesNotMatch(JSON.stringify(report),/generated-|sha-256|127\.0\.0\.1|v=0/,'raw descriptors never enter the numeric report');
});

test('common backend placeholders are reported as cross-room ambiguity, never admission',()=>{
  const first=realm('generated-common-placeholder'),second=realm('generated-common-placeholder'),groups=new Map();
  const report=summarizeRtcCohortComparison(first.cassiniRtcCohortFacts(groups),second.cassiniRtcCohortFacts(groups));
  assert.equal(report.notAdmissionRule,true);
  for(const field of ['fingerprint','rtcpCname','streamId'])assert.deepEqual(report.sharedRemoteGroups[field],[0]);
  assert.equal('callEvidence' in report,false);
});

test('platform topology validator accepts checked-in Teams fixture and rejects names, SDP, IPs, URLs and audio',async()=>{
  const teams=JSON.parse(await readFile(path.join(root,'tests/fixtures/platforms/ms-teams-2026-11-12.json'),'utf8'));
  assert.equal(validatePlatformTopologyFixture(teams),teams);

  const clone=()=>structuredClone(teams);

  for(const [reason,mutate] of [
    ['participant name in receiver label',f=>{f.peers[0].transceivers[0].receiver.label='Chris';}],
    ['hardware owner name in sender label',f=>{f.peers[0].transceivers[0].sender.label="Silvio's AirPods Pro";}],
    ['SDP fingerprint leak',f=>{f.platform='a=fingerprint:sha-256-secret';}],
    ['ICE password leak',f=>{f.platform='a=ice-pwd:supersecret';}],
    ['IPv4 literal leak',f=>{f.platform='198.51.100.12';}],
    ['meeting URL leak',f=>{f.platform='https://teams.microsoft.com/l/meetup-join';}],
    ['UUID leak',f=>{f.platform='7638acbd-b464-4121-aa7e-b0c552d4d5ec';}],
    ['email leak',f=>{f.platform='user@contoso.onmicrosoft.com';}],
    ['data URI audio payload',f=>{f.platform='data:audio/wav;base64,UklGRg==';}],
    ['extra raw SDP field',f=>{f.sdp='v=0';}],
    ['extra audio bytes field',f=>{f.peers[0].audio='UklGRg==';}],
    ['dangling graph reference',f=>{f.peers[0].transceivers[0].sender.webAudioGraphId='graph-4';}],
    ['dangling edge node reference',f=>{f.webAudioGraphs[0].edges.push({from:'n0',to:'n99',kind:'audio'});}],
    ['inconsistent CSRC presence flag',f=>{f.peers[0].transceivers[0].receiver.csrc={present:true,distinctCount:0};}],
    ['single mixing with multiple speakersOnTrack',f=>{f.peers[0].transceivers[0].receiver.mixing='single';f.peers[0].transceivers[0].receiver.speakersOnTrack=2;}],
    ['unrecorded AudioWorklet flag',f=>{f.webAudioGraphs[0].nodes[2].type='AudioWorkletNode';}]
  ]){
    const bad=clone();
    mutate(bad);
    assert.throws(()=>validatePlatformTopologyFixture(bad),reason);
  }
});

test('probe dumps sanitized WebAudio lineage, AudioParam non-propagation, CSRC timelines and strips PII labels',async()=>{
  const context=vm.createContext({});
  vm.runInContext(`
    window=globalThis;
    (() => {
      class AudioParam {}
      class AudioNode {
        constructor(ctx,inputs=1,outputs=1){this.context=ctx;this.numberOfInputs=inputs;this.numberOfOutputs=outputs}
        connect(dest){return dest}
        disconnect(){}
      }
      class MediaStreamTrack {
        constructor(kind,label,id){this.kind=kind;this.label=label;this.id=id;this.readyState='live';this.enabled=true;this.muted=false}
        clone(){return new MediaStreamTrack(this.kind,this.label,this.id+'-clone')}
      }
      class MediaStream {
        constructor(tracks=[]){this._tracks=tracks}
        getAudioTracks(){return this._tracks.filter(t=>t.kind==='audio')}
        getVideoTracks(){return this._tracks.filter(t=>t.kind==='video')}
        getTracks(){return [...this._tracks]}
        clone(){return new MediaStream(this._tracks.map(t=>new MediaStreamTrack(t.kind,t.label,t.id+'-sc')))}
      }
      class MediaStreamAudioSourceNode extends AudioNode {
        constructor(ctx,opts){super(ctx,0,1);this.mediaStream=opts.mediaStream}
      }
      class MediaElementAudioSourceNode extends AudioNode {
        constructor(ctx){super(ctx,0,1)}
      }
      class GainNode extends AudioNode {
        constructor(ctx){super(ctx,1,1);this.gain=new AudioParam()}
      }
      class OscillatorNode extends AudioNode {
        constructor(ctx){super(ctx,0,1);this.frequency=new AudioParam()}
        start(){}
      }
      class AudioWorkletNode extends AudioNode {
        constructor(ctx,name){super(ctx,1,1);this.customName=name;this.parameters=new Map([['secretGain',new AudioParam()]])}
      }
      class MediaStreamAudioDestinationNode extends AudioNode {
        constructor(ctx){super(ctx,1,0);this.stream=new MediaStream([new MediaStreamTrack('audio','MediaStreamAudioDestinationNode','dest-id')])}
      }
      class BaseAudioContext {
        constructor(){this.state='running'}
        createGain(){return new globalThis.GainNode(this)}
        createOscillator(){return new globalThis.OscillatorNode(this)}
      }
      class AudioContext extends BaseAudioContext {
        createMediaStreamSource(stream){return new globalThis.MediaStreamAudioSourceNode(this,{mediaStream:stream})}
        createMediaElementSource(){return new globalThis.MediaElementAudioSourceNode(this)}
        createMediaStreamDestination(){return new globalThis.MediaStreamAudioDestinationNode(this)}
      }
      Object.assign(globalThis,{
        AudioParam,AudioNode,MediaStreamTrack,MediaStream,
        MediaStreamAudioSourceNode,MediaElementAudioSourceNode,GainNode,OscillatorNode,
        AudioWorkletNode,MediaStreamAudioDestinationNode,BaseAudioContext,AudioContext
      });
    })();
    globalThis.WebAssembly={async instantiate(){return {}}};
    let tick=0;
    let csrcBatch=[];
    globalThis.setCsrcBatch=value=>{csrcBatch=value};
    globalThis.RTCRtpReceiver=class RTCRtpReceiver {
      constructor(track){this.track=track}
      getContributingSources(){return csrcBatch}
      getSynchronizationSources(){return [{source:9001,timestamp:100+tick*100,audioLevel:0.5}]}
      async getStats(){return new Map([['in',{type:'inbound-rtp',kind:'audio',packetsReceived:10+tick*15}]])}
    };
    globalThis.RTCPeerConnection=class RTCPeerConnection {
      constructor(){this.connectionState='connected';this.signalingState='stable';this._slots=[]}
      createDataChannel(label){return {label}}
      addSlot(slot){this._slots.push(slot)}
      getTransceivers(){return this._slots}
      getSenders(){return this._slots.map(s=>s.sender).filter(Boolean)}
      getReceivers(){return this._slots.map(s=>s.receiver).filter(Boolean)}
      async getStats(){
        tick++;
        return new Map([
          ['out',{type:'outbound-rtp',kind:'audio',packetsSent:5+tick*10}],
          ['in',{type:'inbound-rtp',kind:'audio',packetsReceived:10+tick*15}]
        ]);
      }
    };
    navigator={mediaDevices:{
      async getUserMedia(){
        return new MediaStream([new MediaStreamTrack('audio',"Silvio's AirPods Pro",'hw-secret-uuid')]);
      }
    }};
    (${installRtcTopologyProbe.toString()})();
  `,context);

  const dumped=JSON.parse(JSON.stringify(await vm.runInContext(`(async()=>{
    await WebAssembly.instantiate(new Uint8Array());
    const mic=await navigator.mediaDevices.getUserMedia({audio:true});
    // Graph 0: mic -> Gain -> custom-named AudioWorkletNode -> MediaStreamDestination
    const ctx0=new AudioContext();
    const src0=ctx0.createMediaStreamSource(mic);
    const gain0=ctx0.createGain();
    const worklet0=new AudioWorkletNode(ctx0,'teams-private-tenant-denoise');
    const dst0=ctx0.createMediaStreamDestination();
    src0.connect(gain0);gain0.connect(worklet0);worklet0.connect(dst0);

    // Graph 1: mic connected ONLY to AudioParam (gain.gain), while MediaElement drives audio
    const ctx1=new AudioContext();
    const src1=ctx1.createMediaStreamSource(mic);
    const elem1=ctx1.createMediaElementSource();
    const gain1=ctx1.createGain();
    const dst1=ctx1.createMediaStreamDestination();
    src1.connect(gain1.gain);
    elem1.connect(gain1);gain1.connect(dst1);

    const pc=new RTCPeerConnection();
    pc.createDataChannel('secret-roster-channel-alice@contoso.com');
    const makeSender=track=>({track,async getStats(){return new Map([['s',{type:'outbound-rtp',packetsSent:tick*12+1}]])}});
    const namedRemote=new MediaStreamTrack('audio','Chris Secret Name','remote-custom-id');
    const defaultRemote=new MediaStreamTrack('audio','f16986e2-0745-443c-a24e-dd3bfc9edf95','f16986e2-0745-443c-a24e-dd3bfc9edf95');
    const rxMixed=new RTCRtpReceiver(defaultRemote);
    const rxNamed=new RTCRtpReceiver(namedRemote);

    pc.addSlot({
      direction:'sendrecv',currentDirection:'sendrecv',
      sender:makeSender(dst0.stream.getAudioTracks()[0]),
      receiver:rxMixed
    });
    pc.addSlot({
      direction:'sendrecv',currentDirection:'sendrecv',
      sender:makeSender(dst1.stream.getAudioTracks()[0]),
      receiver:rxNamed
    });
    pc.addSlot({
      direction:'sendonly',currentDirection:'sendonly',
      sender:makeSender(mic.clone().getAudioTracks()[0]),
      receiver:null
    });

    setCsrcBatch([{source:40001,timestamp:100,audioLevel:0.4},{source:40002,timestamp:120,audioLevel:0.6}]);
    await cassiniSampleRtcTopology();
    setCsrcBatch([{source:40001,timestamp:350,audioLevel:0.5},{source:40002,timestamp:120,audioLevel:0.6}]);
    return cassiniRtcPlatformFixture({platform:'ms-teams',capturedOn:'2026-11-12',provenance:'synthetic-probe'});
  })()`,context)));

  validatePlatformTopologyFixture(dumped);
  const serialized=JSON.stringify(dumped);
  assert.doesNotMatch(serialized,/Silvio|AirPods|Chris|contoso|denoise|40001|40002|9001|f16986e2/);
  assert.deepEqual(dumped.runtime,{usesWebAudio:true,usesAudioWorklet:true,usesWasm:true});
  assert.equal(dumped.webAudioGraphs[0].outputTrackOrigin,'microphone');
  assert.equal(dumped.webAudioGraphs[1].outputTrackOrigin,'media-element','AudioParam modulation must never grant microphone lineage');
  assert.ok(dumped.webAudioGraphs[1].edges.some(e=>e.kind==='param'));

  const [slot0,slot1,slot2]=dumped.peers[0].transceivers;
  assert.equal(dumped.peers[0].dataChannelCount,1);
  assert.equal(slot0.sender.lineage,'webaudio-microphone');
  assert.equal(slot0.sender.label,'MediaStreamAudioDestinationNode');
  assert.equal(slot0.sender.packetsProgressing,true);
  assert.equal(slot0.receiver.label,'remote audio','UUID receiver track.label===track.id maps to generic remote audio');
  assert.equal(slot0.receiver.mixing,'mixed');
  assert.equal(slot0.receiver.speakersOnTrack,2);
  assert.deepEqual(slot0.receiver.speakersOverTime,[2,1]);
  assert.deepEqual(slot0.receiver.csrc,{present:true,distinctCount:2});

  assert.equal(slot1.sender.lineage,'webaudio-media-element');
  assert.equal(slot1.receiver.label,'opaque-remote-audio','custom remote msid/name is stripped to opaque-remote-audio');

  assert.equal(slot2.sender.lineage,'microphone-clone');
  assert.equal(slot2.sender.label,'microphone','hardware device label is stripped to generic microphone');
  assert.equal(slot2.sender.cloned,true);
});

test('probe CLI parser enforces slug, ISO date, and loopback-only CDP endpoints',()=>{
  const parsed=parseProbeCliArgs(['--platform','ms-teams','--date','2026-11-12','--cdp','http://127.0.0.1:9222']);
  assert.equal(parsed.platform,'ms-teams');
  assert.equal(parsed.out,path.join('tests','fixtures','platforms','ms-teams-2026-11-12.json'));
  assert.throws(()=>parseProbeCliArgs(['--platform','ms-teams','--cdp','http://198.51.100.2:9222']),/loopback/);
  assert.throws(()=>parseProbeCliArgs(['--platform','ms-teams','--launch','file:///etc/passwd']),/http\(s\)/);
  assert.throws(()=>parseProbeCliArgs(['--platform','ms-teams','--launch','https://example.test','--receiver-mixing','bogus']),/receiver-mixing/);
  assert.throws(()=>parseProbeCliArgs(['--platform','MS Teams','--launch','https://example.test']),/platform/);
  assert.throws(()=>parseProbeCliArgs(['--platform','ms-teams']),/exactly one/);
});

test('WebAudio lineage walk scales linearly by counted steps (2N vs N) and validator bounds nesting depth',async()=>{
  async function measureSteps(chainLength){
    const context=vm.createContext({chainLength});
    return vm.runInContext(`(async()=>{
      window=globalThis;
      (() => {
        class AudioParam {}
        class AudioNode { constructor(ctx){this.context=ctx} connect(d){return d} disconnect(){} }
        class MediaStreamTrack { constructor(kind,label,id){this.kind=kind;this.label=label;this.id=id;this.readyState='live';this.enabled=true;this.muted=false} }
        class MediaStream { constructor(t=[]){this._t=t} getAudioTracks(){return this._t} getVideoTracks(){return []} }
        class MediaStreamAudioSourceNode extends AudioNode { constructor(ctx,o){super(ctx);this.mediaStream=o.mediaStream} }
        class GainNode extends AudioNode { constructor(ctx){super(ctx);this.gain=new AudioParam()} }
        class MediaStreamAudioDestinationNode extends AudioNode { constructor(ctx){super(ctx);this.stream=new MediaStream([new MediaStreamTrack('audio','MediaStreamAudioDestinationNode','d')])} }
        class AudioContext {
          constructor(){this.state='running'}
          createMediaStreamSource(s){return new globalThis.MediaStreamAudioSourceNode(this,{mediaStream:s})}
          createGain(){return new globalThis.GainNode(this)}
          createMediaStreamDestination(){return new globalThis.MediaStreamAudioDestinationNode(this)}
        }
        Object.assign(globalThis,{AudioParam,AudioNode,MediaStreamTrack,MediaStream,MediaStreamAudioSourceNode,GainNode,MediaStreamAudioDestinationNode,AudioContext});
      })();
      globalThis.RTCPeerConnection=class {
        getSenders(){return []} getReceivers(){return []} getTransceivers(){return []} async getStats(){return new Map()}
      };
      navigator={mediaDevices:{async getUserMedia(){return new MediaStream([new MediaStreamTrack('audio','mic','m')])}}};
      (${installRtcTopologyProbe.toString()})();
      const mic=await navigator.mediaDevices.getUserMedia({audio:true});
      const ctx=new AudioContext();
      let cur=ctx.createMediaStreamSource(mic);
      for(let i=0;i<chainLength;i++){const g=ctx.createGain();cur.connect(g);cur=g;}
      const dst=ctx.createMediaStreamDestination();
      cur.connect(dst);
      const before=cassiniRtcProbeStats().lineageSteps;
      await cassiniRtcPlatformFixture({platform:'ms-teams',capturedOn:'2026-11-12',provenance:'synthetic-probe'});
      return cassiniRtcProbeStats().lineageSteps-before;
    })()`,context);
  }
  const steps30=await measureSteps(30);
  const steps60=await measureSteps(60);
  assert.ok(steps30>0);
  assert.ok(steps60<=steps30*2+4,`expected linear 2N vs N step count, got ${steps30} -> ${steps60}`);

  let deep={leaf:1};
  for(let i=0;i<20;i++) deep={nested:deep};
  assert.throws(()=>validatePlatformTopologyFixture({
    schema:'cassini-platform-topology/v1',platform:'ms-teams',capturedOn:'2026-11-12',
    provenance:'synthetic-probe',call:{localSpeakers:1,remoteSpeakers:1},
    runtime:{usesWebAudio:false,usesAudioWorklet:false,usesWasm:false},
    webAudioGraphs:[],peers:[deep]
  }),/depth|object|missing/i);
});
