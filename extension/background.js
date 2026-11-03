const BASE='http://127.0.0.1:3001';
if(typeof importScripts==='function')importScripts('browser-downloads.js','conversation-events.js');
let running=false, active=new Map(), generation=0,followTabId=null,activationSequence=0,lastNativeActivation=0;
const workers=[];
const recoveryHistory=new Map(),recoveringTabs=new Map(),healthFailures=new Map(),protectedTabs=new Set();
const downloads=globalThis.ClaudeRUDownloads&&chrome.downloads?new ClaudeRUDownloads({api:chrome.downloads,isActive:own=>active.get(own.id)===own,onFile:async(own,download)=>{const reply=await request('/event',own.token,{id:own.id,type:'download',download});if(!reply.file)throw Error('Сервер не сохранил скачанный файл');return reply.file;}}):null;
const conversationEvents=globalThis.ClaudeRUConversationEvents&&chrome.webRequest?new ClaudeRUConversationEvents({api:chrome.webRequest,storage:chrome.storage.local,report:async deletions=>{const {token}=await chrome.storage.local.get(['token']);if(!token)throw Error('Не подключено');await request('/deletions',token,{deletions});}}):null;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
chrome.storage.local.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'});
async function request(path,token,body,pageProtocol=0){
  const res=await fetch(BASE+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'X-ClaudeRU-Protocol':'17','X-ClaudeRU-Page-Protocol':String(pageProtocol),'X-ClaudeRU-Version':chrome.runtime.getManifest().version,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(22000)});
  const data=await res.json().catch(()=>({}));
  if(!res.ok)throw Error(res.status===401?'Код подключения неверен. Переподключите расширение.':res.status===404&&path==='/health'?'Обновите и перезапустите сервер ClaudeRU на Mac.':data.error||'Ошибка домашнего сервера: '+res.status);
  return data;
}
async function pageReadiness(tabId){let timer;try{return await Promise.race([chrome.tabs.sendMessage(tabId,{type:'ready'}),new Promise(resolve=>{timer=setTimeout(()=>resolve({ready:false,version:0}),2000);})]);}catch{return {ready:false,version:0};}finally{globalThis.clearTimeout?.(timer);}}
function parseURL(value){try{return new URL(value);}catch{return null;}}
function chatURL(value){const u=parseURL(value || 'https://claude.ai/new');if(!u||u.origin!=='https://claude.ai'||!/^\/(new|chat\/[a-zA-Z0-9-]+)$/.test(u.pathname)||u.search||u.hash||u.username||u.password)throw Error('Неверный адрес чата');return u.href;}
function samePage(current,target){
  const from=parseURL(current),to=parseURL(target);
  if(!from||!to||from.origin!==to.origin)return false;
  const pathname=from.pathname.replace(/\/$/,'')||'/';
  return pathname===to.pathname.replace(/\/$/,'')||(to.pathname==='/new'&&pathname==='/');
}
async function protectTab(tab){
  if(tab.id&&tab.autoDiscardable===true&&!protectedTabs.has(tab.id)){try{await chrome.tabs.update(tab.id,{autoDiscardable:false});protectedTabs.add(tab.id);}catch{}}
}
async function recoverTab(tabId){
  if(recoveringTabs.has(tabId))return recoveringTabs.get(tabId);
  const recovery=(async()=>{
    let reloaded=false;const deadline=Date.now()+30000;
    for(let i=0;i<120&&Date.now()<deadline;i++){
      const tab=await chrome.tabs.get(tabId);if(parseURL(tab.url)?.origin!=='https://claude.ai')throw Error('Вкладка больше не открыта на Claude. Автовосстановление остановлено.');
      if(tab.status==='loading'){await delay(250);continue;}
      const health=await pageReadiness(tabId);
      if(health.ready&&health.version!==17)throw Error('Обновите расширение и вкладку Claude до версии 0.9.0');
      if(!tab.discarded&&health.ready&&!health.needsReload){healthFailures.delete(tabId);return health;}
      if(!reloaded){
        if(health.hasDraft&&!tab.discarded)throw Error('Во вкладке Claude остался черновик. Обновите её вручную, чтобы продолжить.');
        const history=(recoveryHistory.get(tabId)||[]).filter(time=>Date.now()-time<300000);
        if(history.length>=2||history.length&&Date.now()-history.at(-1)<30000)throw Error('Claude снова не загрузился после восстановления. Проверьте вкладку на Mac.');
        if(!chrome.tabs.reload)throw Error('Обновите вкладку Claude на Mac.');
        history.push(Date.now());recoveryHistory.set(tabId,history);await chrome.storage.local.set({lastStatus:'Восстанавливаем вкладку Claude…'});await chrome.tabs.reload(tabId);reloaded=true;
      }
      await delay(250);
    }
    throw Error('Не удалось восстановить вкладку Claude. Проверьте её на Mac.');
  })();recoveringTabs.set(tabId,recovery);
  try{return await recovery;}finally{recoveringTabs.delete(tabId);}
}
async function watchRun(tabId,message){
  const pending=chrome.tabs.sendMessage(tabId,message).then(value=>({value}),error=>({error}));let misses=0;
  while(true){
    const outcome=await Promise.race([pending,delay(1500).then(()=>null)]);
    if(outcome){if(outcome.error)throw outcome.error;return outcome.value;}
    const tab=await chrome.tabs.get(tabId),health=tab.status==='loading'||tab.discarded?{ready:false}:await pageReadiness(tabId);
    if(tab.status==='loading'||tab.discarded||health.needsReload||!health.ready&&++misses>=2)throw Error('Связь со страницей Claude прервана');
    if(health.ready)misses=0;
  }
}
async function runChat(job,own){
  let message={...job,type:'run'};
  for(let attempt=0;attempt<3;attempt++){
    try{return await watchRun(own.tabId,message);}catch(e){
      if(!own.checkpoint){e.notSent=true;throw e;}
      if(attempt===2)throw Error('Не удалось дочитать ответ после перезагрузки Claude. Повторной отправки не было.');
      await recoverTab(own.tabId);
      message={id:job.id,type:'run',kind:'resume',checkpoint:{...own.checkpoint,url:own.responseURL||own.checkpoint.url},catalogCache:job.catalogCache};
    }
  }
}
async function reserveWorker(job,config){
  if(job.kind==='current')return {tabId:followTabId||config.followTabId||config.tabId};
  const key=job.chatId||job.url||'default';
  let worker=workers.find(w=>w.key===key);
  if(job.followNative){const tabId=followTabId||config.followTabId||config.tabId;worker=workers.find(w=>w.tabId===tabId);if(worker?.busy)throw Error('Во вкладке Claude ещё выполняется действие');if(!worker){worker={tabId};workers.push(worker);}for(const other of workers)if(other!==worker&&!other.busy&&other.key===key)other.key=null;worker.key=key;}
  if(['state','diagnostics'].includes(job.kind)){if(!worker)throw Error('Обновите чат, чтобы подключить его вкладку Claude');return worker;}
  if(worker?.busy)throw Error('В этом чате уже выполняется действие');
  if(!worker){
    worker=workers.find(w=>!w.busy&&(job.url?w.url===job.url:!w.key||w.url==='https://claude.ai/new'||w.url==='https://claude.ai/'))||workers.find(w=>!w.busy);
    if(!worker){
      if(job.kind==='manage'&&workers.length)throw Error('Открытая вкладка Claude занята. Дождитесь завершения текущего действия и повторите действие. Новая вкладка не создавалась.');
      if(workers.length>=6)throw Error('Уже открыто 6 работающих чатов. Дождитесь завершения одного ответа.');
      worker={tabId:workers.length?null:followTabId||config.followTabId||config.tabId};workers.push(worker);
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
    worker=await reserveWorker(job,config);own={id:job.id,tabId:worker.tabId,token:config.token,startedAt:Date.now()};active.set(job.id,own);
    if(job.kind==='open'&&!job.followNative){followTabId=worker.tabId;lastNativeActivation=++activationSequence;await chrome.storage.local.set({followTabId:worker.tabId});}
    const tab=await chrome.tabs.get(worker.tabId),address=parseURL(tab.url);await protectTab(tab);
    if(job.kind==='current'&&tab.status==='loading'){await request('/event',config.token,{id:job.id,type:'done',result:{loading:true}});return;}
    if(address&&address.origin!=='https://claude.ai'&&tab.status!=='loading'&&!worker.requestedURL)throw Error('Выбранная вкладка больше не открыта на claude.ai. Переподключите её.');
    if(address?.origin==='https://claude.ai')worker.url=address.href;
    if(job.kind==='state'&&tab.status!=='loading'&&tab.url&&!samePage(tab.url,chatURL(job.url)))throw Error('Вкладка переключена на другой чат. Обновите текущий чат.');
    const target=['inspect','catalog','diagnostics','current'].includes(job.kind)?(address?.origin==='https://claude.ai'?address.href:tab.pendingUrl||worker.requestedURL||worker.url||chatURL(job.url)):chatURL(job.url);
    if((job.followNative||['chat','options'].includes(job.kind))&&tab.pendingUrl&&!samePage(tab.pendingUrl,target))throw Error('Вкладка Claude переключилась на другой разговор. Сообщение не отправлено.');
    if((job.followNative||['chat','options'].includes(job.kind))&&tab.status!=='loading'&&!samePage(tab.url,target)&&!samePage(worker.requestedURL,target))throw Error('Вкладка Claude переключилась на другой разговор. Обновите текущий чат.');
    // Chrome/Yandex can omit url or return about:blank until a new tab commits.
    // Wait for the requested Claude page; never dispatch based only on pendingUrl.
    if(!['inspect','catalog','state','diagnostics','current','chat','options'].includes(job.kind)&&!job.followNative&&!samePage(tab.url,target)&&!samePage(tab.pendingUrl||worker.requestedURL,target)){await chrome.tabs.update(worker.tabId,{url:target});worker.url=target;worker.requestedURL=target;}
    let started=false,notReady=0;
    for(let i=0;i<200;i++){
      try{const state=await chrome.tabs.get(worker.tabId);if(state.discarded)break;if(state.status==='complete'&&samePage(state.url,target)){const ready=await pageReadiness(worker.tabId);if(ready?.needsReload||!ready?.ready&&++notReady>=3)break;if(ready?.ready){if(ready.version!==17)throw Error('Обновите расширение и вкладку Claude до версии 0.9.0');started=true;break;}}}catch(e){if(e.message?.includes('до версии'))throw e;}
      await delay(100);
    }
    if(!started){await recoverTab(worker.tabId);const restored=await chrome.tabs.get(worker.tabId);if(!samePage(restored.url,target))throw Error('Вкладка Claude переключилась на другой разговор. Сообщение не отправлено.');}
    worker.requestedURL=null;
    jobDispatched=true;
    const result=job.kind==='chat'?await runChat(job,own):await chrome.tabs.sendMessage(worker.tabId,{...job,type:'run'});
    if(result?.error){const error=Error(result.error);error.notSent=result.notSent===true;error.state=result.state;throw error;}
    if(!result?.done)throw Error('Вкладка прервала выполнение');
    if(job.kind==='current'&&result.result?.current)result.result.boundChatId=workers.find(w=>w.tabId===own.tabId)?.key;
    if(job.kind==='current'&&result.result?.current&&job.selectedChatId&&(result.result.url||null)===(job.knownURL||null)&&!workers.some(w=>w.busy&&(w.tabId===own.tabId||w.key===job.selectedChatId))){let bound=workers.find(w=>w.tabId===own.tabId);if(!bound){bound={tabId:own.tabId};workers.push(bound);}for(const other of workers)if(other!==bound&&!other.busy&&other.key===job.selectedChatId)other.key=null;bound.key=job.selectedChatId;bound.url=result.result.url||'https://claude.ai/new';}
    if(job.kind==='manage'&&job.action==='delete'&&result.result?.applied&&conversationEvents)await conversationEvents.waitForDeletion(job.url,own.startedAt);
    if(result.result?.unavailable&&conversationEvents)await conversationEvents.waitForDeletion(job.url,0);
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
    const config=await chrome.storage.local.get(['token','tabId','followTabId']);if(!config.token||!config.tabId)break;
    try{
      const anchor=followTabId||config.followTabId||config.tabId,tab=await chrome.tabs.get(anchor);
      await protectTab(tab);
      if(tab.status==='loading'){await delay(100);continue;}
      if(parseURL(tab.url)?.origin!=='https://claude.ai')throw Error('Откройте выбранную вкладку Claude.');
      let ready=await pageReadiness(anchor);
      const unhealthy=tab.discarded||ready.needsReload||!ready.ready;
      if(unhealthy&&!active.size){const failures=(healthFailures.get(anchor)||0)+1;healthFailures.set(anchor,failures);if(tab.discarded||ready.needsReload||failures>=3)ready=await recoverTab(anchor);}else if(!unhealthy)healthFailures.delete(anchor);
      if(!ready.ready||ready.needsReload){await delay(500);continue;}
      const job=await request('/poll',config.token,undefined,ready.ready?(ready.version??0):0);
      void conversationEvents?.flush().catch(()=>{});
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
    if(message.type==='checkpoint'&&own&&sender.tab.id===own.tabId){
      const c=message.checkpoint;if(!c||!Number.isInteger(c.users)||c.users<0||!Number.isInteger(c.answers)||c.answers<0||typeof c.text!=='string'||c.text.length>20000){respond({ok:false});return;}
      own.checkpoint={url:c.url?chatURL(c.url):null,users:c.users,answers:c.answers,text:c.text,previousUser:typeof c.previousUser==='string'?c.previousUser.slice(0,20000):''};respond({ok:true});return;
    }
    if(message.type==='accepted'&&own&&sender.tab.id===own.tabId){if(message.url)own.responseURL=chatURL(message.url);respond({ok:true});return;}
    if(['update','file','warning'].includes(message.type)&&own&&sender.tab.id===own.tabId){
      if(message.type==='update'&&message.url)own.responseURL=message.url;
      request('/event',own.token,{id:own.id,type:message.type,...(message.type==='update'?{text:message.text,format:message.format,url:message.url}:message.type==='file'?{file:message.file}:{warning:message.warning})}).then(()=>respond({ok:true}),()=>respond({ok:false}));return true;
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
        if(!ready.ready||ready.version!==17)throw Error('Обновите вкладку Claude: её код устарел или не загружен. Затем подключите её заново.');
        await request('/health',message.token,undefined,ready.version);
        await chrome.storage.local.set({token:message.token,tabId:message.tabId,lastStatus:'Связь с вкладкой Claude установлена'});
        followTabId=message.tabId;lastNativeActivation=++activationSequence;await chrome.storage.local.set({followTabId:message.tabId});workers.length=0;generation++;void loop();respond({ok:true});
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
chrome.tabs.onActivated?.addListener(info=>{const sequence=++activationSequence;void chrome.tabs.get(info.tabId).then(async tab=>{if(sequence<lastNativeActivation||parseURL(tab.url)?.origin!=='https://claude.ai')return;const config=await chrome.storage.local.get(['token']);if(!config.token||sequence<lastNativeActivation)return;followTabId=info.tabId;lastNativeActivation=sequence;await chrome.storage.local.set({followTabId:info.tabId});}).catch(()=>{});});
chrome.tabs.onUpdated?.addListener((tabId,change,tab)=>{if(!tab.active||!change.url&&change.status!=='complete'||parseURL(tab.url)?.origin!=='https://claude.ai')return;const sequence=++activationSequence;void chrome.storage.local.get(['token']).then(async config=>{if(!config.token||sequence<lastNativeActivation)return;followTabId=tabId;lastNativeActivation=sequence;await chrome.storage.local.set({followTabId:tabId});}).catch(()=>{});});
chrome.tabs.onRemoved?.addListener(tabId=>{if(followTabId===tabId){followTabId=null;void chrome.storage.local.remove(['followTabId']);}});
void loop();
