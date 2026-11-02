import {mockCatalog} from './helpers/catalog.mjs';
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
  await context.addInitScript(()=>{const workerClock=window.setTimeout.bind(window);window.events=[];window.chrome={runtime:{id:'clauderu-test',onMessage:{addListener:fn=>window.extensionHandler=fn},sendMessage:async event=>{if(event.type==='wait')return new Promise(resolve=>workerClock(()=>resolve({ok:true}),event.ms));window.events.push({...event,at:performance.now()});return{ok:true};}}};});
  const page=await context.newPage();await page.goto('https://claude.ai/chat/current-123');
  await page.addScriptTag({path:new URL('../extension/content.js',import.meta.url).pathname});
  const run=job=>page.evaluate(message=>new Promise(resolve=>window.extensionHandler({...message,type:'run',id:'test-job'},{id:'clauderu-test'},resolve)),job);
  return{page,run};
}
test('real DOM: inspect models, effort levels and sidebar without sending a message',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);const reply=await run({kind:'inspect'});
  assert.equal(reply.done,true);assert.deepEqual(reply.result.catalog.models,['Fable 5.1','Opus 5.5','Sonnet 5.5','Haiku 5.5','Fable 5','Opus 5']);
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
    execute:async job=>job.kind==='manage'?{applied:true}:job.kind==='open'?{snapshot:{url:job.url,title:job.url==='https://claude.ai/chat/old-123'?'Старый разговор':'',messages:job.url==='https://claude.ai/chat/old-123'?[{role:'user',text:'Старый вопрос'},{role:'assistant',text:'Сохранённый ответ'}]:[]},catalog:mockCatalog({models:['Sonnet 5.5','Haiku 5.5'],efforts:['low','medium','high'],current:{model:'Sonnet 5.5',effort:job.url==='https://claude.ai/chat/created-456'?'high':'medium'}})}:{catalog:mockCatalog({models:['Sonnet 5.5','Haiku 5.5'],efforts:['low','medium','high'],current:{model:job.settings?.model||'Sonnet 5.5',effort:job.settings?.effort||'medium'}}),chats:[{title:'Старый разговор',url:'https://claude.ai/chat/old-123'}]},
    send:async job=>{assert.equal(job.settings.model,'Sonnet 5.5');assert.equal(job.settings.effort,'high');assert.equal(job.files[0].name,'input.txt');job.onUpdate({text:'Создал документ.\n```html\n<h1>Hello</h1>\n```',url:'https://claude.ai/chat/created-456'});await job.onFile({name:'result.html',type:'text/html',data:Buffer.from(generated).toString('base64')});return{title:'Готовый документ'};}};
  const server=createApp({auth:{salt:'test',hash:scryptSync('test-password','test',64).toString('hex')},bridge});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  const context=await browser.newContext({viewport:{width:1280,height:900},acceptDownloads:true});t.after(()=>context.close());const page=await context.newPage();
  const errors=[],openRequests=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().endsWith('/api/chats/open'))openRequests.push(r.postDataJSON());});
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('#password').fill('test-password');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
  await page.locator('#chats button').filter({hasText:'Старый разговор'}).waitFor();await page.waitForFunction(()=>!document.querySelector('#refresh-chat').disabled);assert.ok(openRequests.every(r=>r.collectArtifacts===false));await page.locator('#refresh-chat').click();await page.waitForFunction(()=>!document.querySelector('#refresh-chat').disabled);assert.equal(openRequests.at(-1).collectArtifacts,true);await page.locator('#new-chat').click();await page.waitForFunction(()=>!document.querySelector('#model-toggle').disabled);
  assert.equal(await page.locator('select').count(),0);assert.ok(!(await page.locator('#model-toggle').textContent()).includes('Как в Claude'));
  await page.screenshot({path:'/tmp/clauderu-template-empty.png'});
  await page.locator('#model-toggle').click();await page.locator('#other-models-trigger').click();await page.locator('#model-submenu [data-model="Sonnet 5.5"]').click();await page.waitForFunction(()=>!document.querySelector('#model-toggle').disabled);
  await page.locator('#model-toggle').click();await page.locator('#effort-menu-trigger').click();await page.screenshot({path:'/tmp/clauderu-template-model-menu.png'});await page.locator('#effort-options [data-effort="high"]').click();await page.waitForFunction(()=>!document.querySelector('#model-toggle').disabled);
  await page.locator('#file-input').setInputFiles({name:'input.txt',mimeType:'text/plain',buffer:Buffer.from('input data')});await page.locator('#attachments strong').filter({hasText:'input.txt'}).waitFor();await page.waitForFunction(()=>!document.querySelector('#attach').disabled);assert.equal(await page.locator('#status').isHidden(),true);
  await page.locator('#prompt').fill('Создай документ');await page.locator('#send').click();await page.locator('article.assistant .file-card strong').filter({hasText:'result.html'}).waitFor();
  await page.locator('article.assistant .file-card button').click();await page.locator('#file-preview').waitFor({state:'visible'});assert.equal(await page.locator('#preview-text').textContent(),generated);assert.equal(await page.evaluate(()=>window.untrustedExecuted),undefined);await page.locator('#close-preview').click();
  const promise=page.waitForEvent('download');await page.locator('article.assistant .file-card a').click();const download=await promise;assert.equal(await readFile(await download.path(),'utf8'),generated);
  await page.setViewportSize({width:1728,height:1000});assert.ok(await page.locator('#composer').evaluate(n=>n.getBoundingClientRect().width)>=1100);await page.screenshot({path:'/tmp/clauderu-template-desktop.png'});
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
  const bridge={status:{connected:true},execute:async()=>({catalog:mockCatalog({models:['Sonnet 5.5'],efforts:[],current:{model:'Sonnet 5.5'}}),chats:[]}),send:async job=>{job.onUpdate({text:'Первая часть',url:'https://claude.ai/chat/stream-test'});await nextPart;job.onUpdate({text:'Первая часть. Продолжение.',url:'https://claude.ai/chat/stream-test'});await finished;}};
  const server=createApp({auth:{salt:'test',hash:scryptSync('test-password','test',64).toString('hex')},bridge});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('#password').fill('test-password');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
  await page.locator('#prompt').fill('Расскажи');await page.locator('#send').click();await page.getByText('Первая часть',{exact:true}).waitFor();assert.equal(await page.locator('#status').isHidden(),true);
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
  const bridge={status:{connected:true},execute:async()=>({catalog:mockCatalog({models:['Sonnet 5.5'],efforts:[],current:{model:'Sonnet 5.5'}}),chats:[]}),send:async()=>{const error=Error('Claude не принял файл');error.notSent=true;throw error;}};
  const server=createApp({auth:{salt:'test',hash:scryptSync('test-password','test',64).toString('hex')},bridge});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('#password').fill('test-password');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});await page.locator('#model-label').filter({hasText:'Sonnet 5.5'}).waitFor();
  await page.locator('#file-input').setInputFiles({name:'image.png',mimeType:'image/png',buffer:Buffer.from(tinyPNG,'base64')});await page.locator('#attachments strong').filter({hasText:'image.png'}).waitFor();await page.waitForFunction(()=>!document.querySelector('#attach').disabled);
  await page.locator('#prompt').fill('Проверь изображение');await page.locator('#send').click();await page.waitForFunction(()=>document.querySelector('#prompt').value==='Проверь изображение'&&document.querySelectorAll('#attachments .file-card').length===1&&!document.querySelector('#model-toggle').disabled);
  assert.equal(await page.locator('article').count(),0);assert.match(await page.locator('#status').textContent(),/не принял файл/);const data=await page.evaluate(async()=>await(await fetch('/api/chats')).json());assert.equal(data.chats[0].messages.length,0);
});

