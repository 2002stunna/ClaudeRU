import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {scryptSync} from 'node:crypto';
import vm from 'node:vm';
import {chromium} from 'playwright';
import {ExtensionBridge} from '../extension-bridge.mjs';
import {createApp} from '../server.mjs';
import {DataStore} from '../data-store.mjs';
import {readBrowserDownload} from '../browser-download.mjs';
import {mockCatalog} from './helpers/catalog.mjs';

test('download events are bound to one active chat, wait for completion and ignore other browser downloads',async()=>{
  let determine,changed,copied=0;const own={id:'a'.repeat(32)},other={id:'b'.repeat(32)},nonce='c'.repeat(32),api={onDeterminingFilename:{addListener:fn=>determine=fn},onChanged:{addListener:fn=>changed=fn},search:async()=>[{state:'complete',exists:true,filename:'/Downloads/ClaudeRU/'+own.id+'/original.pdf',fileSize:15,mime:'application/pdf'}]};
  // Expose the production class while preserving its own realm and callbacks.
  const context=vm.createContext({URL,setTimeout});vm.runInContext(await readFile(new URL('../extension/browser-downloads.js',import.meta.url),'utf8'),context);const downloads=new context.ClaudeRUDownloads({api,isActive:value=>value===own,onFile:async()=>{copied++;return {id:'d'.repeat(32),name:'original.pdf',size:15};}});
  await downloads.begin(own,nonce,'Display title.pdf','https://claude.ai/chat/current');let suggestion;
  determine({id:1,filename:'Display title.pdf',url:'blob:https://claude.ai/file',referrer:'https://claude.ai/chat/other',startTime:new Date().toISOString()},value=>suggestion=value);assert.equal(suggestion,undefined);assert.equal(downloads.state(own,nonce).state,'waiting');
  determine({id:2,filename:'original.pdf',url:'blob:https://claude.ai/file',referrer:'https://claude.ai/chat/current',startTime:new Date().toISOString()},value=>suggestion=value);assert.equal(suggestion.filename,'ClaudeRU/'+own.id+'/original.pdf');
  await changed({id:999,state:{current:'complete'}});assert.equal(copied,0);await changed({id:2,state:{current:'in_progress'}});assert.equal(copied,0);
  await downloads.changed({id:2,state:{current:'complete'}});assert.equal(copied,1);assert.equal(downloads.state(own,nonce).state,'done');assert.equal(downloads.state(other,nonce).ok,false);await downloads.changed({id:2,state:{current:'complete'}});assert.equal(copied,1);
  downloads.clear(own);assert.equal(downloads.state(own,nonce).ok,false);
});

test('completed browser downloads are read only from the owning job directory and reject symlinks, stale and fake PDFs',async t=>{
  const root=await mkdtemp(join(tmpdir(),'cru-download-'));t.after(()=>rm(root,{recursive:true,force:true}));const job='a'.repeat(32),dir=join(root,'ClaudeRU',job);await mkdir(dir,{recursive:true});
  const path=join(dir,'burger.pdf'),bytes=Buffer.from('%PDF-1.7\nactual binary document\n%%EOF');await writeFile(path,bytes);
  const file=await readBrowserDownload(job,{path,size:bytes.length,type:'application/pdf'});assert.deepEqual(Buffer.from(file.data,'base64'),bytes);
  await assert.rejects(readBrowserDownload('b'.repeat(32),{path,size:bytes.length}),/каталог/);
  await assert.rejects(readBrowserDownload(job,{path,size:bytes.length+1}),/не готов/);
  await assert.rejects(readBrowserDownload(job,{path,size:bytes.length},Date.now()+10000),/не готов/);
  const linked=join(dir,'link.pdf');await symlink(path,linked);await assert.rejects(readBrowserDownload(job,{path:linked,size:bytes.length}));
  await writeFile(path,'<html>Viewer</html>');await assert.rejects(readBrowserDownload(job,{path,size:19}),/Вместо PDF/);
});

