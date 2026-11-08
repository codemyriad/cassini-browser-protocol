// Zero-permission regression for the exact review exploit, using the loaded
// extension/worker. No gUM call, native input factory, PCM, or user profile.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {cp,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {privateControl,packet,barrier} from './rtc-evidence-control.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temporary=await mkdtemp(path.join(os.tmpdir(),'cassini-zero-permission-'));
const extension=path.join(temporary,'extension');await cp(path.join(root,'extension'),extension,{recursive:true});
const manifestPath=path.join(extension,'manifest.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8'));
const key=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'der'});
manifest.key=key.toString('base64');await writeFile(manifestPath,JSON.stringify(manifest));
const id=[...createHash('sha256').update(key).digest('hex').slice(0,32)].map(c=>String.fromCharCode(97+parseInt(c,16))).join('');
assert.notEqual(id,'pcafdaahfhjiolfpfnlhmljfgoabbaij');
const server=createServer((_request,response)=>response.end('<!doctype html><title>Permission-free adversary fixture</title>'));
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let context;
try{
 context=await chromium.launchPersistentContext(path.join(temporary,'profile'),{channel:'chromium',headless:true,
  permissions:[],args:['--disable-audio-output',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,`--allowlisted-extension-id=${id}`]});
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');await privateControl(worker);
 const page=await context.newPage();const url=`http://127.0.0.1:${server.address().port}/`;
 await page.goto(url);
 const tabId=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url).id,url);
 const actual=await page.evaluate(()=>__cassiniCallEvidenceV1.read());
 await page.evaluate(()=>{
  globalThis.forgedDescriptorReads=0;
  Object.getOwnPropertyDescriptor=()=>{forgedDescriptorReads++;return {value:{read:()=>({version:1,documentGeneration:'X',hookGeneration:'Y',revision:99,
   ageMs:0,receivedPeers:1,capturedSendingPeers:1,samePeerCount:1,unboundReceiverCount:0,receivedVersion:999,sentVersion:999,ended:false,sessionEpoch:999,sourceCount:1,heard:true})}}};
  postMessage({channel:'cassini-page',type:'discovery',sourceCount:1,heard:true,documentGeneration:'X',callGeneration:'Y'},'*');
 });
 for(let attempt=0;attempt<3;attempt++){
  const after=await barrier(worker);const current=await packet(worker,{tabId,after,state:'unknown',sourceDocumentGeneration:actual.documentGeneration});
  assert.equal(current.row.callEvidence.callGeneration,null);
  assert.equal(current.row.sourceDocumentGeneration,actual.documentGeneration);
  assert.notEqual(current.row.sourceDocumentGeneration,'X');
 }
 assert.equal(await page.evaluate(()=>forgedDescriptorReads),0,'native read must never consult the page Object replacement');
 // Prototype then/toJSON poisoning must not replace the browser-returned read.
 await page.evaluate(()=>{
  Object.prototype.then=function(resolve){resolve({samePeerCount:1,sourceCount:1,documentGeneration:'X'})};
  Object.prototype.toJSON=function(){return {samePeerCount:1,sourceCount:1,documentGeneration:'X'}};
 });
 const after=await barrier(worker);await packet(worker,{tabId,after,state:'unknown',sourceDocumentGeneration:actual.documentGeneration});
 const evidence=await page.evaluate(()=>{
  const value=__cassiniCallEvidenceV1.read();
  // Return only primitives; Object.prototype has deliberately been poisoned.
  return value.samePeerCount+':'+value.sourceCount;
 });
 assert.equal(evidence,'0:0');
 assert.equal(await worker.evaluate(()=>fixtureCaptureAttempts),0);
 assert.equal(await worker.evaluate(()=>fixturePackets.some(packet=>packet.type==='callSignals'&&packet.tabs.some(row=>row.callEvidence.state==='active'))),false);
 assert.equal(await worker.evaluate(tabId=>fixturePackets.filter(packet=>packet.type==='meetings').at(-1).meetings.some(row=>row.tabId===tabId)),false);
 console.log('PASS zero-permission descriptor/discovery forgery and prototype-then/serialization poisoning: no active proof, no invented source inventory, no native input');
}finally{await context?.close();await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true})}
