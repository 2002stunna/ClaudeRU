const BASE='http://127.0.0.1:3001';
let running=false, active=null, generation=0;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
chrome.storage.local.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'});
async function request(path,token,body){
  const res=await fetch(BASE+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(22000)});
  if(!res.ok)throw Error(res.status===401?'Код подключения неверен. Переподключите расширение.':'Ошибка домашнего сервера: '+res.status);
  return res.json();
}
function chatURL(value){const u=new URL(value || 'https://claude.ai/new');if(u.origin!=='https://claude.ai'||!/^\/(new|chat\/[a-zA-Z0-9-]+)$/.test(u.pathname)||u.search||u.hash||u.username||u.password)throw Error('Неверный адрес чата');return u.href;}
async function perform(job,config){
  const own={id:job.id,tabId:config.tabId,token:config.token};active=own;
  try{
    const tab=await chrome.tabs.get(config.tabId);
    if(new URL(tab.url).origin!=='https://claude.ai')throw Error('Выбранная вкладка больше не открыта на claude.ai. Переподключите её.');
    const target=job.kind==='inspect'?tab.url:chatURL(job.url);
    if(job.kind!=='inspect'&&(tab.url!==target||!job.url))await chrome.tabs.update(config.tabId,{url:target});
    let started=false;
    for(let i=0;i<40;i++){
      await delay(500);
      try{const state=await chrome.tabs.get(config.tabId);if(state.status!=='complete'||state.url!==target)continue;const ready=await chrome.tabs.sendMessage(config.tabId,{type:'ready'});if(ready?.ready){if(ready.version!==3)throw Error('Обновите расширение и вкладку Claude до версии 0.3.0');started=true;break;}}catch(e){if(e.message?.includes('до версии'))throw e;}
    }
    if(!started)throw Error('Вкладка не готова. Обновите её вручную и проверьте вход в Claude.');
    const result=await chrome.tabs.sendMessage(config.tabId,{...job,type:'run'});
    if(result?.error)throw Error(result.error);
    if(!result?.done)throw Error('Вкладка прервала выполнение');
    await request('/event',config.token,{id:job.id,type:'done',result:result.result});
  }catch(e){try{await request('/event',config.token,{id:job.id,type:'error',error:e.message});}catch{}}
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
      const job=await request('/poll',config.token);
      await chrome.storage.local.set({lastStatus:'Домашний сервер подключён'});
      if(job.id){if(active){await request('/event',config.token,{id:job.id,type:'error',error:'Предыдущий запрос ещё выполняется во вкладке. Проверьте Claude на Mac.'});}else void perform(job,config);}
    }catch(e){await chrome.storage.local.set({lastStatus:e.message});await delay(3000);}
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
    chrome.storage.local.set({token:message.token,tabId:message.tabId,lastStatus:'Подключение…'}).then(()=>{generation++;void loop();respond({ok:true});});return true;
  }
  if(message.type==='disconnect'){
    chrome.storage.local.remove(['token','tabId']).then(()=>{generation++;respond({ok:true});});return true;
  }
});
chrome.alarms.create('reconnect',{periodInMinutes:1});
chrome.alarms.onAlarm.addListener(()=>void loop());
chrome.runtime.onStartup.addListener(()=>void loop());
void loop();
