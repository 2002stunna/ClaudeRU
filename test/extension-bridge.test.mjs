import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ExtensionBridge} from '../extension-bridge.mjs';
const origin='chrome-extension://'+'a'.repeat(32);
async function fixture(t,timeout=2000){
  const bridge=new ExtensionBridge({timeout});await bridge.open(0);t.after(()=>bridge.close());
  const base=`http://127.0.0.1:${bridge.server.address().port}`;
  const call=(path,body,token=bridge.token,from=origin)=>fetch(base+path,{method:body?'POST':'GET',headers:{Origin:from,Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return{bridge,call};
}
test('extension protocol requires pairing and rejects website origins',async t=>{
  const {bridge,call}=await fixture(t);
  assert.equal(bridge.status.connected,false);
  assert.equal((await call('/poll',null,'0'.repeat(64))).status,401);
  assert.equal((await call('/poll',null,bridge.token,'https://evil.test')).status,403);
  assert.equal((await call('/poll',null,'é'.repeat(64))).status,401);
  await assert.rejects(bridge.send({text:'hello'}),/не подключено/);
});
test('job is delivered, response streamed, URL validated, completion released',async t=>{
  const {bridge,call}=await fixture(t);bridge.lastSeen=Date.now();
  const updates=[];
  const pending=bridge.send({text:'Привет',onUpdate:e=>updates.push(e)});
  const job=await(await call('/poll')).json();assert.equal(job.text,'Привет');assert.ok(job.id);
  await assert.rejects(bridge.send({text:'duplicate'}),/выполняется/);
  assert.equal((await call('/event',{id:'old',type:'done'})).status,409);
  assert.equal((await call('/event',{id:job.id,type:'update',text:'wrong',url:'https://evil.test'})).status,400);
  assert.equal((await call('/event',{id:job.id,type:'update',text:'Привет!',url:'https://claude.ai/chat/test-123'})).status,200);
  await call('/event',{id:job.id,type:'done'});await pending;
  assert.deepEqual(updates,[{text:'Привет!',url:'https://claude.ai/chat/test-123'}]);assert.equal(bridge.pending,null);
});
test('extension failure and timeout reach caller without automatic resubmission',async t=>{
  const {bridge,call}=await fixture(t,80);bridge.lastSeen=Date.now();
  const first=assert.rejects(bridge.send({text:'test',onUpdate:()=>{}}),/Не найдено/);
  const job=await(await call('/poll')).json();
  await call('/event',{id:job.id,type:'error',error:'Не найдено поле'});await first;
  await assert.rejects(bridge.send({text:'test',onUpdate:()=>{}}),/Проверьте вкладку/);
  assert.equal(bridge.pending,null);
});
test('inspection result and generated file events cross the authenticated extension transport',async t=>{
  const {bridge,call}=await fixture(t);bridge.lastSeen=Date.now();
  const inspect=bridge.execute({kind:'inspect'});
  let job=await(await call('/poll')).json();assert.equal(job.kind,'inspect');
  const result={catalog:{models:['Sonnet 5.5']},chats:[]};
  await call('/event',{id:job.id,type:'done',result});assert.deepEqual(await inspect,result);
  const files=[],warnings=[];
  const sending=bridge.send({text:'hello',settings:{model:'Sonnet 5.5',effort:'high'},files:[],onFile:async file=>files.push(file),onWarning:w=>warnings.push(w)});
  job=await(await call('/poll')).json();assert.equal(job.settings.effort,'high');
  const file={name:'résumé.txt',type:'text/plain',data:'aGk='};
  assert.equal((await call('/event',{id:job.id,type:'file',file})).status,200);
  await call('/event',{id:job.id,type:'warning',warning:'one file unavailable'});
  await call('/event',{id:job.id,type:'done'});await sending;
  assert.deepEqual(files,[file]);assert.deepEqual(warnings,['one file unavailable']);
});
