import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {scryptSync} from 'node:crypto';
import vm from 'node:vm';
import {chromium} from 'playwright';
import {ExtensionBridge} from '../extension-bridge.mjs';
import {createApp} from '../server.mjs';
import {DataStore} from '../data-store.mjs';
import {mockCatalog} from './helpers/catalog.mjs';
let executable=process.env.CHROMIUM_EXECUTABLE||'/usr/bin/chromium';try{await access(executable);}catch{executable=null;}

test('a real native page reload during streaming reconnects the answer through the background and server once',{skip:!executable,timeout:35000},async t=>{
  const bridge=new ExtensionBridge();await bridge.open(0);t.after(()=>bridge.close());const store=new DataStore();await store.saveModelCatalog(mockCatalog());
  const server=createApp({auth:{salt:'test',hash:scryptSync('pw','test',64).toString('hex')},bridge,store});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  const browser=await chromium.launch({executablePath:executable,headless:true});t.after(()=>browser.close());const context=await browser.newContext();const source=await context.newPage();
  let handler,config={token:bridge.token,tabId:7},reloads=0;const kinds=[];
  await source.exposeFunction('workerMessage',message=>new Promise(resolve=>handler(message,{id:'test-extension',tab:{id:7,url:source.url()}},resolve)));
  const content=await readFile(new URL('../extension/content.js',import.meta.url),'utf8');
  await source.addInitScript({content:'window.chrome={runtime:{id:"test-extension",onMessage:{addListener:fn=>window.extensionHandler=fn},sendMessage:window.workerMessage}};\n'+content});
  let html=await readFile(new URL('./fixtures/claude.html',import.meta.url),'utf8');
  html+='<script>const transcript=document.querySelector("#transcript"),saved=localStorage.getItem("submitted");if(saved){transcript.innerHTML="<div data-testid=user-message></div><div data-testid=assistant-message data-is-streaming=false><p>Восстановленный <strong>ответ</strong></p><ul><li>Первый</li><li>Второй</li></ul></div>";transcript.firstChild.textContent=saved;}document.querySelector("#send").onclick=()=>{const text=document.querySelector("[contenteditable]").innerText;localStorage.setItem("submitted",text);localStorage.setItem("sendCount",String(Number(localStorage.getItem("sendCount")||0)+1));transcript.innerHTML="<div data-testid=user-message></div><div data-testid=assistant-message data-is-streaming=true><p>Начало ответа…</p></div>";transcript.firstChild.textContent=text;document.querySelector("[contenteditable]").innerText="";setTimeout(()=>location.reload(),500);};</script>';
  await source.route('https://claude.ai/**',route=>route.fulfill({contentType:'text/html',body:html}));await source.goto('https://claude.ai/chat/reload-test');
  // Browser policy disables installing unpacked extensions in this executor.
  // Adapt only Tabs/runtime transport; production content, background, server,
  // real page navigation, persisted native transcript and wrapper run unchanged.
  const chrome={storage:{local:{get:async()=>config,set:async value=>Object.assign(config,value),setAccessLevel(){}}},tabs:{get:async()=>{let complete=false;try{complete=await source.evaluate(()=>document.readyState==='complete');}catch{}return{id:7,url:source.url(),status:complete?'complete':'loading'};},update:async(_id,value)=>{if(value.url)await source.goto(value.url);},reload:async()=>{reloads++;await source.reload();},sendMessage:async(_id,message)=>{if(message.type==='run')kinds.push(message.kind);return source.evaluate(message=>new Promise(resolve=>extensionHandler(message,{id:'test-extension'},resolve)),message);}},runtime:{id:'test-extension',getManifest:()=>({version:'0.9.0'}),onMessage:{addListener:fn=>handler=fn},onStartup:{addListener(){}}},alarms:{create(){},onAlarm:{addListener(){}}}};
  const background=(await readFile(new URL('../extension/background.js',import.meta.url),'utf8')).replace('http://127.0.0.1:3001','http://127.0.0.1:'+bridge.server.address().port);
  vm.runInNewContext(background,{chrome,URL,AbortSignal,setTimeout,clearTimeout,fetch:(url,options)=>fetch(url,{...options,headers:{...options.headers,Origin:'chrome-extension://'+'a'.repeat(32)}})});t.after(()=>{config={};});
  const ui=await context.newPage();await ui.goto('http://127.0.0.1:'+server.address().port);await ui.locator('#password').fill('pw');await ui.locator('#login-form button').click();await ui.waitForFunction(()=>document.querySelector('#app').hidden===false&&!document.querySelector('#model-toggle').disabled);
  await ui.locator('#prompt').fill('Продолжи после перезагрузки');await ui.locator('#send').click();await ui.locator('article.assistant strong').filter({hasText:'ответ'}).waitFor({timeout:20000});await ui.waitForFunction(()=>!document.querySelector('#model-toggle').disabled);
  assert.equal(await source.evaluate(()=>localStorage.getItem('sendCount')),'1');assert.equal(kinds.filter(k=>k==='chat').length,1);assert.equal(kinds.filter(k=>k==='resume').length,1);assert.equal(reloads,0,'a manual reload must not trigger an extra reload');
  const chat=(await store.list()).find(c=>c.url==='https://claude.ai/chat/reload-test');assert.equal(chat.messages.filter(m=>m.role==='user').length,1);assert.match(chat.messages.at(-1).text,/Восстановленный ответ/);assert.ok(chat.messages.at(-1).format);assert.equal(chat.messages.at(-1).error,undefined);assert.equal(await ui.locator('article.assistant li').count(),2);assert.equal(await ui.locator('#status').isHidden(),true);
  // The URL is unchanged: a new document instance must still refresh cached
  // native content after an ordinary reload, even with no active request.
  html=html.replace('Восстановленный','Обновлённый');await source.reload();await ui.locator('article.assistant').filter({hasText:'Обновлённый ответ'}).waitFor({timeout:10000});assert.match(chat.messages.at(-1).text,/Обновлённый ответ/);assert.equal(await source.evaluate(()=>localStorage.getItem('sendCount')),'1');
});
