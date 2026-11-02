import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {chromium} from 'playwright';
let browser;
let executable=process.env.CHROMIUM_EXECUTABLE||chromium.executablePath();
try{await access(executable);}catch{try{await access('/usr/bin/chromium');executable='/usr/bin/chromium';}catch{executable=null;}}
before(async()=>{if(executable)browser=await chromium.launch({executablePath:executable,headless:true});});
after(async()=>await browser?.close());
const html=await readFile(new URL('./fixtures/claude.html',import.meta.url),'utf8');
async function fixture(t){
  const context=await browser.newContext();t.after(()=>context.close());
  await context.route('https://claude.ai/**',route=>route.fulfill({status:200,contentType:route.request().url().includes('/files/')?'text/csv':'text/html',body:route.request().url().includes('/files/')?'column\nvalue':html}));
  await context.addInitScript(()=>{window.events=[];window.chrome={runtime:{id:'clauderu-test',onMessage:{addListener:fn=>window.extensionHandler=fn},sendMessage:async event=>{window.events.push(event);return{ok:true};}}};});
  const page=await context.newPage();await page.goto('https://claude.ai/chat/current-123');
  await page.addScriptTag({path:new URL('../extension/content.js',import.meta.url).pathname});
  const run=job=>page.evaluate(message=>new Promise(resolve=>window.extensionHandler({...message,type:'run',id:'test-job'},{id:'clauderu-test'},resolve)),job);
  return{page,run};
}
test('real DOM: inspect models, effort levels and sidebar without sending a message',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);const reply=await run({kind:'inspect'});
  assert.equal(reply.done,true);assert.deepEqual(reply.result.catalog.models,['Fable 5.1','Sonnet 5.5','Haiku 5.5']);
  assert.deepEqual(reply.result.catalog.efforts,['low','medium','high','xhigh','max']);
  assert.equal(reply.result.chats.length,2);assert.equal(await page.locator('.font-claude-response').count(),0);
});
test('real DOM: select model and effort, upload bytes, forward answer and generated files',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);
  const result=await run({kind:'chat',text:'Проверь файл',settings:{model:'Sonnet 5.5',effort:'high'},files:[{name:'remote.txt',type:'text/plain',data:Buffer.from('hello attachment').toString('base64')}]});
  assert.equal(result.done,true,result.error);assert.equal(await page.locator('#model-trigger').innerText(),'Sonnet 5.5 Высокий');
  assert.equal(await page.locator('#upload').evaluate(n=>n.files[0].text()),'hello attachment');
  assert.equal(await page.locator('[data-testid="user-message"]').innerText(),'Проверь файл');
  const events=await page.evaluate(()=>window.events);assert.ok(events.some(e=>e.type==='update'));
  const files=events.filter(e=>e.type==='file').map(e=>e.file);
  assert.equal(files.length,2);assert.equal(files[0].name,'result.csv');assert.equal(Buffer.from(files[0].data,'base64').toString(),'column\nvalue');
  assert.equal(files[1].name,'code-1.py');assert.equal(Buffer.from(files[1].data,'base64').toString(),'print("hello")');
});
test('real DOM: unavailable model and an existing draft both prevent sending',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);
  let result=await run({kind:'chat',text:'Не отправлять',settings:{model:'Missing 99'}});assert.match(result.error,/не найдена/);
  assert.equal(await page.locator('[data-testid="user-message"]').count(),0);
  await page.locator('[contenteditable]').fill('Мой черновик');
  result=await run({kind:'chat',text:'Не отправлять'});assert.match(result.error,/черновик/);
  assert.equal(await page.locator('[contenteditable]').innerText(),'Мой черновик');
});

