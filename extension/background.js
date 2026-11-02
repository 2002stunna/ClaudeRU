const BASE='http://127.0.0.1:3001';
let running=false, active=null, generation=0;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
chrome.storage.local.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'});
async function request(path,token,body,pageProtocol=0){
  const res=await fetch(BASE+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'X-ClaudeRU-Protocol':'5','X-ClaudeRU-Page-Protocol':String(pageProtocol),'X-ClaudeRU-Version':chrome.runtime.getManifest().version,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(22000)});
  const data=await res.json().catch(()=>({}));
  if(!res.ok)throw Error(res.status===401?'Код подключения неверен. Переподключите расширение.':res.status===404&&path==='/health'?'Обновите и перезапустите сервер ClaudeRU на Mac.':data.error||'Ошибка домашнего сервера: '+res.status);
  return data;
}
async function pageReadiness(tabId){try{return await chrome.tabs.sendMessage(tabId,{type:'ready'});}catch{return {ready:false,version:0};}}
function chatURL(value){const u=new URL(value || 'https://claude.ai/new');if(u.origin!=='https://claude.ai'||!/^\/(new|chat\/[a-zA-Z0-9-]+)$/.test(u.pathname)||u.search||u.hash||u.username||u.password)throw Error('Неверный адрес чата');return u.href;}
function samePage(current,target){
  const from=new URL(current),to=new URL(target);
  if(from.origin!==to.origin)return false;
  const pathname=from.pathname.replace(/\/$/,'')||'/';
  return pathname===to.pathname.replace(/\/$/,'')||(to.pathname==='/new'&&pathname==='/');
}
async function perform(job,config){
  const own={id:job.id,tabId:config.tabId,token:config.token};active=own;let jobDispatched=false;
  try{
    const tab=await chrome.tabs.get(config.tabId);
    if(new URL(tab.url).origin!=='https://claude.ai')throw Error('Выбранная вкладка больше не открыта на claude.ai. Переподключите её.');
    const target=job.kind==='inspect'?tab.url:chatURL(job.url);
    if(job.kind!=='inspect'&&!samePage(tab.url,target))await chrome.tabs.update(config.tabId,{url:target});
    let started=false;
    for(let i=0;i<200;i++){
      try{const state=await chrome.tabs.get(config.tabId);if(state.status==='complete'&&samePage(state.url,target)){const ready=await chrome.tabs.sendMessage(config.tabId,{type:'ready'});if(ready?.ready){if(ready.version!==5)throw Error('Обновите расширение и вкладку Claude до версии 0.4.3');started=true;break;}}}catch(e){if(e.message?.includes('до версии'))throw e;}
      await delay(100);
    }
    if(!started)throw Error('Вкладка не готова. Обновите её вручную и проверьте вход в Claude.');
    jobDispatched=true;
    const result=await chrome.tabs.sendMessage(config.tabId,{...job,type:'run'});
    if(result?.error){const error=Error(result.error);error.notSent=result.notSent===true;throw error;}
    if(!result?.done)throw Error('Вкладка прервала выполнение');
    await request('/event',config.token,{id:job.id,type:'done',result:result.result});
  }catch(e){try{await request('/event',config.token,{id:job.id,type:'error',error:e.message,notSent:e.notSent===true||!jobDispatched});}catch{}}
  finally{if(active===own)active=null;}
}
async function loop(){
  if(running)return;running=true;
  const current=generation;
  try{while(current===generation){
    const config=await chrome.storage.local.get(['token','tabId']);if(!config.token||!config.tabId)break;
    try{
      const tab=await chrome.tabs.get(config.tabId);
      if(!tab.url || new URL(tab.url).origin!=='https://claude.ai')throw Error('Откройте выбранную вкладку Claude.');
      if(tab.status==='loading'){await delay(500);continue;}
      const ready=await pageReadiness(config.tabId);
      const job=await request('/poll',config.token,undefined,ready.ready?(ready.version??0):0);
      await chrome.storage.local.set({lastStatus:'Домашний сервер подключён'});
      if(job.id){if(active){await request('/event',config.token,{id:job.id,type:'error',error:'Предыдущий запрос ещё выполняется во вкладке. Проверьте Claude на Mac.'});}else void perform(job,config);}
    }catch(e){await chrome.storage.local.set({lastStatus:e.message});await delay(1000);}
  }}finally{running=false;if(current!==generation)void loop();}
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.tab){
    if(['update','file','warning'].includes(message.type)&&active&&sender.tab.id===active.tabId&&message.id===active.id){
      request('/event',active.token,{id:active.id,type:message.type,...(message.type==='update'?{text:message.text,url:message.url}:message.type==='file'?{file:message.file}:{warning:message.warning})}).then(()=>respond({ok:true}),()=>respond({ok:false}));return true;
    }
    return;
  }
  // Only our own popup may change the pairing.
  if(sender.id!==chrome.runtime.id || sender.url!==chrome.runtime.getURL('popup.html'))return;
  if(message.type==='connect'){
    if(active){respond({error:'Дождитесь завершения текущего ответа.'});return;}
    (async()=>{
      try{
        const tab=await chrome.tabs.get(message.tabId);
        if(!tab.url||new URL(tab.url).origin!=='https://claude.ai')throw Error('Откройте вкладку claude.ai и подключите её.');
        const ready=await pageReadiness(message.tabId);
        if(!ready.ready||ready.version!==5)throw Error('Обновите вкладку Claude: её код устарел или не загружен. Затем подключите её заново.');
        await request('/health',message.token,undefined,ready.version);
        await chrome.storage.local.set({token:message.token,tabId:message.tabId,lastStatus:'Связь с вкладкой Claude установлена'});
        generation++;void loop();respond({ok:true});
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