let executable=process.env.CHROMIUM_EXECUTABLE||'/usr/bin/chromium';try{await access(executable);}catch{executable=null;}
test('native browser PDF download is imported through the background and served after the source file is removed',{skip:!executable,timeout:45000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'cru-native-'));t.after(()=>rm(root,{recursive:true,force:true}));const downloadRoot=join(root,'downloads');await mkdir(downloadRoot);
  const bridge=new ExtensionBridge();await bridge.open(3001);t.after(()=>bridge.close());const store=new DataStore(join(root,'store'));await store.saveModelCatalog(mockCatalog());await store.create({title:'PDF с бургером',url:'https://claude.ai/chat/download-test'});
  const server=createApp({auth:{salt:'test',hash:scryptSync('pw','test',64).toString('hex')},bridge,store});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  const context=await chromium.launchPersistentContext(join(root,'profile'),{executablePath:executable,headless:true,acceptDownloads:true});t.after(()=>context.close());
  const html=await readFile(new URL('./fixtures/claude.html',import.meta.url),'utf8');await context.route('https://claude.ai/**',route=>route.fulfill({contentType:'text/html',body:html}));
  const source=await context.newPage();await source.goto('https://claude.ai/chat/download-test');
  let handler,config={token:bridge.token,tabId:7},determine,changed,nativeFile;
  const items=new Map();
  // This executor's browser policy disables unpacked extensions. Adapt real
  // Playwright download events to the Downloads API while running the actual
  // production background/controller. File bytes come from Chromium's download.
  source.on('download',async download=>{
    const item={id:items.size+1,url:download.url(),referrer:source.url(),filename:download.suggestedFilename(),startTime:new Date().toISOString(),state:'in_progress',mime:'application/pdf'};
    items.set(item.id,item);let choice;determine(item,value=>choice=value);
    const path=join(downloadRoot,choice?.filename||item.filename);await mkdir(join(path,'..'),{recursive:true});await download.saveAs(path);const bytes=await readFile(path);
    Object.assign(item,{filename:path,fileSize:bytes.length,state:'complete',exists:true});nativeFile=path;changed({id:item.id,state:{current:'complete'}});
  });
  const chrome={storage:{local:{get:async()=>config,set:async()=>{},setAccessLevel(){}}},tabs:{get:async()=>({url:source.url(),status:'complete'}),sendMessage:async(_id,message)=>source.evaluate(message=>new Promise(resolve=>extensionHandler(message,{id:'test-extension'},resolve)),message)},downloads:{onDeterminingFilename:{addListener:fn=>determine=fn},onChanged:{addListener:fn=>changed=fn},search:async({id})=>[items.get(id)]},runtime:{id:'test-extension',getManifest:()=>({version:'0.9.0'}),getURL:path=>'chrome-extension://'+'a'.repeat(32)+'/'+path,onMessage:{addListener:fn=>handler=fn},onStartup:{addListener(){}}},alarms:{create(){},onAlarm:{addListener(){}}}};
  await source.exposeFunction('workerMessage',message=>new Promise(resolve=>handler(message,{id:'test-extension',tab:{id:7,url:source.url()}},resolve)));
  await source.evaluate(()=>{window.chrome={runtime:{id:'test-extension',onMessage:{addListener:fn=>window.extensionHandler=fn},sendMessage:window.workerMessage}};});
  await source.addScriptTag({path:resolve('extension/content.js')});
  await source.evaluate(()=>{
    window.downloadClicks=0;window.previewClicks=0;
    document.querySelector('#transcript').innerHTML='<div data-testid="transcript-row"><div data-testid="assistant-message">Готово — burger.pdf.</div><div data-testid="file-card-block"><div><span role="button" data-testid="file-card-open" aria-label="Просмотреть: Burger">Burger</span><span>Документ · PDF</span></div><button aria-label="Скачать Burger">↓</button></div></div>';
    document.querySelector('[data-testid="file-card-open"]').onclick=()=>window.previewClicks++;
    document.querySelector('[aria-label="Скачать Burger"]').onclick=()=>{window.downloadClicks++;const link=document.createElement('a');link.download='burger.pdf';link.href=URL.createObjectURL(new Blob(['%PDF-1.7\nreal browser binary\n%%EOF'],{type:'application/pdf'}));link.click();URL.revokeObjectURL(link.href);};
  });
  const background=await readFile(new URL('../extension/browser-downloads.js',import.meta.url),'utf8')+'\n'+await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
  vm.runInNewContext(background,{chrome,URL,AbortSignal,setTimeout,fetch:(url,options)=>fetch(url,{...options,headers:{...options.headers,Origin:'chrome-extension://'+'a'.repeat(32)}})});t.after(()=>{config={};});
  const ui=await context.newPage();await ui.goto(`http://127.0.0.1:${server.address().port}`);await ui.locator('#password').fill('pw');await ui.locator('#login-form button').click();
  try{await ui.locator('article.assistant .file-card strong').filter({hasText:'burger.pdf'}).waitFor({timeout:18000});}catch(error){t.diagnostic(JSON.stringify({status:bridge.status,ui:await ui.locator('#status').textContent(),downloads:[...items.values()]}));throw error;}
  assert.equal(await source.evaluate(()=>window.downloadClicks),1);assert.equal(await source.evaluate(()=>window.previewClicks),0);
  const stored=(await store.list()).find(c=>c.url==='https://claude.ai/chat/download-test').messages.at(-1).files;assert.equal(stored.length,1);const {bytes}=await store.readFile(stored[0].id);assert.equal(bytes.toString(),'%PDF-1.7\nreal browser binary\n%%EOF');
  assert.match(nativeFile,/ClaudeRU\/[a-f0-9]{32}\/burger\.pdf$/);await rm(nativeFile);await source.close();
  const response=await ui.request.get(`http://127.0.0.1:${server.address().port}/api/files/`+stored[0].id);assert.equal(response.status(),200);assert.deepEqual(await response.body(),bytes);assert.match(response.headers()['content-disposition'],/^attachment;/);
});