test('model and effort changes are applied immediately and options avoid a full model rescan',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);await run({kind:'inspect'});
  await page.evaluate(()=>{window.otherMenuOpens=0;document.querySelector('#other-trigger').addEventListener('click',()=>window.otherMenuOpens++);});
  const started=performance.now();
  let reply=await run({kind:'options',settings:{model:'Sonnet 5.5'}});assert.equal(reply.done,true,reply.error);assert.equal(reply.result.catalog.current.model,'Sonnet 5.5');
  reply=await run({kind:'options',settings:{effort:'max'}});assert.equal(reply.done,true,reply.error);assert.equal(reply.result.catalog.current.effort,'max');assert.equal(await page.locator('#model-trigger').innerText(),'Sonnet 5.5 Максимальный');
  assert.equal(await page.evaluate(()=>window.otherMenuOpens),1,'only the requested model lookup should open Other models');assert.ok(performance.now()-started<2500,'model and effort operations should not incur a ten second menu scan');assert.equal(await page.locator('[data-testid="user-message"]').count(),0);
});
test('chat opening reads the actual model, effort and quota notice; sending does not click a blocked model',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);
  const notice='У вас закончились кредиты использования. Купите еще, чтобы и дальше использовать Fable, или смените модель, чтобы продолжить.';
  await page.evaluate(text=>{const n=document.createElement('div');n.dataset.testid='hub-composer-notices';n.textContent=text;document.querySelector('main').append(n);window.clicks=0;document.querySelector('#send').onclick=()=>window.clicks++;},notice);
  const opened=await run({kind:'open'});assert.equal(opened.result.snapshot.state.model,'Fable 5.1');assert.equal(opened.result.snapshot.state.effort,'medium');assert.equal(opened.result.snapshot.state.blocked,notice);
  const sent=await run({kind:'chat',text:'Не отправлять'});assert.equal(sent.notSent,true);assert.equal(sent.state.model,'Fable 5.1');assert.equal(sent.error,notice);assert.equal(await page.evaluate(()=>window.clicks),0);
  await page.locator('[data-testid="hub-composer-notices"]').evaluate(n=>n.remove());
});
test('quota rejection after clicking exits promptly without resending or waiting four minutes',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);await page.evaluate(()=>{window.clicks=0;document.querySelector('#send').onclick=()=>{window.clicks++;const notice=document.createElement('div');notice.setAttribute('role','alert');notice.textContent='You are out of credits. Switch models to continue.';document.querySelector('main').append(notice);};});
  const start=performance.now(),reply=await run({kind:'chat',text:'Проверка'});
  assert.match(reply.error,/out of credits/);assert.equal(reply.notSent,true);assert.equal(await page.evaluate(()=>window.clicks),1);assert.ok(performance.now()-start<2000);
  const state=await run({kind:'state'});assert.equal(state.done,true);assert.match(state.result.state.blocked,/credits/);
});
test('quota text inside conversation history never blocks a new request',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);await page.locator('#transcript').evaluate(n=>n.innerHTML='<div data-testid="user-message"><p>У вас закончились кредиты использования</p></div>');
  const result=await run({kind:'chat',text:'Новый вопрос'});assert.equal(result.done,true,result.error);
});

