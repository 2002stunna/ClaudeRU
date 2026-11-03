import {mockCatalog} from './helpers/catalog.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scryptSync} from 'node:crypto';
import {DataStore,decodeFile,chatOptions} from '../data-store.mjs';
import {createApp} from '../server.mjs';
const data=Buffer.from('Привет из файла\n').toString('base64');
test('files and conversations survive server restart without storing base64 in chat history',async t=>{
  const root=await mkdtemp(join(tmpdir(),'clauderu-store-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const first=new DataStore(root);const file=await first.putFile({name:'../данные.txt',type:'text/plain',data});
  const chat=await first.create({title:'Мой чат',settings:{model:'Sonnet 5.5',effort:'high'},messages:[{role:'user',text:'Привет',files:[file]}]});
  const restored=new DataStore(root);assert.equal((await restored.get(chat.id)).settings.effort,'high');
  const saved=await restored.readFile(file.id);assert.equal(saved.bytes.toString(),'Привет из файла\n');assert.ok(!saved.meta.name.includes('/'));
  assert.ok(!JSON.stringify(await restored.list()).includes(data));
  assert.equal((await restored.wireFiles([file.id]))[0].data,data);
  await assert.rejects(restored.readFile('../auth'),/Файл не найден/);
  await assert.rejects(restored.wireFiles(Array(6).fill(file.id)),/до 5/);
  assert.throws(()=>decodeFile({name:'bad',data:'not base64!'}),/Некорректный файл/);
  assert.throws(()=>chatOptions({effort:'ultra'}),/Некорректный/);
});
async function app(t){
  const state={settings:null,files:null,title:'Старый чат'};
  const bridge={status:{connected:true},
    execute:async job=>job.kind==='manage'?(state.title=job.title||state.title,{applied:true}):job.kind==='open'?{snapshot:{url:job.url,title:state.title,messages:[{role:'user',text:'Старый вопрос'},{role:'assistant',text:'Старый ответ'}]}}:{catalog:mockCatalog({models:['Sonnet 5.5'],efforts:['low','high'],current:{model:'Sonnet 5.5',effort:'high'}}),chats:[{url:'https://claude.ai/chat/remote-123',title:'Старый чат'}]},
    send:async job=>{if(job.text==='Отклонить до отправки'){const error=Error('Ошибка обработки вложения');error.notSent=true;throw error;}state.settings=job.settings;state.files=job.files;job.onUpdate({text:'Ответ с файлом',format:{version:1,font:'sans',children:[{tag:'p',children:['Ответ с ',{tag:'strong',children:['файлом']}]}]},url:'https://claude.ai/chat/new-456'});const file={name:'ответ.csv',type:'text/csv',data:Buffer.from('a,b\n1,2').toString('base64')};const first=await job.onFile(file),recovered=await job.onFile(file);assert.equal(first.id,recovered.id);return {url:'https://claude.ai/chat/new-456',title:'Разговор с файлом'};}};
  const auth={salt:'test',hash:scryptSync('test-password','test',64).toString('hex')};
  const server=createApp({auth,bridge});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  const base=`http://127.0.0.1:${server.address().port}`;let cookie='';
  const get=path=>fetch(base+path,{headers:{Cookie:cookie}});
  const post=(path,body)=>fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});
  const login=await post('/api/login',{password:'test-password'});cookie=login.headers.get('set-cookie').split(';')[0];
  return {state,get,post,base};
}
test('authenticated workspace: models, old chats, uploads, streamed generated file and shared history',async t=>{
  const {state,get,post,base}=await app(t);
  const sync=await(await post('/api/sync',{})).json();assert.equal(sync.chats.length,1);assert.equal(sync.catalog.models[0],'Fable 5.1');
  const imported=sync.chats[0];assert.equal(imported.loaded,false);
  const opened=await(await post('/api/chats/open',{id:imported.id})).json();assert.equal(opened.chat.messages[1].text,'Старый ответ');
  const {chat}=await(await post('/api/chats/new',{})).json();
  const {file}=await(await post('/api/uploads',{name:'данные.txt',type:'text/plain',data})).json();
  assert.equal((await fetch(base+'/api/files/'+file.id)).status,401);
  const download=await get('/api/files/'+file.id);assert.match(download.headers.get('content-disposition'),/^attachment/);assert.equal(await download.text(),'Привет из файла\n');
  const settings={model:'Sonnet 5.5',effort:'high'};
  assert.equal((await post('/api/options',{id:chat.id,settings})).status,200);
  const response=await post('/api/chat',{chatId:chat.id,text:'Изучи',settings,fileIds:[file.id]});
  const events=(await response.text()).trim().split('\n').map(JSON.parse);
  assert.deepEqual(state.settings,settings);assert.equal(state.files[0].data,data);
  assert.equal(events.filter(e=>e.type==='file').length,1,'recovery must not duplicate a generated file');const generated=events.find(e=>e.type==='file').file;assert.equal(await(await get('/api/files/'+generated.id)).text(),'a,b\n1,2');
  assert.equal(events.at(-1).type,'done');
  const history=await(await get('/api/chats')).json();const stored=history.chats.find(c=>c.id===chat.id);
  assert.equal(stored.messages[1].format.children[0].children[1].tag,'strong');assert.equal(stored.title,'Разговор с файлом');assert.equal(stored.messages[0].files[0].id,file.id);assert.equal(stored.messages[1].files[0].id,generated.id);
  assert.equal((await post('/api/chat',{chatId:chat.id,text:'bad',settings:{effort:'invalid'}})).status,400);
  const renamed=await(await post('/api/chats/metadata',{id:chat.id,title:'Своё название',pinned:true})).json();assert.equal(renamed.chat.pinned,true);
  const refreshed=await(await post('/api/chats/open',{id:chat.id})).json();assert.equal(refreshed.chat.title,'Своё название');
  assert.equal((await post('/api/chats/metadata',{id:chat.id,title:''})).status,400);
  const beforeFailure=(await(await get('/api/chats')).json()).chats.find(c=>c.id===chat.id);
  const failed=await post('/api/chat',{chatId:chat.id,text:'Отклонить до отправки',fileIds:[file.id]});const failure=JSON.parse((await failed.text()).trim());assert.equal(failure.type,'error');assert.equal(failure.notSent,true);
  const afterFailure=(await(await get('/api/chats')).json()).chats.find(c=>c.id===chat.id);assert.equal(afterFailure.messages.length,beforeFailure.messages.length);assert.equal(afterFailure.title,beforeFailure.title);assert.equal(afterFailure.draft.text,'Отклонить до отправки');assert.equal(afterFailure.draft.files[0].id,file.id);
});

