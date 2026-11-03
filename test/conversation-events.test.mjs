import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import vm from 'node:vm';
import {ExtensionBridge} from '../extension-bridge.mjs';
import {DataStore} from '../data-store.mjs';

async function watcher(report,initial=[]){
  const context=vm.createContext({URL,setTimeout}),state={pendingDeletedChats:initial};
  vm.runInContext(await readFile(new URL('../extension/conversation-events.js',import.meta.url),'utf8'),context);
  const storage={get:async()=>structuredClone(state),set:async value=>Object.assign(state,structuredClone(value))};
  const events=new context.ClaudeRUConversationEvents({api:{onCompleted:{addListener(){}}},storage,report});await events.ready;return {events,state,storage,context};
}
test('only successful native conversation deletion and detail 404 responses become removal evidence',async()=>{
  const sent=[],{events}=await watcher(async records=>sent.push(...records));const base={url:'https://claude.ai/api/organizations/org/chat_conversations/gone',method:'DELETE',statusCode:204};
  for(const details of [{...base,statusCode:403},{...base,statusCode:500},{...base,url:base.url+'/files/file'},{...base,url:base.url+'/attachments'},{...base,url:'https://other.example/api/chat_conversations/gone'},{...base,method:'GET',statusCode:200}])await events.observe(details);
  assert.equal(sent.length,0);const started=Date.now();await events.observe(base);assert.equal(sent.length,1);assert.equal(sent[0].url,'https://claude.ai/chat/gone');await events.waitForDeletion('https://claude.ai/chat/gone',started);
  await events.observe({...base,method:'GET',statusCode:404,url:base.url.replace('gone','missing')});assert.equal(sent[1].kind,'missing');
});
test('deletions observed while the server is unavailable survive an extension restart and retry once',async()=>{
  const first=await watcher(async()=>{throw Error('Offline');});await first.events.observe({url:'https://claude.ai/api/org/chat_conversations/gone',method:'DELETE',statusCode:200});assert.equal(first.state.pendingDeletedChats.length,1);
  const sent=[],second=await watcher(async records=>sent.push(...records),first.state.pendingDeletedChats);await second.events.flush();await second.events.flush();assert.equal(sent.length,1);assert.equal(second.state.pendingDeletedChats.length,0);
});
test('authenticated deletion observations persist tombstones without pruning chats absent from a partial sidebar',async t=>{
  const root=await mkdtemp(join(tmpdir(),'cru-deleted-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new DataStore(root),gone=await store.create({title:'Gone',url:'https://claude.ai/chat/gone'}),older=await store.create({title:'Older',url:'https://claude.ai/chat/older'});
  await store.importIndex([{title:'Gone',url:gone.url}]);assert.equal((await store.list()).length,2);
  const bridge=new ExtensionBridge();await bridge.open(0);t.after(()=>bridge.close());bridge.onDeleted=records=>store.remoteDeletions(records);const base=`http://127.0.0.1:${bridge.server.address().port}`;
  const post=(body,token=bridge.token)=>fetch(base+'/deletions',{method:'POST',headers:{Origin:'chrome-extension://'+'a'.repeat(32),Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post({deletions:[{url:gone.url,kind:'deleted'}]},'0'.repeat(64))).status,401);assert.equal((await store.list()).length,2);
  assert.equal((await post({deletions:[{url:'https://elsewhere.example/chat/gone',kind:'deleted'}]})).status,400);
  assert.equal((await post({deletions:[{url:gone.url,kind:'deleted'}]})).status,200);assert.equal(store.deletionRevision,1);assert.deepEqual((await store.list()).map(c=>c.id),[older.id]);
  await store.remoteDeletions([{url:'https://claude.ai/chat/not-yet-imported',kind:'deleted'}]);
  const restored=new DataStore(root);await restored.importIndex([{title:'Stale',url:gone.url},{title:'Old snapshot',url:'https://claude.ai/chat/not-yet-imported'}]);assert.deepEqual((await restored.list()).map(c=>c.id),[older.id]);assert.equal(restored.deletionRevision,2);
});