async function installChatActions(page){
  await page.evaluate(()=>{
    const link=document.querySelector('aside a'),row=document.createElement('div');link.replaceWith(row);row.append(link);
    const more=document.createElement('button');more.setAttribute('aria-label','Дополнительные параметры');row.append(more);
    const menu=document.createElement('div');menu.setAttribute('role','menu');menu.hidden=true;document.body.append(menu);let pinned=false;
    const closeMenus=()=>document.querySelectorAll('[role=menu]').forEach(n=>n.hidden=true);
    const item=(text,click)=>{const b=document.createElement('button');b.setAttribute('role','menuitem');b.textContent=text;b.onclick=()=>{closeMenus();click?.();};menu.append(b);};
    more.onclick=()=>{menu.replaceChildren();menu.hidden=false;
      item('Отметить как непрочитанное',()=>row.dataset.unread='true');item(pinned?'Открепить':'Закрепить',()=>pinned=!pinned);
      item('Переименовать',()=>{const dialog=document.createElement('div');dialog.setAttribute('role','dialog');const input=document.createElement('input');input.value=link.textContent;const save=document.createElement('button');save.textContent='Сохранить';save.onclick=()=>{link.textContent=input.value;dialog.remove();};dialog.append(input,save);document.body.append(dialog);});
      item('Переместить в группу',()=>{const submenu=document.createElement('div');submenu.setAttribute('role','menu');const group=document.createElement('button');group.setAttribute('role','menuitemradio');group.textContent='Работа';group.onclick=()=>{row.dataset.group='Работа';submenu.remove();};submenu.append(group);document.body.append(submenu);});
      item('Архивировать',()=>row.remove());item('Удалить',()=>{const dialog=document.createElement('div');dialog.setAttribute('role','alertdialog');const confirm=document.createElement('button');confirm.textContent='Удалить';confirm.onclick=()=>{row.remove();dialog.remove();};dialog.append(confirm);document.body.append(dialog);});
    };
  });
}
test('native chat actions rename, pin, mark unread, move to a real group and archive',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);await installChatActions(page);
  for(const action of [{action:'rename',title:'Новое имя'},{action:'pin'},{action:'unpin'},{action:'unread'}]){const result=await run({kind:'manage',url:'https://claude.ai/chat/current-123',...action});assert.equal(result.result?.applied,true,result.error);}
  assert.equal(await page.locator('aside a').first().textContent(),'Новое имя');assert.equal(await page.locator('aside a').first().evaluate(n=>n.parentElement.dataset.unread),'true');
  let result=await run({kind:'manage',action:'move',url:'https://claude.ai/chat/current-123'});assert.deepEqual(result.result.groups,['Работа']);
  result=await run({kind:'manage',action:'move',group:'Работа',url:'https://claude.ai/chat/current-123'});assert.equal(result.result?.applied,true,result.error);assert.equal(await page.locator('aside a').first().evaluate(n=>n.parentElement.dataset.group),'Работа');
  result=await run({kind:'manage',action:'archive',url:'https://claude.ai/chat/current-123'});assert.equal(result.result?.applied,true,result.error);assert.equal(await page.locator('aside a[href="/chat/current-123"]').count(),0);
});
test('native delete accepts the requested confirmation and verifies removal from the sidebar',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);await installChatActions(page);const result=await run({kind:'manage',action:'delete',url:'https://claude.ai/chat/current-123'});assert.equal(result.result?.applied,true,result.error);assert.equal(await page.locator('aside a[href="/chat/current-123"]').count(),0);
});

