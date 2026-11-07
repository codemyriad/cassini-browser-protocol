// Real BFCache navigation with the shipped hook/relay/worker. No fake lifecycle
// events, RTC objects, discovery messages, devices, capture or native host.
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {createServer} from 'node:http';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temporary=await mkdtemp(path.join(os.tmpdir(),'cassini-bfcache-'));
const extension=path.join(temporary,'extension');
await cp(path.resolve(process.env.CASSINI_TEST_EXTENSION||path.join(root,'extension')),extension,{recursive:true});
const manifestPath=path.join(extension,'manifest.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8'));
const {publicKey}=generateKeyPairSync('rsa',{modulusLength:2048}),key=publicKey.export({type:'spki',format:'der'});
manifest.key=key.toString('base64');await writeFile(manifestPath,JSON.stringify(manifest));
const id=[...createHash('sha256').update(key).digest('hex').slice(0,32)].map(c=>String.fromCharCode(97+parseInt(c,16))).join('');
assert.notEqual(id,'pcafdaahfhjiolfpfnlhmljfgoabbaij');
const server=createServer((request,response)=>{
 response.setHeader('Content-Type','text/html');
 response.end(`<!doctype html><title>BFCache fixture ${request.url}</title>
 <script>window.fixtureDocument=crypto.randomUUID();window.fixtureConstructor=RTCPeerConnection;window.fixtureLifecycle=[];
 for(const type of ['pageshow','pagehide'])addEventListener(type,e=>fixtureLifecycle.push({type,persisted:e.persisted}));</script>
 <a href="/away">Navigate away</a>`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
async function observed(check,label){const deadline=Date.now()+15000;while(true){const value=await check();if(value)return value;assert.ok(Date.now()<deadline,'Timed out: '+label);await new Promise(resolve=>setTimeout(resolve,25));}}
let context,browserSession,page,worker,sessionId,nextId=0;const logs=[],pageErrors=[];
const report={version:manifest.version};
try {
 context=await chromium.launchPersistentContext(path.join(temporary,'profile'),{
  channel:'chromium',headless:true,ignoreDefaultArgs:['--disable-back-forward-cache'],
  args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,`--allowlisted-extension-id=${id}`,
   '--enable-features=DisconnectExtensionMessagePortWhenPageEntersBFCache','--disable-audio-output']
 });
 worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 assert.equal(new URL(worker.url()).host,id);
 browserSession=await context.browser().newBrowserCDPSession();
 const targets=(await browserSession.send('Target.getTargets')).targetInfos;
 const target=targets.find(t=>t.type==='service_worker'&&t.url===worker.url());assert.ok(target);
 ({sessionId}=await browserSession.send('Target.attachToTarget',{targetId:target.targetId,flatten:false}));
 browserSession.on('Target.receivedMessageFromTarget',event=>{
  if(event.sessionId!==sessionId)return;const message=JSON.parse(event.message);
  if(message.method==='Log.entryAdded')logs.push(message.params.entry.text);
  if(message.method==='Runtime.consoleAPICalled')logs.push(message.params.args.map(a=>a.value??a.description??'').join(' '));
  if(message.method==='Runtime.exceptionThrown')logs.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);
 });
 async function call(method,params={}){
  const requestId=++nextId;
  const reply=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{browserSession.off('Target.receivedMessageFromTarget',receive);reject(Error('No worker reply: '+method));},10000);
   function receive(event){if(event.sessionId!==sessionId)return;const m=JSON.parse(event.message);if(m.id!==requestId)return;
    clearTimeout(timer);browserSession.off('Target.receivedMessageFromTarget',receive);m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result);}
   browserSession.on('Target.receivedMessageFromTarget',receive);
  });
  await browserSession.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id:requestId,method,params})});return reply;
 }
 await call('Runtime.enable');await call('Log.enable');
 await worker.evaluate(()=>{
  console.warn('cassini BFCache worker log probe');
  globalThis.fixtureConnections=[];
  chrome.runtime.onConnect.addListener(port=>{
   if(port.name!=='cassini-frame'||port.sender.frameId!==0)return;
   const row={tabId:port.sender.tab.id,documentId:port.sender.documentId,ready:false,disconnected:false};fixtureConnections.push(row);
   // Observe native lifecycle/handshake only; never read lastError here.
   // An observer read would mask the unchecked receiving-callback regression.
   port.onMessage.addListener(m=>{if(m.type==='relayReady')row.ready=true});
   port.onDisconnect.addListener(()=>{row.disconnected=true});
  });
 });
 await observed(()=>logs.some(s=>s.includes('cassini BFCache worker log probe')),'worker console observer');
 page=await context.newPage();page.on('pageerror',error=>pageErrors.push(error.message));
 const url=`http://127.0.0.1:${server.address().port}/meeting`;
 await page.goto(url);
 const initial=await observed(()=>worker.evaluate(()=>fixtureConnections.find(r=>r.ready)),'initial relay handshake');
 const document=await page.evaluate(()=>fixtureDocument);report.initial=initial;report.initialDocument=document;
 await page.getByRole('link',{name:'Navigate away'}).click();await page.waitForURL('**/away');
 await observed(()=>worker.evaluate(()=>fixtureConnections.length>=2),'away-page relay');
 await observed(()=>worker.evaluate(initial=>fixtureConnections.find(r=>r.documentId===initial.documentId)?.disconnected,initial),'cached-page port closes in Chrome');
 await page.goBack({waitUntil:'commit'});await page.waitForURL(url,{waitUntil:'commit'});
 const restored=await observed(()=>page.evaluate(original=>{
  const shows=fixtureLifecycle.filter(e=>e.type==='pageshow');
  return fixtureDocument!==original||shows.length>=2?{document:fixtureDocument,lifecycle:fixtureLifecycle,sameConstructor:RTCPeerConnection===fixtureConstructor,notRestoredReasons:performance.getEntriesByType('navigation')[0]?.notRestoredReasons?.toJSON?.()}:null;
 },document),'actual persisted pageshow');
 report.restored=restored;
 assert.equal(restored.document,document,'history must restore the same document, not reload');
 assert.equal(restored.lifecycle.at(-1).type,'pageshow');assert.equal(restored.lifecycle.at(-1).persisted,true,'must actually restore from BFCache');
 assert.equal(restored.sameConstructor,true,'cached MAIN hook must not be wrapped again');
 const connections=await observed(()=>worker.evaluate(initial=>{
  const rows=fixtureConnections.filter(r=>r.tabId===initial.tabId&&r.documentId===initial.documentId);
  return rows.length>=2&&rows.at(-1).ready?rows:null;
 },initial),'new relay handshake in the same browser document');
 assert.equal(connections.length,2,'one replacement relay after one BFCache restore');report.connections=connections;
 // This readiness probe runs only AFTER observing the fresh handshake, so it
 // cannot repair a missing pageshow reconnection and turn this test green.
 report.bridge=await worker.evaluate(tabId=>chrome.tabs.sendMessage(tabId,{type:'cassini-connect'}),initial.tabId);
 assert.equal(report.bridge.connected,true);
 const popup=await context.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);
 report.status=await popup.evaluate(tabId=>chrome.runtime.sendMessage({target:'background',type:'status',tabId}),initial.tabId);
 assert.equal(report.status.recording,false);assert.equal(report.status.browserHealth.state,'idle');
 assert.deepEqual(pageErrors,[]);
 assert.deepEqual(logs.filter(s=>/Unchecked runtime\.lastError/i.test(s)),[],'receiving endpoint must consume the BFCache callback error');
 console.log('PASS real BFCache: persisted pageshow, same document/hook, fresh ready relay, idle/no recording and no unchecked port error');
} finally {
 report.logs=logs;report.pageErrors=pageErrors;
 report.allConnections=await worker?.evaluate(()=>fixtureConnections).catch(error=>({error:error.message}));
 if(page&&!page.isClosed())report.lastDocument=await page.evaluate(()=>({url:location.href,document:window.fixtureDocument,lifecycle:window.fixtureLifecycle})).catch(error=>({error:error.message}));
 await mkdir(path.join(root,'artifacts'),{recursive:true});await writeFile(path.join(root,'artifacts/bfcache.json'),JSON.stringify(report,null,2));
 await browserSession?.detach().catch(()=>{});await context?.close();await new Promise(resolve=>server.close(resolve));await rm(temporary,{recursive:true,force:true});
}