test('native chat metadata is saved only after confirmation and deleted chats stay deleted after sync',async t=>{
  const store=new DataStore(),chat=await store.create({url:'https://claude.ai/chat/manage-test',title:'Before'}),calls=[];let confirm=false;
  const bridge={status:{connected:true},execute:async job=>{calls.push(job);if(job.kind==='manage')return confirm?{applied:true}:{};return{chats:[{url:chat.url,title:'Before'}],catalog:mockCatalog({models:[],efforts:[],current:{}})};}};
  const server=createApp({auth:{salt:'test',hash:scryptSync('pw','test',64).toString('hex')},bridge,store});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  const base=`http://127.0.0.1:${server.address().port}`;let cookie='';const post=(path,body)=>fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});
  cookie=(await post('/api/login',{password:'pw'})).headers.get('set-cookie').split(';')[0];
  assert.equal((await post('/api/chats/action',{id:chat.id,action:'rename',title:'After'})).status,400);assert.equal(chat.title,'Before');
  confirm=true;let response=await(await post('/api/chats/action',{id:chat.id,action:'rename',title:'After'})).json();assert.equal(response.chat.title,'After');assert.equal(calls.at(-1).kind,'manage');assert.equal(calls.at(-1).chatId,chat.id);
  response=await(await post('/api/chats/action',{id:chat.id,action:'delete'})).json();assert.equal(response.chat.deleted,true);
  await post('/api/sync',{});assert.equal((await store.list()).length,0);await assert.rejects(store.get(chat.id),/не найден/);
});
test('opening a conversation confirmed unavailable removes the old local row and prevents stale index resurrection',async t=>{
  const store=new DataStore();await store.saveModelCatalog(mockCatalog());const chat=await store.create({url:'https://claude.ai/chat/gone-before-update',title:'Gone before update'});
  const bridge={status:{connected:true},execute:async()=>({unavailable:true,url:chat.url})},server=createApp({auth:{salt:'test',hash:scryptSync('pw','test',64).toString('hex')},bridge,store});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));const base=`http://127.0.0.1:${server.address().port}`;let cookie='';const post=(path,body)=>fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});cookie=(await post('/api/login',{password:'pw'})).headers.get('set-cookie').split(';')[0];
  const result=await(await post('/api/chats/open',{id:chat.id})).json();assert.equal(result.removed,true);assert.equal(result.id,chat.id);assert.equal(result.historyRevision,1);await store.importIndex([{url:chat.url,title:'Stale sidebar'}]);assert.equal((await store.list()).length,0);
});
test('missing native menus fall back to local cleanup and explicit local deletion never calls Claude',async t=>{
  const store=new DataStore();const a=await store.create({title:'Missing',url:'https://claude.ai/chat/missing'}),b=await store.create({title:'Local cleanup',url:'https://claude.ai/chat/local'});let calls=0;
  const bridge={execute:async()=>{calls++;throw Error('Не найдено меню именно этого чата в Claude. Действие не выполнялось.');}},server=createApp({auth:{salt:'test',hash:scryptSync('pw','test',64).toString('hex')},bridge,store});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));const base=`http://127.0.0.1:${server.address().port}`;let cookie='';const post=(path,body)=>fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});cookie=(await post('/api/login',{password:'pw'})).headers.get('set-cookie').split(';')[0];
  let response=await(await post('/api/chats/action',{id:a.id,action:'delete'})).json();assert.equal(response.localOnly,true);assert.match(response.warning,/не подтверждено/);assert.equal(calls,1);
  response=await(await post('/api/chats/action',{id:b.id,action:'delete',localOnly:true})).json();assert.equal(response.localOnly,true);assert.equal(calls,1);assert.equal((await post('/api/chats/action',{id:b.id,action:'delete',localOnly:true})).status,200);
  await store.importIndex([{url:a.url,title:a.title}]);assert.equal((await store.list()).length,0);
});
test('native current reads adopt the actual conversation and a new page cannot overwrite another local history',async t=>{
  const store=new DataStore();await store.saveModelCatalog(mockCatalog());const old=await store.create({title:'Old',url:'https://claude.ai/chat/old',messages:[{role:'assistant',text:'Old history'}]});let url='https://claude.ai/chat/native';
  const bridge={execute:async job=>{if(job.kind==='current')return {current:true,url,isNew:!url,state:{model:'Fable 5.1',effort:'medium'},snapshot:{url,title:url?'Native actual':'Новая сессия',messages:url?[{role:'assistant',text:'Native history'}]:[],state:{model:'Fable 5.1',effort:'medium'}}};if(job.kind==='open')return {snapshot:{url:'https://claude.ai/chat/wrong',title:'Wrong',messages:[{role:'assistant',text:'Wrong history'}]}};throw Error('Unexpected command');}},server=createApp({auth:{salt:'test',hash:scryptSync('pw','test',64).toString('hex')},bridge,store});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));const base=`http://127.0.0.1:${server.address().port}`;let cookie='';const post=(path,body)=>fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});cookie=(await post('/api/login',{password:'pw'})).headers.get('set-cookie').split(';')[0];
  const current=await(await post('/api/current',{id:old.id,includeSnapshot:true})).json();assert.equal(current.chat.url,url);assert.equal(current.chat.messages[0].text,'Native history');assert.equal(old.messages[0].text,'Old history');
  assert.equal((await post('/api/chats/open',{id:old.id})).status,400);assert.equal(old.url,'https://claude.ai/chat/old');assert.equal(old.title,'Old');assert.equal(old.messages[0].text,'Old history');
  url=null;const empty=await(await post('/api/current',{id:old.id})).json();assert.notEqual(empty.chat.id,old.id);assert.equal(empty.chat.url,null);assert.equal(empty.chat.messages.length,0);const again=await(await post('/api/current',{id:old.id})).json();assert.equal(again.chat.id,empty.chat.id);
});
test('following the native new page keeps the in-flight local chat until Claude assigns its conversation URL',async t=>{
  const store=new DataStore();await store.saveModelCatalog(mockCatalog());const chat=await store.create({title:'New local'});let release;const pending=new Promise(r=>release=r);t.after(()=>release());const bridge={status:{connected:true},execute:async()=>({current:true,url:null,isNew:true,boundChatId:chat.id,snapshot:{url:null,title:'Новая сессия',messages:[]},state:{model:'Fable 5.1',effort:'medium'}}),send:async job=>{job.onUpdate({text:'Preparing'});await pending;return{};}},server=createApp({auth:{salt:'test',hash:scryptSync('pw','test',64).toString('hex')},bridge,store});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));const base=`http://127.0.0.1:${server.address().port}`;let cookie='';const post=(path,body)=>fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});cookie=(await post('/api/login',{password:'pw'})).headers.get('set-cookie').split(';')[0];
  const streaming=await post('/api/chat',{chatId:chat.id,text:'My new question'});const actual=await(await post('/api/current',{id:chat.id,knownURL:null})).json();assert.equal(actual.chat.id,chat.id);assert.equal((await store.list()).length,1);assert.equal(actual.chat.messages[0].text,'My new question');release();await streaming.text();
});
test('one generating chat does not block opening, configuring or sending in another chat',async t=>{
  const store=new DataStore(),a=await store.create(),b=await store.create(),jobs=[];let finish,entered;
  a.url='https://claude.ai/chat/'+a.id;await store.save(a);const started=new Promise(r=>entered=r),hold=new Promise(r=>finish=r);t.after(()=>finish());
  const bridge={status:{connected:true},execute:async job=>{jobs.push(job);if(job.kind==='inspect')return{chats:[],snapshot:{url:a.url,messages:[{role:'user',text:'Stale snapshot'}]},catalog:mockCatalog({current:{}})};return {catalog:mockCatalog({models:['Fable 5.1'],efforts:['high'],current:{model:'Fable 5.1',effort:job.settings?.effort||'medium',blocked:'credits'}}),snapshot:{messages:[],state:{model:'Fable 5.1',effort:'medium',blocked:'credits'}}};},send:async job=>{jobs.push(job);if(job.chatId===a.id){entered();await hold;}job.onUpdate({text:job.chatId,url:'https://claude.ai/chat/'+job.chatId});return {state:{model:'Fable 5.1',effort:'high',blocked:''}};}};
  const server=createApp({auth:{salt:'test',hash:scryptSync('pw','test',64).toString('hex')},bridge,store});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  const base=`http://127.0.0.1:${server.address().port}`;let cookie='';const post=(path,body)=>fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});
  cookie=(await post('/api/login',{password:'pw'})).headers.get('set-cookie').split(';')[0];
  const first=post('/api/chat',{chatId:a.id,text:'First'});await started;
  assert.equal((await post('/api/chat',{chatId:a.id,text:'Duplicate'})).status,409);
  assert.equal((await post('/api/sync',{})).status,200);assert.equal(a.messages[0].text,'First','sync must not replace a streaming conversation with another tab snapshot');
  const opened=await(await post('/api/chats/open',{id:b.id})).json();assert.equal(opened.chat.settings.model,'Fable 5.1');assert.equal(opened.chat.claudeState.blocked,'credits');
  const changed=await(await post('/api/options',{id:b.id,settings:{effort:'high'}})).json();assert.equal(changed.chat.settings.effort,'high');assert.equal(jobs.at(-1).settings.effort,'high');
  const second=await post('/api/chat',{chatId:b.id,text:'Second'});assert.equal(second.status,200);assert.equal(JSON.parse((await second.text()).trim().split('\n').at(-1)).type,'done');
  finish();await(await first).text();assert.equal(a.messages.at(-1).text,a.id);assert.equal(b.messages.at(-1).text,b.id);
});