test('web UI shows the true limited model, applies effort in Claude, and a new chat stays usable during another response',{skip:!executable},async t=>{
  const {createApp}=await import('../server.mjs'),{scryptSync}=await import('node:crypto');let release,started;
  const holding=new Promise(r=>release=r),entered=new Promise(r=>started=r);t.after(()=>release());const observed=new Map(),jobs=[];
  const read=job=>{if(!observed.has(job.chatId))observed.set(job.chatId,{model:job.url?.endsWith('/limited')?'Fable 5.1':'Haiku 5.5',effort:'medium',blocked:job.url?.endsWith('/limited')?'У вас закончились кредиты использования. Смените модель, чтобы продолжить.':'',streaming:false});return observed.get(job.chatId);};
  const bridge={status:{connected:true},execute:async job=>{
    jobs.push(job);const state=read(job);if(job.kind==='state')return{state};
    if(job.kind==='options'){Object.assign(state,job.settings);state.blocked=state.model==='Fable 5.1'?'Закончились кредиты':'';}
    return{catalog:mockCatalog({models:['Fable 5.1','Sonnet 5.5','Haiku 5.5'],efforts:['medium','high'],current:state}),chats:[{url:'https://claude.ai/chat/limited',title:'Первый разговор'}],...(job.kind==='open'?{snapshot:{url:job.url,messages:[],state}}:{})};
  },send:async job=>{if(job.text==='Первый запрос'){job.onUpdate({text:'Ответ первого чата',url:'https://claude.ai/chat/limited'});started();await holding;}else job.onUpdate({text:'Ответ второго чата',url:'https://claude.ai/chat/second'});return{title:job.text==='Первый запрос'?'Первый разговор':'Второй разговор',state:{...read(job),streaming:false}};}};
  const server=createApp({auth:{salt:'test',hash:scryptSync('pw','test',64).toString('hex')},bridge});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('#password').fill('pw');await page.locator('#login-form button').click();
  await page.locator('#model-label').filter({hasText:'Fable 5.1'}).waitFor();await page.locator('#prompt').fill('Первый запрос');assert.equal(await page.locator('#send').isDisabled(),true);assert.match(await page.locator('#claude-notice').textContent(),/закончились кредиты/);assert.equal(await page.locator('#model-toggle').isEnabled(),true);
  await page.locator('#model-toggle').click();await page.locator('#other-models-trigger').click();await page.locator('[data-model="Sonnet 5.5"]').click();await page.waitForFunction(()=>!document.querySelector('#model-toggle').disabled);
  await page.locator('#model-toggle').click();await page.locator('#effort-menu-trigger').click();await page.locator('[data-effort="high"]').click();await page.waitForFunction(()=>document.querySelector('#effort-label').textContent==='Высокий'&&!document.querySelector('#send').disabled);
  assert.ok(jobs.some(j=>j.kind==='options'&&j.settings.effort==='high'));await page.locator('#send').click();await entered;
  await page.locator('#new-chat').click();await page.waitForFunction(()=>document.querySelector('#model-label').textContent==='Haiku 5.5'&&!document.querySelector('#model-toggle').disabled);assert.equal(await page.locator('#claude-notice').isHidden(),true);
  await page.locator('#prompt').fill('Второй запрос');await page.locator('#send').click();await page.getByText('Ответ второго чата',{exact:true}).waitFor();assert.equal(await page.getByText('Ответ первого чата',{exact:true}).count(),0);
  await page.waitForFunction(()=>!document.querySelector('#model-toggle').disabled);release();await page.locator('#chats .chat-row>button:first-child').filter({hasText:'Первый разговор'}).click();await page.getByText('Ответ первого чата',{exact:true}).waitFor();assert.equal(await page.getByText('Ответ второго чата',{exact:true}).count(),0);
});

