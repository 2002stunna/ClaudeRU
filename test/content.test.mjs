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
  await context.addInitScript(()=>{window.events=[];window.chrome={runtime:{id:'clauderu-test',onMessage:{addListener:fn=>window.extensionHandler=fn},sendMessage:async event=>{window.events.push({...event,at:performance.now()});return{ok:true};}}};});
  const page=await context.newPage();await page.goto('https://claude.ai/chat/current-123');
  await page.addScriptTag({path:new URL('../extension/content.js',import.meta.url).pathname});
  const run=job=>page.evaluate(message=>new Promise(resolve=>window.extensionHandler({...message,type:'run',id:'test-job'},{id:'clauderu-test'},resolve)),job);
  return{page,run};
}
test('real DOM: inspect models, effort levels and sidebar without sending a message',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);const reply=await run({kind:'inspect'});
  assert.equal(reply.done,true);assert.deepEqual(reply.result.catalog.models,['Fable 5.1','Sonnet 5.5','Haiku 5.5']);
  assert.deepEqual(reply.result.catalog.efforts,['low','medium','high','xhigh','max']);
  assert.equal(reply.result.chats.length,2);assert.equal(await page.locator('[data-testid="assistant-message"]').count(),0);
});
test('real DOM: select model and effort, upload bytes, forward answer and generated files',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);
  const result=await run({kind:'chat',text:'Проверь файл',settings:{model:'Sonnet 5.5',effort:'high'},files:[{name:'remote.txt',type:'text/plain',data:Buffer.from('hello attachment').toString('base64')}]});
  assert.equal(result.done,true,result.error);assert.equal(await page.locator('#model-trigger').innerText(),'Sonnet 5.5 Высокий');
  assert.equal(await page.evaluate(()=>window.submittedFiles[0].text()),'hello attachment');
  assert.equal(await page.locator('[data-testid="user-message"]').innerText(),'Проверь файл');
  const events=await page.evaluate(()=>window.events);assert.ok(events.some(e=>e.type==='update'));
  const timing=await page.evaluate(()=>({submittedAt:window.submittedAt,finishedAt:performance.now()}));assert.ok(events.find(e=>e.type==='update').at-timing.submittedAt<1000,'first response update should arrive within one second');assert.ok(timing.finishedAt-timing.submittedAt<4000,'completed response should not incur the old multi-second idle delay');
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
  await page.locator('#chats button').filter({hasText:'Старый разговор'}).waitFor();
  assert.equal(await page.locator('select').count(),0);assert.ok(!(await page.locator('#model-toggle').textContent()).includes('Как в Claude'));
  await page.screenshot({path:'/tmp/clauderu-template-empty.png'});
  await page.locator('#model-toggle').click();await page.locator('#other-models-trigger').click();await page.locator('#model-submenu [data-model="Sonnet 5.5"]').click();await page.waitForFunction(()=>!document.querySelector('#model-toggle').disabled);
  await page.locator('#model-toggle').click();await page.locator('#effort-menu-trigger').click();await page.screenshot({path:'/tmp/clauderu-template-model-menu.png'});await page.locator('#effort-options [data-effort="high"]').click();await page.waitForFunction(()=>!document.querySelector('#model-toggle').disabled);
  await page.locator('#file-input').setInputFiles({name:'input.txt',mimeType:'text/plain',buffer:Buffer.from('input data')});await page.locator('#attachments strong').filter({hasText:'input.txt'}).waitFor();await page.waitForFunction(()=>!document.querySelector('#attach').disabled);
  await page.locator('#prompt').fill('Создай документ');await page.locator('#send').click();await page.locator('article.assistant .file-card strong').filter({hasText:'result.html'}).waitFor();
  await page.locator('article.assistant .file-card button').click();await page.locator('#file-preview').waitFor({state:'visible'});assert.equal(await page.locator('#preview-text').textContent(),generated);assert.equal(await page.evaluate(()=>window.untrustedExecuted),undefined);await page.locator('#close-preview').click();
  const promise=page.waitForEvent('download');await page.locator('article.assistant .file-card a').click();const download=await promise;assert.equal(await readFile(await download.path(),'utf8'),generated);
  await page.screenshot({path:'/tmp/clauderu-template-desktop.png'});
  await page.locator('#chats button').filter({hasText:'Старый разговор'}).click();await page.getByText('Сохранённый ответ',{exact:true}).waitFor();
  await page.setViewportSize({width:390,height:844});await page.locator('#toggle-sidebar').click();assert.ok(await page.locator('#sidebar').evaluate(n=>n.classList.contains('open')));await page.locator('#chats button').filter({hasText:'Готовый документ'}).click();await page.locator('article.assistant .file-card').waitFor();
  assert.equal(await page.locator('#model-label').textContent(),'Sonnet 5.5');assert.equal(await page.locator('#effort-label').textContent(),'Высокий');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  await page.screenshot({path:'/tmp/clauderu-template-mobile.png'});
  await page.locator('#chat-title-button').click();await page.locator('#rename-chat').click();await page.locator('#rename-title').fill('Мой документ');await page.locator('#rename-form button[type=submit]').click();await page.locator('#chat-title').filter({hasText:'Мой документ'}).waitFor();
  await page.locator('#chat-title-button').click();await page.locator('#pin-chat').click();await page.locator('#toggle-sidebar').click();await page.locator('#pinned-chats button').filter({hasText:'Мой документ'}).waitFor();await page.locator('#collapse-sidebar').click();
  await page.locator('#toggle-sidebar').click();await page.locator('#show-files').click();await page.locator('#files-library').waitFor({state:'visible'});assert.equal(await page.locator('#files-library .file-card').count(),1);await page.locator('#close-files').click();
  assert.deepEqual(errors,[]);
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
test('model menu reports a disconnected bridge instead of offering a fake default option',{skip:!executable},async t=>{
  const {createApp}=await import('../server.mjs');const {scryptSync}=await import('node:crypto');
  const bridge={status:{connected:false},execute:async()=>{throw Error('Расширение не подключено');}};
  const server=createApp({auth:{salt:'test',hash:scryptSync('test-password','test',64).toString('hex')},bridge});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('#password').fill('test-password');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
  await page.locator('#model-toggle').click();await page.locator('#catalog-error').waitFor({state:'visible'});assert.match(await page.locator('#catalog-error').textContent(),/не подключено/);
  await page.locator('#other-models-trigger').click();assert.equal(await page.locator('#model-submenu [role=menuitemradio]').count(),0);assert.equal(await page.locator('select').count(),0);
});
test('template stale frames are ignored and catalog discovery waits for the active composer',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);
  await page.evaluate(()=>{
    const stale=document.createElement('section');stale.hidden=true;stale.innerHTML='<button data-testid="model-selector-dropdown">Opus 999</button><div data-testid="assistant-message">stale private response</div><div data-testid="user-message">stale private question</div><div data-testid="chat-input" contenteditable="true">stale draft</div>';
    document.querySelector('main').prepend(stale);
    const button=document.querySelector('#model-trigger');const parent=button.parentElement;button.remove();setTimeout(()=>parent.append(button),500);
  });
  const inspected=await run({kind:'inspect'});assert.equal(inspected.done,true,inspected.error);assert.equal(inspected.result.catalog.current.model,'Fable 5.1');assert.equal(inspected.result.snapshot.messages.length,0);assert.ok(!JSON.stringify(inspected).includes('stale private'));
});
test('a rejected incompatible connection leaves the user message in the composer and out of history',{skip:!executable},async t=>{
  const {createApp}=await import('../server.mjs');const {scryptSync}=await import('node:crypto');let sent=false;
  const bridge={status:{connected:false,error:'Работает старая версия расширения. Обновите ClaudeRU.'},send:async()=>{sent=true;}};
  const server=createApp({auth:{salt:'test',hash:scryptSync('test-password','test',64).toString('hex')},bridge});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('#password').fill('test-password');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
  await page.locator('#prompt').fill('Не потеряй это сообщение');await page.locator('#send').click();await page.waitForFunction(()=>document.querySelector('#prompt').value==='Не потеряй это сообщение'&&!document.querySelector('#send').disabled);
  assert.equal(await page.locator('article').count(),0);assert.equal(sent,false);assert.match(await page.locator('#status').textContent(),/старая версия/);
  const histories=await page.evaluate(async()=>await(await fetch('/api/chats')).json());assert.ok(histories.chats.every(chat=>chat.messages.length===0));
});
test('connection status is fetched once per second without reloading the website',{skip:!executable},async t=>{
  const {createApp}=await import('../server.mjs');const {scryptSync}=await import('node:crypto');
  const server=createApp({auth:{salt:'test',hash:scryptSync('test-password','test',64).toString('hex')},bridge:{status:{connected:false}}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage(),polls=[];let navigations=0;
  page.on('request',r=>{if(r.url().endsWith('/api/bridge'))polls.push(performance.now());if(r.isNavigationRequest())navigations++;});
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('#password').fill('test-password');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
  await page.waitForTimeout(2400);assert.ok(polls.length>=3,'expected at least 3 status checks, got '+polls.length);assert.equal(navigations,1);
  for(let i=1;i<polls.length;i++)assert.ok(polls[i]-polls[i-1]<1600,'status checks should be approximately one second apart');
});
test('streaming updates the active answer while preserving previous message nodes',{skip:!executable},async t=>{
  const {createApp}=await import('../server.mjs');const {scryptSync}=await import('node:crypto');let next,finish;
  const nextPart=new Promise(r=>next=r),finished=new Promise(r=>finish=r);t.after(()=>{next();finish();});
  const bridge={status:{connected:true},execute:async()=>({catalog:{models:['Sonnet 5.5'],efforts:[],current:{model:'Sonnet 5.5'}},chats:[]}),send:async job=>{job.onUpdate({text:'Первая часть',url:'https://claude.ai/chat/stream-test'});await nextPart;job.onUpdate({text:'Первая часть. Продолжение.',url:'https://claude.ai/chat/stream-test'});await finished;}};
  const server=createApp({auth:{salt:'test',hash:scryptSync('test-password','test',64).toString('hex')},bridge});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('#password').fill('test-password');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
  await page.locator('#prompt').fill('Расскажи');await page.locator('#send').click();await page.getByText('Первая часть',{exact:true}).waitFor();
  await page.evaluate(()=>window.previousMessageNode=document.querySelector('article.user'));next();
  await page.getByText('Первая часть. Продолжение.',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.previousMessageNode===document.querySelector('article.user')),true);finish();await page.waitForFunction(()=>!document.querySelector('#model-toggle').disabled);
});
const tinyPNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKz8AAAAASUVORK5CYII=';
test('thumbnail-only image uploads are submitted once after processing and editor remount',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);
  await page.evaluate(()=>{
    const upload=document.querySelector('#upload'),send=document.querySelector('#send'),original=send.onclick;
    window.sendCount=0;send.onclick=()=>{window.sendCount++;window.clickWhileUploading=!!document.querySelector('[role="progressbar"]');original();};
    upload.onchange=event=>{
      const image=document.createElement('img');image.src=URL.createObjectURL(event.target.files[0]);image.width=96;image.height=96;
      document.querySelector('#uploads').replaceChildren(image);
      const progress=document.createElement('div');progress.setAttribute('role','progressbar');progress.textContent='Обработка';document.querySelector('#uploads').append(progress);send.disabled=true;
      setTimeout(()=>{const old=document.querySelector('[contenteditable]'),replacement=old.cloneNode(false);old.replaceWith(replacement);progress.remove();send.disabled=false;window.processingFinished=true;},900);
    };
  });
  const result=await run({kind:'chat',text:'',files:[{name:'карта.png',type:'image/png',data:tinyPNG}]});
  assert.equal(result.done,true,result.error);assert.equal(await page.evaluate(()=>window.sendCount),1);assert.equal(await page.evaluate(()=>window.clickWhileUploading),false);
  assert.equal(await page.locator('[data-testid="user-message"]').innerText(),'Посмотри прикреплённые файлы.');
  assert.equal(await page.evaluate(()=>window.submittedFiles[0].name),'карта.png');
  assert.equal(await page.evaluate(()=>window.processingFinished),true);
});
test('a file rejected during processing stays in draft and is never submitted',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);
  await page.evaluate(()=>{window.sendCount=0;document.querySelector('#send').onclick=()=>window.sendCount++;document.querySelector('#upload').onchange=()=>{const error=document.createElement('div');error.setAttribute('role','alert');error.textContent='Не удалось загрузить файл';document.querySelector('#uploads').append(error);};});
  const result=await run({kind:'chat',text:'Изучи файл',files:[{name:'image.png',type:'image/png',data:tinyPNG}]});
  assert.match(result.error,/не принял файл/);assert.equal(result.notSent,true);assert.equal(await page.evaluate(()=>window.sendCount),0);
});
test('existing image attachment is preserved without uploading it again',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);
  await page.evaluate(data=>{window.changeCount=0;document.querySelector('#upload').onchange=()=>window.changeCount++;const img=document.createElement('img');img.src='data:image/png;base64,'+data;img.width=80;img.height=80;document.querySelector('#uploads').append(img);},tinyPNG);
  const result=await run({kind:'chat',text:'Проверь',files:[{name:'image.png',type:'image/png',data:tinyPNG}]});
  assert.match(result.error,/остались неотправленные вложения/);assert.equal(result.notSent,true);assert.equal(await page.evaluate(()=>window.changeCount),0);assert.equal(await page.locator('#uploads img').count(),1);
});
test('a click without a new conversation turn is reported without clicking send twice',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);
  await page.evaluate(()=>{window.clicks=0;document.querySelector('#send').onclick=()=>window.clicks++;});
  const result=await run({kind:'chat',text:'Сообщение'});
  assert.match(result.error,/не подтвердил отправку/);assert.equal(result.notSent,false);assert.equal(await page.evaluate(()=>window.clicks),1);assert.equal(await page.locator('[contenteditable]').innerText(),'Сообщение');
});
test('an upload failure reported by the extension restores the website text and file draft',{skip:!executable},async t=>{
  const {createApp}=await import('../server.mjs');const {scryptSync}=await import('node:crypto');
  const bridge={status:{connected:true},execute:async()=>({catalog:{models:['Sonnet 5.5'],efforts:[],current:{model:'Sonnet 5.5'}},chats:[]}),send:async()=>{const error=Error('Claude не принял файл');error.notSent=true;throw error;}};
  const server=createApp({auth:{salt:'test',hash:scryptSync('test-password','test',64).toString('hex')},bridge});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('#password').fill('test-password');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});await page.locator('#model-label').filter({hasText:'Sonnet 5.5'}).waitFor();
  await page.locator('#file-input').setInputFiles({name:'image.png',mimeType:'image/png',buffer:Buffer.from(tinyPNG,'base64')});await page.locator('#attachments strong').filter({hasText:'image.png'}).waitFor();await page.waitForFunction(()=>!document.querySelector('#attach').disabled);
  await page.locator('#prompt').fill('Проверь изображение');await page.locator('#send').click();await page.waitForFunction(()=>document.querySelector('#prompt').value==='Проверь изображение'&&document.querySelectorAll('#attachments .file-card').length===1&&!document.querySelector('#model-toggle').disabled);
  assert.equal(await page.locator('article').count(),0);assert.match(await page.locator('#status').textContent(),/не принял файл/);const data=await page.evaluate(async()=>await(await fetch('/api/chats')).json());assert.equal(data.chats[0].messages.length,0);
});
