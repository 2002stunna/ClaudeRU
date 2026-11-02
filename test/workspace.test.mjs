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
  const state={settings:null,files:null};
  const bridge={status:{connected:true},
    execute:async job=>job.kind==='open'?{snapshot:{url:job.url,title:'Старый чат',messages:[{role:'user',text:'Старый вопрос'},{role:'assistant',text:'Старый ответ'}]}}:{catalog:{models:['Sonnet 5.5'],efforts:['low','high'],current:{model:'Sonnet 5.5',effort:'high'}},chats:[{url:'https://claude.ai/chat/remote-123',title:'Старый чат'}]},
    send:async job=>{if(job.text==='Отклонить до отправки'){const error=Error('Ошибка обработки вложения');error.notSent=true;throw error;}state.settings=job.settings;state.files=job.files;job.onUpdate({text:'Ответ с файлом',url:'https://claude.ai/chat/new-456'});await job.onFile({name:'ответ.csv',type:'text/csv',data:Buffer.from('a,b\n1,2').toString('base64')});return {url:'https://claude.ai/chat/new-456',title:'Разговор с файлом'};}};
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
  const sync=await(await post('/api/sync',{})).json();assert.equal(sync.chats.length,1);assert.equal(sync.catalog.models[0],'Sonnet 5.5');
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
  const generated=events.find(e=>e.type==='file').file;assert.equal(await(await get('/api/files/'+generated.id)).text(),'a,b\n1,2');
  assert.equal(events.at(-1).type,'done');
  const history=await(await get('/api/chats')).json();const stored=history.chats.find(c=>c.id===chat.id);
  assert.equal(stored.title,'Разговор с файлом');assert.equal(stored.messages[0].files[0].id,file.id);assert.equal(stored.messages[1].files[0].id,generated.id);
  assert.equal((await post('/api/chat',{chatId:chat.id,text:'bad',settings:{effort:'invalid'}})).status,400);
  const renamed=await(await post('/api/chats/metadata',{id:chat.id,title:'Своё название',pinned:true})).json();assert.equal(renamed.chat.pinned,true);
  const refreshed=await(await post('/api/chats/open',{id:chat.id})).json();assert.equal(refreshed.chat.title,'Своё название');
  assert.equal((await post('/api/chats/metadata',{id:chat.id,title:''})).status,400);
  const beforeFailure=(await(await get('/api/chats')).json()).chats.find(c=>c.id===chat.id);
  const failed=await post('/api/chat',{chatId:chat.id,text:'Отклонить до отправки',fileIds:[file.id]});const failure=JSON.parse((await failed.text()).trim());assert.equal(failure.type,'error');assert.equal(failure.notSent,true);
  const afterFailure=(await(await get('/api/chats')).json()).chats.find(c=>c.id===chat.id);assert.equal(afterFailure.messages.length,beforeFailure.messages.length);assert.equal(afterFailure.title,beforeFailure.title);
});
