// D73 real graph regression, adapted from the independently supplied Chromium
// reproduction. No RTC objects/reports, media elements or lifecycle events are
// mocked. Default mode intentionally fails until explicit graph capture exists.
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {createServer} from 'node:http';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
assert.ok(process.argv.slice(2).every(arg=>arg==='--observe-only'),'Unknown argument');
const observeOnly=process.argv.includes('--observe-only');
const temporary=await mkdtemp(path.join(os.tmpdir(),'cassini-webaudio-'));
const extension=path.join(temporary,'extension');
const report={scope:'generic Web Audio mechanism; not WhatsApp compatibility or call admission',observeOnly};
let context,server,worker,popup,started=false;
try {
 await cp(path.resolve(process.env.CASSINI_TEST_EXTENSION||path.join(root,'extension')),extension,{recursive:true});
 const manifestFile=path.join(extension,'manifest.json');
 const manifest=JSON.parse(await readFile(manifestFile,'utf8'));
 const key=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'der'});
 manifest.key=key.toString('base64');await writeFile(manifestFile,JSON.stringify(manifest));
 const id=[...createHash('sha256').update(key).digest('hex').slice(0,32)].map(c=>String.fromCharCode(97+parseInt(c,16))).join('');
 assert.notEqual(id,'pcafdaahfhjiolfpfnlhmljfgoabbaij');
 report.extensionVersion=manifest.version;
 const processor=`class Tone extends AudioWorkletProcessor {
 constructor(){super();this.frame=0;}
 process(inputs,outputs){for(const channel of outputs[0])for(let i=0;i<channel.length;i++)channel[i]=.2*Math.sin(2*Math.PI*440*(this.frame+i)/sampleRate);this.frame+=outputs[0][0].length;return true;}
 }registerProcessor('tone',Tone);`;
 const html=`<!doctype html><title>Generated page audio, no call</title>
 <button id="start">Start generated page audio</button><script>
 document.querySelector('#start').onclick=async()=>{
 window.context=new AudioContext();await context.audioWorklet.addModule('/tone.js');
 window.node=new AudioWorkletNode(context,'tone');window.analyser=context.createAnalyser();
 node.connect(context.destination);node.connect(analyser);await context.resume();window.started=true;
 };</script>`;
 server=createServer((request,response)=>{response.setHeader('Content-Type',request.url==='/tone.js'?'text/javascript':'text/html');response.end(request.url==='/tone.js'?processor:html)});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 context=await chromium.launchPersistentContext(path.join(temporary,'profile'),{
  channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--disable-audio-output','--autoplay-policy=no-user-gesture-required']
 });
 worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 assert.equal(new URL(worker.url()).host,id);
 // Observe production native packets in memory; never connect to an installed
 // host or write a user recording. No discovery/graph/RTC behavior is replaced.
 await worker.evaluate(()=>{
  globalThis.fixturePackets=[];globalThis.fixtureNativeConnections=0;
  chrome.runtime.connectNative=()=>{
   fixtureNativeConnections++;
   const event=()=>{const listeners=[];return {addListener:fn=>listeners.push(fn),emit:m=>listeners.forEach(fn=>fn(m))}};
   const port={onMessage:event(),onDisconnect:event(),closed:false,
    postMessage(packet){
     fixturePackets.push(packet);
     queueMicrotask(()=>port.onMessage.emit(packet.type==='start'?{type:'started',path:'/fixture/Page audio',features:packet.features||[]}:
      packet.type==='stop'?{type:'stopped',path:'/fixture/Page audio'}:{type:'ack'}));
    },disconnect(){if(!port.closed){port.closed=true;port.onDisconnect.emit()}}
   };return port;
  };
 });
 await context.addInitScript(()=>{
  globalThis.discovery=[];
  addEventListener('message',event=>{if(event.source===window&&event.data?.channel==='cassini-page'&&event.data.type==='discovery')discovery.push(event.data)});
 });
 const page=await context.newPage();const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
 const url=`http://127.0.0.1:${server.address().port}/`;
 await page.goto(url);await page.waitForFunction(()=>globalThis.__cassiniPageHook&&discovery.length);
 await page.locator('#start').click();await page.waitForFunction(()=>globalThis.started);
 await page.waitForFunction(()=>{const samples=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(samples);return samples.reduce((sum,x)=>sum+x*x,0)/samples.length>.01});
 report.baseline=await page.evaluate(()=>{
  const samples=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(samples);
  return {hook:globalThis.__cassiniPageHook,contextState:context.state,rms:Math.sqrt(samples.reduce((sum,x)=>sum+x*x,0)/samples.length),discovery:discovery.at(-1),mediaElements:document.querySelectorAll('audio,video').length};
 });
 assert.ok(report.baseline.rms>.1);assert.equal(report.baseline.contextState,'running');
 assert.equal(report.baseline.mediaElements,0);
 assert.ok((await page.evaluate(()=>discovery)).every(m=>m.sourceCount===0&&m.heard===false),'media-only audio must never fabricate receiver count or heard evidence');
 const tabId=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url).id,url);
 // A full popup page has no browser-owned active meeting; pin only that query
 // to this browser-owned tab, as the existing extension-reload fixture does.
 popup=await context.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);
 await worker.evaluate(tabId=>{const query=chrome.tabs.query.bind(chrome.tabs);chrome.tabs.query=async options=>options.active?[await chrome.tabs.get(tabId)]:query(options)},tabId);
 const status=()=>popup.evaluate(tabId=>chrome.runtime.sendMessage({target:'background',type:'status',tabId}),tabId);
 report.before=await status();
 assert.equal(report.before.recording,false);
 report.beforePackets=await worker.evaluate(()=>fixturePackets);
 assert.equal(report.beforePackets.some(p=>p.type==='start'),false,'page audio alone must never automatically Start');
 assert.equal(report.beforePackets.some(p=>p.type==='audio'),false,'no PCM before explicit capture');
 const inventories=report.beforePackets.filter(p=>p.type==='meetings');
 assert.ok(inventories.length>0,'observe actual control inventory');
 assert.ok(inventories.every(p=>p.meetings.length===0),'media-only graph must not publish a meeting');
 assert.deepEqual(pageErrors,[]);
 if(observeOnly){
  console.log('PASS media-only baseline: real440Hz AudioWorklet RMS>0.1, no receiver/heard evidence and no automatic capture');
 }else{
  // Existing trusted explicit Start is the current test adapter, NOT a proposed
  // new graph API. Replace only this request adapter when the D73 SPEC is agreed;
  // keep the real producer, negative admission and actual PCM assertions intact.
  report.start=await popup.evaluate(()=>chrome.runtime.sendMessage({target:'background',type:'start',mode:'tracks'}));
  started=report.start.recording===true;
  assert.equal(started,true,'Explicit page-audio capture must start: '+JSON.stringify(report.start));
  const deadline=Date.now()+15000;
  while(true){
   report.packets=await worker.evaluate(()=>fixturePackets);
   const audio=report.packets.filter(p=>p.type==='audio');
   if(audio.reduce((sum,p)=>sum+Buffer.from(p.pcm,'base64').length,0)>=96000)break;
   assert.ok(Date.now()<deadline,'D73 graph capture missing: real440Hz AudioWorklet is playing (RMS>0.1), but explicit capture delivers no PCM. This is not a meeting-admission failure.');
   await new Promise(resolve=>setTimeout(resolve,25));
  }
  const tracks=report.packets.filter(p=>p.type==='track');assert.ok(tracks.length>0);
  assert.ok(tracks.every(t=>t.kind==='media'&&t.label==='Page audio'),'graph output must remain honest mixed media, never individual remote participants');
  for(const track of tracks){
   const pcm=Buffer.concat(report.packets.filter(p=>p.type==='audio'&&p.id===track.id).map(p=>Buffer.from(p.pcm,'base64')));
   assert.equal(track.channels,1);assert.equal(pcm.length%2,0);
   const count=pcm.length/2;assert.ok(count>=track.sampleRate,'at least one second of actual PCM');
   let power=0,sine=0,cosine=0;
   for(let i=0;i<count;i++){const x=pcm.readInt16LE(i*2)/32768;power+=x*x;sine+=x*Math.sin(2*Math.PI*440*i/track.sampleRate);cosine+=x*Math.cos(2*Math.PI*440*i/track.sampleRate)}
   assert.ok(Math.sqrt(power/count)>.05,'captured graph PCM must be non-silent');
   assert.ok(2*(sine*sine+cosine*cosine)/(count*power)>.8,'captured PCM must contain the actual440Hz worklet tone');
  }
  assert.ok((await page.evaluate(()=>discovery)).every(m=>m.sourceCount===0&&m.heard===false),'explicit media capture still must not fabricate call evidence');
  report.stop=await popup.evaluate(()=>chrome.runtime.sendMessage({target:'background',type:'stop'}));started=false;
  assert.equal(report.stop.recording,false);assert.deepEqual(pageErrors,[]);
  console.log('PASS explicit real AudioWorklet capture; media-only admission remains negative (not WhatsApp proof)');
 }
}catch(error){report.error=String(error);throw error}
finally{
 if(started&&popup)await popup.evaluate(()=>chrome.runtime.sendMessage({target:'background',type:'stop'})).catch(()=>{});
 if(worker)report.finalPackets=await worker.evaluate(()=>fixturePackets).catch(()=>[]);
 // Bound metadata artifacts: do not dump generated PCM payloads.
 for(const key of ['packets','finalPackets','beforePackets'])if(report[key])report[key]=report[key].map(({pcm,...packet})=>({...packet,...(pcm?{pcmBytes:Buffer.from(pcm,'base64').length}:{})}));
 await mkdir(path.join(root,'artifacts'),{recursive:true});await writeFile(path.join(root,'artifacts/webaudio-capture.json'),JSON.stringify(report,null,2));
 await context?.close();if(server?.listening)await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true});
}
