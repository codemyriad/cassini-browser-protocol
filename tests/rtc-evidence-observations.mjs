// Measure the proposed R1 predicate with real RTC/media and fake browser devices.
// This is an ambiguity study, not a production producer/admission test. In
// particular echo/early-media observations are reported honestly, never renamed
// into passing admission negatives. No app/native host or real device is used.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {installRtcTopologyProbe,summarizeRtcTopology} from './rtc-topology-probe.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const directory=await mkdtemp(path.join(os.tmpdir(),'cassini-rtc-evidence-'));
const server=createServer((request,response)=>{response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>Controlled RTC evidence study</title><main id="state"></main>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
const report={scope:'real Chromium candidate-R1 observations only; no producer, native app, admission or capture proof',cases:[]};
async function gathered(page,index) {
  return page.evaluate(async index=>{
    const pc=peers[index];
    if(pc.iceGatheringState!=='complete')await new Promise(resolve=>{
      const changed=()=>{if(pc.iceGatheringState==='complete'){pc.removeEventListener('icegatheringstatechange',changed);resolve()}};
      pc.addEventListener('icegatheringstatechange',changed);changed();
    });
    return pc.localDescription.toJSON();
  },index);
}
try{
  browser=await chromium.launch({headless:true,args:['--disable-audio-output','--autoplay-policy=no-user-gesture-required',
    '--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--allow-loopback-in-peer-connection','--disable-features=WebRtcHideLocalIpsWithMdns']});
  report.browserVersion=browser.version();
  for(const fixture of ['duplex','passive-viewer','mic-preview','synthetic-sender','captured-clone','unrelated-mic-peer','echo','unanswered-early-media']){
    const context=await browser.newContext({permissions:['microphone']});
    try{
      await context.addInitScript(installRtcTopologyProbe);
      await context.addInitScript({path:path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../extension/page-hook.js')});
      await context.addInitScript(()=>{
        globalThis.cassiniObservedDiscovery=null;
        addEventListener('message',event=>{
          if(event.source===window&&event.data?.channel==='cassini-page'&&event.data.type==='discovery'){
            const value=event.data;
            cassiniObservedDiscovery={sourceCount:value.sourceCount,heard:value.heard,hookCallGeneration:value.callGeneration};
          }
        });
      });
      const caller=await context.newPage(),remote=await context.newPage();
      const url=`http://127.0.0.1:${server.address().port}/`;
      await Promise.all([caller.goto(url),remote.goto(url)]);
      await caller.evaluate(async fixture=>{
        window.peers=[new RTCPeerConnection()];window.fixture=fixture;window.capture=null;
        document.querySelector('#state').textContent=fixture==='unanswered-early-media'?'Ringing':'Controlled RTC';
        if(!['passive-viewer','synthetic-sender'].includes(fixture))window.capture=await navigator.mediaDevices.getUserMedia({audio:true});
        if(fixture==='unrelated-mic-peer')peers.push(new RTCPeerConnection());
        if(fixture==='synthetic-sender'){
          window.audio=new AudioContext();const tone=audio.createOscillator(),output=audio.createMediaStreamDestination();tone.connect(output);tone.start();await audio.resume();
          peers[0].addTrack(output.stream.getAudioTracks()[0]);
        }else if(capture&&!['mic-preview','unrelated-mic-peer'].includes(fixture)){
          const track=capture.getAudioTracks()[0];peers[0].addTrack(fixture==='captured-clone'?track.clone():track);
        }else if(fixture==='unrelated-mic-peer')peers[1].addTrack(capture.getAudioTracks()[0]);
        peers[0].addTransceiver('audio',{direction:'recvonly'});
      },fixture);
      await remote.evaluate(()=>{window.peers=[];window.audio=new AudioContext()});
      const peerCount=fixture==='unrelated-mic-peer'?2:1;
      for(let index=0;index<peerCount;index++){
        await caller.evaluate(async index=>{await peers[index].setLocalDescription(await peers[index].createOffer())},index);
        const offer=await gathered(caller,index);
        await remote.evaluate(async({index,offer,fixture})=>{
          const pc=new RTCPeerConnection();peers[index]=pc;
          await pc.setRemoteDescription(offer);
          if(index===0){
            let stream;
            if(fixture==='echo'){
              const receiver=pc.getReceivers().find(receiver=>receiver.track?.kind==='audio');
              if(receiver)stream=new MediaStream([receiver.track]);
            }
            if(!stream){const tone=audio.createOscillator(),output=audio.createMediaStreamDestination();tone.connect(output);tone.start();stream=output.stream;}
            // Reuse a negotiated receive slot when possible; otherwise add a
            // real sender. Echo returns the actual received capture track.
            const slot=pc.getTransceivers().find(value=>value.receiver.track.kind==='audio');
            await slot.sender.replaceTrack(stream.getAudioTracks()[0]);slot.direction='sendrecv';
            await audio.resume();
          }
          await pc.setLocalDescription(await pc.createAnswer());
        },{index,offer,fixture});
        await caller.evaluate(async({index,answer})=>peers[index].setRemoteDescription(answer),{index,answer:await gathered(remote,index)});
      }
      await caller.waitForFunction(async()=> (await cassiniRtcTopology()).some(row=>row.connected&&row.inboundPackets>0));
      const before=await caller.evaluate(()=>cassiniRtcTopology());
      await caller.waitForFunction(async({before,sending})=>{
        const rows=await cassiniRtcTopology();
        const grew=(row,key)=>row[key]>(before.find(previous=>previous.peer===row.peer)?.[key]??Infinity);
        return rows.some(row=>grew(row,'inboundPackets'))&&(!sending||rows.some(row=>grew(row,'outboundPackets')));
      },{before,sending:!['passive-viewer','mic-preview'].includes(fixture)});
      const topology=summarizeRtcTopology(before,await caller.evaluate(()=>cassiniRtcTopology()));
      await caller.waitForFunction(()=>globalThis.__cassiniCallEvidenceV1?.read().revision>=3);
      const observed=await caller.evaluate(()=>{
        const value=globalThis.__cassiniCallEvidenceV1.read();
        return {revision:value.revision,ageMs:value.ageMs,receivedPeers:value.receivedPeers,
          capturedSendingPeers:value.capturedSendingPeers,samePeerCount:value.samePeerCount,unboundReceiverCount:value.unboundReceiverCount};
      });
      const candidateR1=topology.samePeerConnection;
      if(['passive-viewer','mic-preview','synthetic-sender','unrelated-mic-peer'].includes(fixture))assert.equal(candidateR1,false,fixture);
      if(['duplex','captured-clone'].includes(fixture))assert.equal(candidateR1,true,fixture);
      if(['passive-viewer','mic-preview','synthetic-sender','unrelated-mic-peer'].includes(fixture))assert.equal(observed.samePeerCount,0,'packaged hook '+fixture);
      if(['duplex','captured-clone'].includes(fixture))assert.equal(observed.samePeerCount,1,'packaged hook '+fixture);
      if(fixture==='passive-viewer')await caller.waitForFunction(()=>cassiniObservedDiscovery?.sourceCount===1&&cassiniObservedDiscovery.heard===true);
      const legacySourceObservation=await caller.evaluate(()=>cassiniObservedDiscovery);
      report.cases.push({fixture,candidateR1,topology,packagedHookObservation:observed,
        legacySourceObservation,
        ...(fixture==='echo'||fixture==='unanswered-early-media'?{requiresCoordinatorReview:candidateR1}: {})});
    }finally{await context.close()}
  }
}finally{
  await browser?.close();await new Promise(resolve=>server.close(resolve));
  const artifacts=path.resolve('artifacts');await mkdir(artifacts,{recursive:true});
  await writeFile(path.join(artifacts,'rtc-evidence-observations.json'),JSON.stringify(report,null,2));
  await rm(directory,{recursive:true,force:true});
}
console.log('Measured candidate R1 on real RTC fixtures; echo/early-media ambiguity is reported for review, not hidden.');