test('web interface: sync sidebar, choose settings, upload, download and safely preview a generated file',{skip:!executable},async t=>{
  const {createApp}=await import('../server.mjs');const {scryptSync}=await import('node:crypto');
  const generated='<script>window.untrustedExecuted = true</script><h1>Hello</h1>';
  const bridge={status:{connected:true},
    execute:async job=>job.kind==='open'?{snapshot:{url:job.url,title:'Старый разговор',messages:[{role:'user',text:'Старый вопрос'},{role:'assistant',text:'Сохранённый ответ'}]}}:{catalog:{models:['Sonnet 5.5','Haiku 5.5'],efforts:['low','medium','high'],current:{model:job.settings?.model||'Sonnet 5.5',effort:'medium'}},chats:[{title:'Старый разговор',url:'https://claude.ai/chat/old-123'}]},
    send:async job=>{assert.equal(job.settings.model,'Sonnet 5.5');assert.equal(job.settings.effort,'high');assert.equal(job.files[0].name,'input.txt');job.onUpdate({text:'Создал документ.\n```html\n<h1>Hello</h1>\n```',url:'https://claude.ai/chat/created-456'});await job.onFile({name:'result.html',type:'text/html',data:Buffer.from(generated).toString('base64')});return{title:'Готовый документ'};}};
  const server=createApp({auth:{salt:'test',hash:scryptSync('test-password','test',64).toString('hex')},bridge});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  const context=await browser.newContext({viewport:{width:1280,height:900},acceptDownloads:true});t.after(()=>context.close());const page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('#password').fill('test-password');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
  await page.locator('#sync').click();await page.locator('#chats button').filter({hasText:'Старый разговор'}).waitFor();
  await page.locator('#model').selectOption('Sonnet 5.5');await page.waitForFunction(()=>!document.querySelector('#effort').disabled);
  await page.locator('#effort').selectOption('high');await page.waitForFunction(()=>!document.querySelector('#send').disabled);
  await page.locator('#file-input').setInputFiles({name:'input.txt',mimeType:'text/plain',buffer:Buffer.from('input data')});await page.locator('#attachments strong').filter({hasText:'input.txt'}).waitFor();await page.waitForFunction(()=>!document.querySelector('#send').disabled);
  await page.locator('#prompt').fill('Создай документ');await page.locator('#send').click();await page.locator('article.assistant .file-card strong').filter({hasText:'result.html'}).waitFor();
  await page.locator('article.assistant .file-card button').click();await page.locator('#file-preview').waitFor({state:'visible'});assert.equal(await page.locator('#preview-text').textContent(),generated);assert.equal(await page.evaluate(()=>window.untrustedExecuted),undefined);await page.locator('#close-preview').click();
  const promise=page.waitForEvent('download');await page.locator('article.assistant .file-card a').click();const download=await promise;assert.equal(await readFile(await download.path(),'utf8'),generated);
  await page.screenshot({path:'/tmp/clauderu-workspace-desktop.png'});
  await page.locator('#chats button').filter({hasText:'Старый разговор'}).click();await page.getByText('Сохранённый ответ',{exact:true}).waitFor();
  await page.setViewportSize({width:390,height:844});await page.locator('#toggle-sidebar').click();assert.ok(await page.locator('#sidebar').evaluate(n=>n.classList.contains('open')));await page.locator('#chats button').filter({hasText:'Готовый документ'}).click();await page.locator('article.assistant .file-card').waitFor();
  assert.equal(await page.locator('#model').inputValue(),'Sonnet 5.5');assert.equal(await page.locator('#effort').inputValue(),'high');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  await page.screenshot({path:'/tmp/clauderu-workspace-mobile.png'});assert.deepEqual(errors,[]);
});
test('real DOM: missing effort option prevents sending instead of silently using another setting',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);await page.locator('[data-effort="Максимальный"]').evaluate(n=>n.remove());
  const result=await run({kind:'chat',text:'Не отправлять',settings:{effort:'max'}});
  assert.match(result.error,/недоступен/);assert.equal(await page.locator('[data-testid="user-message"]').count(),0);
});

test('real DOM: generated download keeps the original filename from response headers',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);
  await page.route('https://claude.ai/files/signed-data',route=>route.fulfill({contentType:'text/csv',headers:{'Content-Disposition':"attachment; filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82.csv"},body:'a,b'}));
  await page.locator('#transcript').evaluate(n=>n.innerHTML='<div data-testid="user-message">Создай таблицу</div><div class="font-claude-response"><a href="/files/signed-data">Скачать</a></div>');
  const result=await run({kind:'open'});assert.equal(result.done,true,result.error);
  assert.equal(result.result.snapshot.messages.at(-1).files[0].name,'отчёт.csv');
  assert.equal(Buffer.from(result.result.snapshot.messages.at(-1).files[0].data,'base64').toString(),'a,b');
});
