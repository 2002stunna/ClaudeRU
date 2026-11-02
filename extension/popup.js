const status = document.getElementById('status');
document.getElementById('version').textContent='v'+chrome.runtime.getManifest().version;
chrome.storage.local.get(['token','lastStatus']).then(c=>{document.getElementById('token').value=c.token || '';status.textContent=c.lastStatus || 'Не подключено';});
document.getElementById('connect').onclick=async()=>{
  try {
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab?.url || new URL(tab.url).origin!=='https://claude.ai')throw Error('Сначала откройте вкладку claude.ai и нажмите значок расширения на ней.');
    const token=document.getElementById('token').value.trim();
    if(!/^[a-f0-9]{64}$/.test(token))throw Error('Вставьте полный код из терминала сервера.');
    const response=await chrome.runtime.sendMessage({type:'connect',token,tabId:tab.id});
    if(response.error)throw Error(response.error);
    status.textContent='Связь с вкладкой Claude установлена.';
  }catch(e){status.textContent=e.message;}
};
document.getElementById('disconnect').onclick=async()=>{await chrome.runtime.sendMessage({type:'disconnect'});document.getElementById('token').value='';status.textContent='Отключено';};
