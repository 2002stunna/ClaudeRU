import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scryptSync} from 'node:crypto';
import {createApp} from '../server.mjs';
import {conversationURL} from '../bridge.mjs';
const auth={salt:'test',hash:scryptSync('test-password','test',64).toString('hex')};
async function fixture(t,bridge={send:async({onUpdate})=>onUpdate({text:'Тестовый ответ',url:'https://claude.ai/chat/abc-123'})},secure=false){
  const server=createApp({auth,bridge,secure});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(path,body,cookie,origin=secure?base.replace('http:','https:'):base)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
  const login=async()=>{const res=await post('/api/login',{password:'test-password'});assert.equal(res.status,200);return res.headers.get('set-cookie').split(';')[0];};
  return {base,post,login};
}
test('only Claude conversation URLs are accepted',()=>{
  assert.equal(conversationURL(null),'https://claude.ai/new');
  assert.equal(conversationURL('https://claude.ai/chat/abc-123'),'https://claude.ai/chat/abc-123');
  for(const url of ['http://claude.ai/chat/123','https://evil.test/chat/123','https://claude.ai/settings','https://claude.ai/chat/123?x=1'])assert.throws(()=>conversationURL(url));
});
test('login, streamed reply, session check and logout over HTTP',async t=>{
  const {base,post,login}=await fixture(t);
  assert.equal((await post('/api/chat',{text:'Привет'})).status,401);
  assert.equal((await post('/api/login',{password:'wrong'})).status,401);
  const cookie=await login();
  const session=await fetch(base+'/api/session',{headers:{Cookie:cookie}});assert.equal((await session.json()).authenticated,true);
  const res=await post('/api/chat',{text:'Привет'},cookie);assert.equal(res.status,200);
  const events=(await res.text()).trim().split('\n').map(JSON.parse);
  assert.equal(events[0].text,'Тестовый ответ');assert.equal(events.at(-1).type,'done');
  assert.equal((await post('/api/chat',{text:'hello',url:'https://evil.test'},cookie)).status,400);
  await post('/api/logout',{},cookie);
  assert.equal((await post('/api/chat',{text:'Привет'},cookie)).status,401);
});
test('reject cross-origin requests, enforce secure cookie and rate limit',async t=>{
  const {post}=await fixture(t,undefined,true);
  assert.equal((await post('/api/login',{password:'test-password'},null,'https://evil.test')).status,403);
  const good=await post('/api/login',{password:'test-password'});assert.match(good.headers.get('set-cookie'),/; Secure/);
  for(let i=0;i<10;i++)assert.equal((await post('/api/login',{password:'wrong'})).status,401);
  assert.equal((await post('/api/login',{password:'test-password'})).status,429);
});
test('reject parallel sends and report automation failures',async t=>{
  let release;
  const waiting=new Promise(resolve=>release=resolve);
  // Wait until the first request has entered the bridge before attempting the next.
  let entered;
  const started=new Promise(resolve=>entered=resolve);
  const {post:post2,login:login2}=await fixture(t,{send:async()=>{entered();await waiting;throw Error('Войдите в Claude');}});
  const cookie2=await login2();
  const first=post2('/api/chat',{text:'Привет'},cookie2);await started;
  assert.equal((await post2('/api/chat',{text:'Ещё'},cookie2)).status,409);
  release();const result=await first;
  assert.equal(JSON.parse((await result.text()).trim()).type,'error');
});
