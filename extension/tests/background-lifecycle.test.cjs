const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function event() { const listeners=[]; return {addListener(fn){listeners.push(fn)},emit(...args){listeners.forEach(fn=>fn(...args))}}; }
async function setup({delay,previous,grantError}={}) {
  const connect=event(), messages=event(), stored=previous?{cassiniActive:previous}:{};
  let nativeConnections=0,badge='REC';
  const chrome={runtime:{id:'test',onConnect:connect,onMessage:messages,getURL:name=>'chrome-extension://test/'+name,getContexts:async()=>[],connectNative(){
    nativeConnections++; const port={onMessage:event(),onDisconnect:event(),disconnect(){this.onDisconnect.emit()},postMessage(packet){
      queueMicrotask(()=>this.onMessage.emit(packet.type==='start'?{type:'started',path:'/Recording-test'}:packet.type==='stop'?{type:'stopped',path:'/Recording-test'}:{type:'ack'}));
    }};return port;
  }},storage:{session:{async get(){return {...stored}},async set(value){Object.assign(stored,value)},async remove(key){delete stored[key]}}},
  tabs:{query:async()=>[{id:1,url:'https://meeting.test',title:'Test'}],onRemoved:event(),async sendMessage(){
    if(delay!==undefined)setTimeout(()=>connect.emit({name:'cassini-frame',sender:{id:'test',tab:{id:1}},onMessage:event(),onDisconnect:event(),postMessage(){}}),delay);
  }},tabCapture:{async getMediaStreamId(){if(grantError)throw Error('No invocation');return 'stream'}},
  offscreen:{async closeDocument(){},async createDocument(){}},action:{async setBadgeText(value){badge=value.text},async setBadgeBackgroundColor(){}}};
  const context=vm.createContext({chrome,setTimeout,clearTimeout,crypto:{randomUUID:()=> 'token'},queueMicrotask});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../background.js'),'utf8')+'\nglobalThis.api={start,status,recovery};',context);
  await context.api.recovery;
  return {api:context.api,stored,get connections(){return nativeConnections},get badge(){return badge}};
}
test('300ms delayed relay is discovered before native host creation',async()=>{
 const app=await setup({delay:300});const started=Date.now();await app.api.start('tracks');
 assert.ok(Date.now()-started>=250);assert.equal(app.connections,1);assert.equal(app.stored.cassiniActive.path,'/Recording-test');
});
test('missing relay and missing tab invocation do not create a native session',async()=>{
 for(const options of [{},{grantError:true}]){const app=await setup(options);await assert.rejects(app.api.start(options.grantError?'tab':'tracks'));assert.equal(app.connections,0);}
});
test('worker recovery reports interruption with saved path and clears stale badge/state',async()=>{
 const app=await setup({previous:{path:'/Recording-saved',recording:true}});
 assert.equal(app.api.status().recording,false);assert.match(app.api.status().message,/interrupted/);
 assert.equal(app.api.status().path,'/Recording-saved');assert.equal(app.badge,'');assert.equal(app.stored.cassiniActive,undefined);
});