test('opening a chat does not open artifacts or show export warnings automatically',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);await page.evaluate(()=>{document.querySelector('#transcript').innerHTML='<div data-testid="assistant-message">Ответ сохранён<button data-testid="artifact-button">Документ</button></div>';window.artifactClicks=0;document.querySelector('[data-testid="artifact-button"]').onclick=()=>window.artifactClicks++;});
  const result=await run({kind:'open'});assert.equal(result.done,true,result.error);assert.deepEqual(result.result.warnings,[]);assert.equal(await page.evaluate(()=>window.artifactClicks),0);assert.match(result.result.snapshot.messages.at(-1).text,/Ответ сохранён/);
});
test('explicit artifact export waits for the new panel and its code instead of exporting a stale artifact',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);await page.evaluate(()=>{
    document.querySelector('#transcript').innerHTML='<div data-testid="assistant-message">Документ<button data-testid="artifact-button" aria-controls="current-artifact">Открыть артефакт</button></div>';
    const panel=document.createElement('div');panel.id='current-artifact';panel.dataset.testid='artifact-panel';panel.innerHTML='<pre><code class="language-python">old_private_source()</code></pre>';document.body.append(panel);
    document.querySelector('[data-testid="artifact-button"]').onclick=()=>setTimeout(()=>{panel.innerHTML='<button role="tab">Код</button>';panel.querySelector('button').onclick=()=>setTimeout(()=>{const pre=document.createElement('pre');pre.innerHTML='<code class="language-python">new_document()</code>';panel.append(pre);},450);},650);
  });
  const result=await run({kind:'open',collectArtifacts:true});assert.equal(result.done,true,result.error);assert.deepEqual(result.result.warnings,[]);
  const files=result.result.snapshot.messages.at(-1).files;assert.equal(files.length,1);assert.equal(files[0].name,'code-1.py');assert.equal(Buffer.from(files[0].data,'base64').toString(),'new_document()');assert.ok(!JSON.stringify(result).includes('old_private_source'));
});
test('an unsupported artifact has a plain export warning only on explicit refresh',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);await page.evaluate(()=>{document.querySelector('#transcript').innerHTML='<div data-testid="assistant-message">Ответ<button data-testid="artifact-button">Документ</button></div>';document.querySelector('[data-testid="artifact-button"]').onclick=()=>{const panel=document.createElement('div');panel.dataset.testid='artifact-panel';panel.textContent='Предпросмотр документа';document.body.append(panel);};});
  const result=await run({kind:'open',collectArtifacts:true});assert.equal(result.done,true,result.error);assert.equal(result.result.warnings.length,1);assert.match(result.result.warnings[0],/Не удалось добавить файл/);assert.ok(!result.result.warnings[0].includes('разметке'));assert.equal(result.result.snapshot.messages.at(-1).text,'Ответ');
});
test('old open artifact panels and artifact navigation buttons are not collected from unrelated messages',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);await page.evaluate(()=>{
    document.querySelector('#transcript').innerHTML='<div data-testid="assistant-message">Обычный ответ</div>';const panel=document.createElement('div');panel.dataset.testid='artifact-panel';panel.innerHTML='<pre><code>old_private_source()</code></pre>';document.body.append(panel);
    const nav=document.createElement('button');nav.setAttribute('aria-label','Артефакты');nav.textContent='Артефакты';document.querySelector('main').append(nav);
  });
  let result=await run({kind:'open',collectArtifacts:true});assert.deepEqual(result.result.snapshot.messages.at(-1).files,[]);assert.deepEqual(result.result.warnings,[]);
  await page.locator('#transcript').evaluate(n=>n.replaceChildren());result=await run({kind:'open',collectArtifacts:true});assert.deepEqual(result.result.warnings,[]);
});

async function installEffortProfiles(page){
  await page.evaluate(()=>{
    const profiles={'Fable 5.1':['Низкий','Средний','Высокий','Сверхвысокий','Максимальный'],'Opus 5.5':['Низкий','Средний','Высокий','Максимальный'],'Sonnet 5.5':['Низкий','Средний','Высокий'],'Haiku 5.5':[],'Fable 5':['Средний','Высокий'],'Opus 5':['Низкий','Средний']};window.levelReads={};window.modelMenuOpens=0;
    for(const name of ['Opus 5.5','Fable 5','Opus 5','Opus 999']){const button=document.createElement('button');button.setAttribute('role','menuitemradio');button.dataset.model=name;button.textContent=name;button.onclick=()=>{model=name;refresh();close();};document.querySelector('#other-menu').append(button);}
    const original=refresh;refresh=()=>{const values=profiles[model]||[];if(values.length&&!values.includes(effort))effort=values[0];original();const trigger=document.querySelector('#effort-menu-trigger');trigger.hidden=values.length===0;document.querySelectorAll('[data-effort]').forEach(n=>n.hidden=!values.includes(n.dataset.effort));if(!values.length){document.querySelector('#model-trigger').textContent=model;document.querySelector('#model-trigger').setAttribute('aria-label','Модель: '+model);}};
    document.querySelector('#effort-menu-trigger').onclick=()=>{window.levelReads[model]=(window.levelReads[model]||0)+1;document.querySelector('#effort-menu').hidden=false;};
    document.querySelector('#model-trigger').addEventListener('click',()=>window.modelMenuOpens++);refresh();
  });
}
test('effort levels are learned once for the six allowed models and reused across model switches and page reloads',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);await installEffortProfiles(page);
  const reply=await run({kind:'catalog'});assert.equal(reply.done,true,reply.error);const catalog=reply.result.catalog,cache={version:1,byModel:catalog.byModel};
  assert.deepEqual(catalog.models,['Fable 5.1','Opus 5.5','Sonnet 5.5','Haiku 5.5','Fable 5','Opus 5']);assert.equal(catalog.current.model,'Fable 5.1');assert.equal(catalog.current.effort,'medium');
  assert.deepEqual(cache.byModel['Sonnet 5.5'].efforts,['low','medium','high']);assert.deepEqual(cache.byModel['Fable 5'].efforts,['medium','high']);assert.deepEqual(cache.byModel['Opus 5'].efforts,['low','medium']);assert.deepEqual(cache.byModel['Haiku 5.5'],{available:true,efforts:[]});
  const reads=await page.evaluate(()=>window.levelReads);assert.deepEqual(reads,{'Fable 5.1':1,'Opus 5.5':1,'Sonnet 5.5':1,'Fable 5':1,'Opus 5':1});
  for(const model of ['Sonnet 5.5','Haiku 5.5','Opus 5.5','Fable 5.1','Sonnet 5.5']){const changed=await run({kind:'options',catalogCache:cache,settings:{model}});assert.equal(changed.result.catalog.current.model,model);assert.deepEqual(changed.result.catalog.efforts,cache.byModel[model].efforts);}
  await run({kind:'open',catalogCache:cache});await run({kind:'inspect',catalogCache:cache});assert.deepEqual(await page.evaluate(()=>window.levelReads),reads);
  await page.reload();await page.addScriptTag({path:new URL('../extension/content.js',import.meta.url).pathname});await installEffortProfiles(page);
  const opened=await run({kind:'open',catalogCache:cache});assert.deepEqual(opened.result.catalog.byModel,cache.byModel);assert.equal(await page.evaluate(()=>window.modelMenuOpens),0);assert.deepEqual(await page.evaluate(()=>window.levelReads),{});
  const effort=await run({kind:'options',catalogCache:cache,settings:{model:'Sonnet 5.5',effort:'high'}});assert.equal(effort.result.catalog.current.effort,'high');assert.equal(await page.locator('#model-trigger').innerText(),'Sonnet 5.5 Высокий');
});