test('model cache is shared between chats, survives restart and is only rescanned on explicit request',async t=>{
  const {MODEL_NAMES,catalogFor}=await import('../model-catalog.mjs');
  const root=await mkdtemp(join(tmpdir(),'clauderu-catalog-'));t.after(()=>rm(root,{recursive:true,force:true}));let initializations=0;
  const byModel=Object.fromEntries(MODEL_NAMES.map((name,i)=>[name,{available:true,efforts:i%2?['medium','high']:['low','medium']}]));
  const bridge={status:{connected:true},execute:async job=>{if(job.kind==='catalog'){initializations++;await new Promise(r=>setTimeout(r,20));return {catalog:{byModel}};}assert.deepEqual(job.catalogCache,{version:1,byModel});return {catalog:catalogFor(job.catalogCache,{model:job.settings?.model||'Fable 5.1',effort:job.settings?.effort||'medium'}),chats:[],snapshot:{messages:[]}};}};
  const auth={salt:'test',hash:scryptSync('pw','test',64).toString('hex')};
  async function instance(){const store=new DataStore(root);await store.ready;const server=createApp({auth,bridge,store});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));const base=`http://127.0.0.1:${server.address().port}`;let cookie='';const post=(path,body)=>fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)});cookie=(await post('/api/login',{password:'pw'})).headers.get('set-cookie').split(';')[0];return {post,store};}
  const first=await instance(),a=await first.store.create(),b=await first.store.create();
  const responses=await Promise.all([first.post('/api/chats/open',{id:a.id}),first.post('/api/chats/open',{id:b.id})]);assert.ok(responses.every(r=>r.ok));assert.equal(initializations,1);
  let data=await(await first.post('/api/options',{id:a.id,settings:{model:'Sonnet 5.5'}})).json();assert.deepEqual(data.catalog.efforts,byModel['Sonnet 5.5'].efforts);assert.deepEqual(data.catalog.models,MODEL_NAMES);
  await first.post('/api/sync',{});assert.equal(initializations,1);
  const second=await instance();assert.deepEqual(second.store.modelCatalog,{version:1,byModel});await second.post('/api/chats/open',{id:a.id});assert.equal(initializations,1);
  await second.post('/api/sync',{refreshCatalog:true});assert.equal(initializations,2);
  assert.equal((await second.post('/api/options',{id:a.id,settings:{model:'Opus 999'}})).status,400);
});
