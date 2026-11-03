const BASE='http://127.0.0.1:3001';
if(typeof importScripts==='function')importScripts('browser-downloads.js');
let running=false, active=new Map(), generation=0;
const workers=[];
const downloads=globalThis.ClaudeRUDownloads&&chrome.downloads?new ClaudeRUDownloads({api:chrome.downloads,isActive:own=>active.get(own.id)===own,onFile:async(own,download)=>{const reply=await request('/event',own.token,{id:own.id,type:'download',download});if(!reply.file)throw Error('Сервер не сохранил скачанный файл');return reply.file;}}):null;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
chrome.storage.local.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'});
async function request(path,token,body,pageProtocol=0){
  const res=await fetch(BASE+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'X-ClaudeRU-Protocol':'13','X-ClaudeRU-Page-Protocol':String(pageProtocol),'X-ClaudeRU-Version':chrome.runtime.getManifest().version,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(22000)});
  const data=await res.json().catch(()=>({}));
  if(!res.ok)throw Error(res.status===401?'Код подключения неверен. Переподключите расширение.':res.status===404&&path==='/health'?'Обновите и перезапустите сервер ClaudeRU на Mac.':data.error||'Ошибка домашнего сервера: '+res.status);
  return data;
}
async function pageReadiness(tabId){try{return await chrome.tabs.sendMessage(tabId,{type:'ready'});}catch{return {ready:false,version:0};}}
function parseURL(value){try{return new URL(value);}catch{return null;}}
function chatURL(value){const u=parseURL(value || 'https://claude.ai/new');if(!u||u.origin!=='https://claude.ai'||!/^\/(new|chat\/[a-zA-Z0-9-]+)$/.test(u.pathname)||u.search||u.hash||u.username||u.password)throw Error('Неверный адрес чата');return u.href;}
function samePage(current,target){
  const from=parseURL(current),to=parseURL(target);
  if(!from||!to||from.origin!==to.origin)return false;
  const pathname=from.pathname.replace(/\/$/,'')||'/';
  return pathname===to.pathname.replace(/\/$/,'')||(to.pathname==='/new'&&pathname==='/');
}
async function reserveWorker(job,config){
  const key=job.chatId||job.url||'default';
  let worker=workers.find(w=>w.key===key);
  if(['state','diagnostics'].includes(job.kind)){if(!worker)throw Error('Обновите чат, чтобы подключить его вкладку Claude');return worker;}
  if(worker?.busy)throw Error('В этом чате уже выполняется действие');
  if(!worker){
    worker=workers.find(w=>!w.busy&&(job.url?w.url===job.url:!w.key||w.url==='https://claude.ai/new'||w.url==='https://claude.ai/'))||workers.find(w=>!w.busy);
    if(!worker){
      if(job.kind==='manage'&&workers.length)throw Error('Открытая вкладка Claude занята. Дождитесь завершения текущего действия и повторите действие. Новая вкладка не создавалась.');
      if(workers.length>=6)throw Error('Уже открыто 6 работающих чатов. Дождитесь завершения одного ответа.');
      worker={tabId:workers.length?null:config.tabId};workers.push(worker);
    }
    worker.key=key;
  }
  worker.busy=true;worker.jobId=job.id; // Reserve before any await: polls may deliver another job immediately.
  try{
    if(!worker.tabId){if(job.kind==='manage')throw Error('Для действия с чатом нужна уже открытая вкладка Claude.');worker.requestedURL=chatURL(job.url);const tab=await chrome.tabs.create({url:worker.requestedURL,active:false});worker.tabId=tab.id;worker.owned=true;}
    else{try{await chrome.tabs.get(worker.tabId);}catch{if(job.kind==='manage'||!worker.owned)throw Error('Подключённая вкладка закрыта. Подключите Claude заново.');worker.requestedURL=chatURL(job.url);const tab=await chrome.tabs.create({url:worker.requestedURL,active:false});worker.tabId=tab.id;}}
    return worker;
  }catch(e){worker.busy=false;throw e;}
}
async function perform(job,config){
  let own,worker,jobDispatched=false;
  try{
    worker=await reserveWorker(job,config);own={id:job.id,tabId:worker.tabId,token:config.token};active.set(job.id,own);
    const tab=await chrome.tabs.get(worker.tabId),address=parseURL(tab.url);
    if(address&&address.origin!=='https://claude.ai'&&tab.status!=='loading'&&!worker.requestedURL)throw Error('Выбранная вкладка больше не открыта на claude.ai. Переподключите её.');
    if(address?.origin==='https://claude.ai')worker.url=address.href;
    if(job.kind==='state'&&tab.status!=='loading'&&tab.url&&!samePage(tab.url,chatURL(job.url)))throw Error('Вкладка переключена на другой чат. Обновите текущий чат.');
    const target=['inspect','catalog','diagnostics'].includes(job.kind)?(address?.origin==='https://claude.ai'?address.href:tab.pendingUrl||worker.requestedURL||worker.url||chatURL(job.url)):chatURL(job.url);
    // Chrome/Yandex can omit url or return about:blank until a new tab commits.
    // Wait for the requested Claude page; never dispatch based only on pendingUrl.
    if(!['inspect','catalog','state','diagnostics'].includes(job.kind)&&!samePage(tab.url,target)&&!samePage(tab.pendingUrl||worker.requestedURL,target)){await chrome.tabs.update(worker.tabId,{url:target});worker.url=target;worker.requestedURL=target;}
    let started=false;
    for(let i=0;i<200;i++){
      try{const state=await chrome.tabs.get(worker.tabId);if(state.status==='complete'&&samePage(state.url,target)){const ready=await chrome.tabs.sendMessage(worker.tabId,{type:'ready'});if(ready?.ready){if(ready.version!==13)throw Error('Обновите расширение и вкладку Claude до версии 0.6.0');started=true;break;}}}catch(e){if(e.message?.includes('до версии'))throw e;}
      await delay(100);
    }
    if(!started)throw Error('Вкладка не готова. Обновите её вручную и проверьте вход в Claude.');
    worker.requestedURL=null;
    jobDispatched=true;
    const result=await chrome.tabs.sendMessage(worker.tabId,{...job,type:'run'});
    if(result?.error){const error=Error(result.error);error.notSent=result.notSent===true;error.state=result.state;throw error;}
    if(!result?.done)throw Error('Вкладка прервала выполнение');
    if(result.result?.url||result.result?.snapshot?.url)worker.url=result.result.url||result.result.snapshot.url;
    if(worker?.jobId===job.id)worker.busy=false;
    await request('/event',config.token,{id:job.id,type:'done',result:result.result});
  }catch(e){if(worker?.jobId===job.id)worker.busy=false;try{await request('/event',config.token,{id:job.id,type:'error',error:e.message,notSent:e.notSent===true||!jobDispatched,state:e.state});}catch{}}
  finally{if(own)downloads?.clear(own);active.delete(job.id);if(worker?.jobId===job.id)worker.busy=false;}
}
async function loop(){
  if(running)return;running=true;
  const current=generation;
  try{while(current===generation){
    const config=await chrome.storage.local.get(['token','tabId']);if(!config.token||!config.tabId)break;
    try{
      const tab=await chrome.tabs.get(config.tabId);
      if(tab.status==='loading'){await delay(100);continue;}
      if(parseURL(tab.url)?.origin!=='https://claude.ai')throw Error('Откройте выбранную вкладку Claude.');
      const ready=await pageReadiness(config.tabId);
      const job=await request('/poll',config.token,undefined,ready.ready?(ready.version??0):0);
      await chrome.storage.local.set({lastStatus:'Домашний сервер подключён'});
      if(job.id)void perform(job,config);
    }catch(e){await chrome.storage.local.set({lastStatus:e.message});await delay(1000);}
  }}finally{running=false;if(current!==generation)void loop();}
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.tab){
    const own=active.get(message.id);
    if(message.type?.startsWith('download-')){
      if(!own||sender.tab.id!==own.tabId||!downloads){respond({ok:false,error:'Обновите расширение и разрешите управление загрузками'});return;}
      if(message.type==='download-begin'){downloads.begin(own,message.nonce,message.name,sender.tab.url).then(respond,e=>respond({ok:false,error:e.message}));return true;}
      if(message.type==='download-cancel')downloads.cancel(own,message.nonce);
      respond(message.type==='download-state'?downloads.state(own,message.nonce):{ok:true});return;
    }
    if(message.type==='wait'){
      if(!own||sender.tab.id!==own.tabId||!Number.isInteger(message.ms)||message.ms<0||message.ms>1000){respond({ok:false});return;}
      delay(message.ms).then(()=>respond({ok:active.get(message.id)===own}));return true;
    }
    if(['update','file','warning'].includes(message.type)&&own&&sender.tab.id===own.tabId){
      request('/event',own.token,{id:own.id,type:message.type,...(message.type==='update'?{text:message.text,url:message.url}:message.type==='file'?{file:message.file}:{warning:message.warning})}).then(()=>respond({ok:true}),()=>respond({ok:false}));return true;
    }
    return;
  }
  // Only our own popup may change the pairing.
  if(sender.id!==chrome.runtime.id || sender.url!==chrome.runtime.getURL('popup.html'))return;
  if(message.type==='connect'){
    if(active.size){respond({error:'Дождитесь завершения текущего ответа.'});return;}
    (async()=>{
      try{
        const tab=await chrome.tabs.get(message.tabId);
        if(parseURL(tab.url)?.origin!=='https://claude.ai')throw Error('Откройте вкладку claude.ai и подключите её.');
        const ready=await pageReadiness(message.tabId);
        if(!ready.ready||ready.version!==13)throw Error('Обновите вкладку Claude: её код устарел или не загружен. Затем подключите её заново.');
        await request('/health',message.token,undefined,ready.version);
        await chrome.storage.local.set({token:message.token,tabId:message.tabId,lastStatus:'Связь с вкладкой Claude установлена'});
        workers.length=0;generation++;void loop();respond({ok:true});
      }catch(e){respond({error:e.message});}
    })();return true;
  }
  if(message.type==='disconnect'){
    chrome.storage.local.remove(['token','tabId']).then(()=>{generation++;respond({ok:true});});return true;
  }
});
chrome.alarms.create('reconnect',{periodInMinutes:1});
chrome.alarms.onAlarm.addListener(()=>void loop());
chrome.runtime.onStartup.addListener(()=>void loop());
void loop();