test('an unknown control command never becomes a chat message',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);const result=await run({kind:'future-control-command'});assert.match(result.error,/Неизвестная команда/);assert.equal(result.notSent,true);assert.equal(await page.locator('[data-testid="user-message"]').count(),0);assert.equal(await page.locator('[contenteditable]').innerText(),'');
});

test('ready image and document attachments are submitted promptly when page timers are throttled',{skip:!executable},async t=>{
  for(const file of [{name:'photo.png',type:'image/png',data:tinyPNG},{name:'report.pdf',type:'application/pdf',data:Buffer.from('%PDF-test').toString('base64')}]){
    const {page,run}=await fixture(t);
    await page.evaluate(()=>{
      const clock=window.setTimeout.bind(window),send=document.querySelector('#send');
      document.querySelector('#upload').onchange=event=>{
        window.uploadStartedAt=performance.now();send.disabled=true;
        const preview=document.createElement(event.target.files[0].type.startsWith('image/')?'img':'span');
        if(preview.tagName==='IMG'){preview.src=URL.createObjectURL(event.target.files[0]);preview.width=80;preview.height=80;}else preview.textContent=event.target.files[0].name;
        const progress=document.createElement('div');progress.setAttribute('role','progressbar');progress.textContent='Загрузка';document.querySelector('#uploads').replaceChildren(preview,progress);
        clock(()=>{progress.remove();send.disabled=false;window.fileReadyAt=performance.now();},250);
      };
      window.sendCount=0;send.onclick=()=>{
        window.submittedAt=performance.now();window.sendCount++;
        window.clickedBeforeReady=!window.fileReadyAt;window.submittedFiles=[...document.querySelector('#upload').files];
        const user=document.createElement('div');user.dataset.testid='user-message';user.textContent=document.querySelector('[contenteditable]').innerText;
        const answer=document.createElement('div');answer.dataset.testid='assistant-message';answer.dataset.isStreaming='false';answer.textContent='Готово';document.querySelector('#transcript').append(user,answer);document.querySelector('[contenteditable]').innerText='';
      };
      // Reproduce a browser delaying timers in a background page by ten seconds.
      window.setTimeout=(fn,ms,...args)=>clock(fn,Math.max(10000,ms),...args);
    });
    const result=run({kind:'chat',text:'Изучи',files:[file]});result.catch(()=>{});
    await page.waitForFunction(()=>window.submittedAt>0,{},{timeout:1800});
    const timing=await page.evaluate(()=>({ready:window.fileReadyAt,sent:window.submittedAt,count:window.sendCount,early:window.clickedBeforeReady}));
    t.diagnostic(file.type+': '+Math.round(timing.sent-timing.ready)+' ms from upload readiness to send');assert.equal(timing.count,1);assert.equal(timing.early,false);assert.ok(timing.sent-timing.ready<1000,'ready attachment must not wait for a throttled page timer');
    const response=await result;assert.equal(response.done,true,response.error);assert.equal(await page.evaluate(()=>window.submittedFiles[0].name),file.name);
  }
});

test('a disconnected worker clock stops before submission and never falls back to delayed page timers',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);await page.evaluate(()=>{const original=chrome.runtime.sendMessage;chrome.runtime.sendMessage=message=>message.type==='wait'?Promise.resolve({ok:false}):original(message);window.sendCount=0;document.querySelector('#send').onclick=()=>window.sendCount++;});
  const result=await run({kind:'chat',text:'Не отправлять',files:[{name:'photo.png',type:'image/png',data:tinyPNG}]});
  assert.match(result.error,/Связь с расширением/);assert.equal(result.notSent,true);assert.equal(await page.evaluate(()=>window.sendCount),0);assert.equal(await page.locator('[data-testid="user-message"]').count(),0);
});

test('a PDF document card opens its preview and transfers the actual PDF bytes with the original filename',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);const pdf=Buffer.from('%PDF-1.7\nactual burger document\n%%EOF');
  await page.route('https://claude.ai/files/burger-document',route=>route.fulfill({contentType:'application/pdf',headers:{'Content-Disposition':'attachment; filename="burger.pdf"'},body:pdf}));
  await page.evaluate(()=>{
    document.querySelector('#transcript').innerHTML='<div data-testid="assistant-message"><p>Готово — burger.pdf.</p><div role="button" tabindex="0" data-testid="generated-file" aria-controls="pdf-preview"><span>Burger</span><span>Документ·PDF</span></div></div>';
    document.querySelector('[data-testid="generated-file"]').onclick=()=>{const panel=document.createElement('div');panel.id='pdf-preview';panel.dataset.testid='document-preview';panel.innerHTML='<iframe src="/files/burger-document#page=1"></iframe><a href="/files/burger-document" download="burger.pdf">Скачать</a>';document.body.append(panel);};
  });
  const reply=await run({kind:'open'});assert.equal(reply.done,true,reply.error);const message=reply.result.snapshot.messages.at(-1);assert.deepEqual(reply.result.warnings,[]);assert.equal(message.text,'Готово — burger.pdf.');assert.equal(message.files.length,1);assert.equal(message.files[0].name,'burger.pdf');assert.equal(message.files[0].type,'application/pdf');assert.deepEqual(Buffer.from(message.files[0].data,'base64'),pdf);
});
test('a reused PDF viewer waits for the new blob instead of copying a previous document',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);await page.evaluate(()=>{
    document.querySelector('#transcript').innerHTML='<div data-testid="assistant-message">Новый PDF<div role="button" data-testid="file-card" data-filename="new.pdf" aria-controls="pdf-preview">New.pdf Документ·PDF</div></div>';
    const panel=document.createElement('div');panel.id='pdf-preview';panel.dataset.testid='file-preview';const frame=document.createElement('iframe');frame.src=URL.createObjectURL(new Blob(['%PDF-1.7 old-private-document'],{type:'application/pdf'}));panel.append(frame);document.body.append(panel);
    document.querySelector('[data-testid="file-card"]').onclick=()=>setTimeout(()=>frame.src=URL.createObjectURL(new Blob(['%PDF-1.7 new-document'],{type:'application/pdf'})),200);
  });
  const reply=await run({kind:'open'});assert.equal(reply.done,true,reply.error);assert.deepEqual(reply.result.warnings,[]);const files=reply.result.snapshot.messages.at(-1).files;assert.equal(files.length,1);assert.equal(files[0].name,'new.pdf');assert.equal(Buffer.from(files[0].data,'base64').toString(),'%PDF-1.7 new-document');
});
test('a PDF card never saves an HTML viewer page as a downloadable PDF',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);await page.evaluate(()=>{document.querySelector('#transcript').innerHTML='<div data-testid="assistant-message">Ответ<div role="button" data-testid="file-card" data-download-url="/viewer/burger.pdf">Burger Документ·PDF</div></div>';});
  const reply=await run({kind:'open'});assert.equal(reply.done,true,reply.error);assert.equal(reply.result.snapshot.messages.at(-1).files.length,0);assert.match(reply.result.warnings.join(' '),/вместо PDF/);
});

test('the website renders a generated PDF as a downloadable file and preserves its bytes',{skip:!executable},async t=>{
  const {createApp}=await import('../server.mjs'),{scryptSync}=await import('node:crypto');const pdf=Buffer.from('%PDF-1.7\nburger document\n%%EOF');
  const bridge={status:{connected:true},execute:async()=>({catalog:mockCatalog({models:['Sonnet 5.5'],efforts:['medium'],current:{model:'Sonnet 5.5',effort:'medium'}}),chats:[]}),send:async job=>{job.onUpdate({text:'Готово — burger.pdf.',url:'https://claude.ai/chat/pdf-test'});await job.onFile({name:'burger.pdf',type:'application/pdf',data:pdf.toString('base64')});return{};}};
  const server=createApp({auth:{salt:'test',hash:scryptSync('pw','test',64).toString('hex')},bridge});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  const context=await browser.newContext({viewport:{width:390,height:844},acceptDownloads:true});t.after(()=>context.close());const page=await context.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('#password').fill('pw');await page.locator('#login-form button').click();await page.waitForFunction(()=>document.querySelector('#model-label').textContent==='Sonnet 5.5'&&!document.querySelector('#attach').disabled);
  await page.locator('#prompt').fill('Создай PDF');await page.locator('#send').click();const card=page.locator('article.assistant .file-card');await card.locator('strong').filter({hasText:'burger.pdf'}).waitFor();assert.equal(await card.locator('a').textContent(),'Скачать');assert.equal(await card.locator('button').count(),0);
  const downloading=page.waitForEvent('download');await card.locator('a').click();const download=await downloading;assert.equal(download.suggestedFilename(),'burger.pdf');assert.deepEqual(await readFile(await download.path()),pdf);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
});

test('a follow-up button mentioning a PDF is never clicked as a document card',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);await page.evaluate(()=>{document.querySelector('#transcript').innerHTML='<div data-testid="assistant-message">Готово — burger.pdf.<button id="followup">Переделать burger.pdf?</button></div>';window.followupClicks=0;document.querySelector('#followup').onclick=()=>window.followupClicks++;});
  const result=await run({kind:'open'});assert.equal(result.done,true,result.error);assert.equal(await page.evaluate(()=>window.followupClicks),0);assert.deepEqual(result.result.warnings,[]);
});

test('a PDF title button and its sibling document type are handled as one native file card',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);const pdf=Buffer.from('%PDF-1.7\nburger from a sibling card\n%%EOF');
  await page.route('https://claude.ai/files/sibling-card',route=>route.fulfill({contentType:'application/pdf',headers:{'Content-Disposition':'attachment; filename="burger.pdf"'},body:pdf}));
  await page.evaluate(()=>{
    document.querySelector('#transcript').innerHTML='<div data-testid="assistant-message"><p>Вот burger.pdf ещё раз.</p><section class="native-file"><button>Burger</button><div><span>Документ · PDF</span></div></section></div>';
    document.querySelector('.native-file button').onclick=()=>{const iframe=document.createElement('iframe');iframe.src='/files/sibling-card';document.body.append(iframe);};
  });
  const result=await run({kind:'open'});assert.equal(result.done,true,result.error);const message=result.result.snapshot.messages.at(-1);assert.equal(message.files.length,1);assert.equal(message.files[0].name,'burger.pdf');assert.deepEqual(Buffer.from(message.files[0].data,'base64'),pdf);assert.equal(message.text,'Вот burger.pdf ещё раз.');
});
test('deletion waits for a delayed native confirmation before confirming once',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);await installChatActions(page);await page.evaluate(()=>{
    window.deleteConfirmations=0;document.querySelector('aside button').addEventListener('click',()=>{
      const item=[...document.querySelectorAll('[role="menuitem"]')].find(n=>n.textContent==='Удалить');item.onclick=()=>{document.querySelectorAll('[role="menu"]').forEach(n=>n.hidden=true);setTimeout(()=>{
        const dialog=document.createElement('div');dialog.setAttribute('role','alertdialog');const button=document.createElement('button');button.textContent='Удалить чат';button.onclick=()=>{window.deleteConfirmations++;setTimeout(()=>{document.querySelector('aside a[href="/chat/current-123"]').parentElement.remove();dialog.remove();},150);};dialog.append(button);document.body.append(dialog);
      },350);};
    });
  });
  const result=await run({kind:'manage',action:'delete',url:'https://claude.ai/chat/current-123'});assert.equal(result.result?.applied,true,result.error);assert.equal(await page.evaluate(()=>window.deleteConfirmations),1);
});
test('missing controls in the target row never open another chat menu',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);await page.evaluate(()=>{window.otherMenuClicks=0;const more=document.createElement('button');more.setAttribute('aria-label','Дополнительные параметры: другой чат');more.onclick=()=>window.otherMenuClicks++;document.querySelector('aside').append(more);});
  const result=await run({kind:'manage',action:'delete',url:'https://claude.ai/chat/current-123'});assert.ok(result.error);assert.equal(await page.evaluate(()=>window.otherMenuClicks),0);
});

test('a native deletion failure is never interpreted as a successful deletion',{skip:!executable},async t=>{
  const {page,run}=await fixture(t);await installChatActions(page);await page.evaluate(()=>{document.querySelector('aside button').addEventListener('click',()=>{const item=[...document.querySelectorAll('[role="menuitem"]')].find(n=>n.textContent==='Удалить');item.onclick=()=>{document.querySelectorAll('[role="menu"]').forEach(n=>n.hidden=true);const notice=document.createElement('div');notice.setAttribute('role','alert');notice.textContent='Чат не удалён';document.body.append(notice);};});});
  const result=await run({kind:'manage',action:'delete',url:'https://claude.ai/chat/current-123'});assert.match(result.error,/не удалён/);assert.equal(result.result?.applied,undefined);assert.equal(await page.locator('aside a[href="/chat/current-123"]').count(),1);
});
