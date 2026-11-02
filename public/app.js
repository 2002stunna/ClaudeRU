const $=id=>document.getElementById(id);
let chats=[],selected=null,operation=false,sending=null,catalog=null,catalogError='',lastSyncAttempt=0,sortMode='recent',lastBridgeError=null;
const drafts=new Map();const effortLabels={low:'Низкий',medium:'Средний',high:'Высокий',xhigh:'Сверхвысокий',max:'Максимальный'};
const current=()=>chats.find(c=>c.id===selected);
const draft=()=>{if(!drafts.has(selected))drafts.set(selected,{text:'',files:[]});return drafts.get(selected);};
const status=text=>{$('status').textContent=text;$('status').hidden=!text;};
const svg=name=>{const node=document.createElementNS('http://www.w3.org/2000/svg','svg');node.classList.add('icon');const use=document.createElementNS('http://www.w3.org/2000/svg','use');use.setAttribute('href','#i-'+name);node.append(use);return node;};
async function post(path,body){return fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}
async function api(path,body){const r=body===undefined?await fetch(path):await post(path,body);const data=await r.json();if(!r.ok){if(r.status===401){$('app').hidden=true;$('login').hidden=false;}throw Error(data.error||'Ошибка соединения');}return data;}
function upsert(chat){const i=chats.findIndex(c=>c.id===chat.id);if(i<0)chats.unshift(chat);else chats[i]=chat;return chat;}
function formatSize(size){return size>=1024*1024?(size/1024/1024).toFixed(1)+' МБ':Math.max(1,Math.ceil(size/1024))+' КБ';}
function fileCard(file,removable=false){
  const card=document.createElement('div');card.className='file-card';
  const icon=document.createElement('span');icon.className='file-icon';icon.textContent=file.name.split('.').at(-1).slice(0,5).toUpperCase();
  const info=document.createElement('div'),name=document.createElement('strong'),detail=document.createElement('small');name.textContent=file.name;detail.textContent=formatSize(file.size);info.append(name,detail);
  const download=document.createElement('a');download.href='/api/files/'+encodeURIComponent(file.id);download.download=file.name;download.textContent='↓';download.title='Скачать '+file.name;download.setAttribute('aria-label','Скачать '+file.name);
  card.append(icon,info,download);
  if(/\.(txt|md|json|csv|py|js|ts|css|html|sql|sh|xml|yaml|yml)$/i.test(file.name)){
    const preview=document.createElement('button');preview.type='button';preview.textContent='Просмотр';preview.onclick=async()=>{try{const res=await fetch('/api/files/'+encodeURIComponent(file.id));if(!res.ok)throw Error('Не удалось открыть файл');$('preview-name').textContent=file.name;$('preview-text').textContent=(await res.text()).slice(0,500000);$('preview-download').href=download.href;$('preview-download').download=file.name;$('file-preview').showModal();}catch(e){status(e.message);}};card.append(preview);
  }
  if(removable){const remove=document.createElement('button');remove.type='button';remove.textContent='✕';remove.setAttribute('aria-label','Убрать '+file.name);remove.onclick=()=>{draft().files=draft().files.filter(f=>f.id!==file.id);renderAttachments();};card.append(remove);}
  return card;
}
function appendText(container,text){
  // No model-generated HTML is inserted. Fenced code is displayed as inert text.
  const parts=text.split(/(```[\s\S]*?```)/g);
  for(const part of parts){if(part.startsWith('```')&&part.endsWith('```')){const pre=document.createElement('pre'),code=document.createElement('code');code.textContent=part.slice(3,-3).replace(/^[^\n]*\n/,'');pre.append(code);container.append(pre);}else{const p=document.createElement('div');p.textContent=part;container.append(p);}}
}
function renderSidebar(){
  $('chats').replaceChildren();$('pinned-chats').replaceChildren();const search=$('search').value.trim().toLowerCase();
  const visible=chats.filter(c=>!search||c.title.toLowerCase().includes(search));
  visible.sort(sortMode==='az'?(a,b)=>a.title.localeCompare(b.title,'ru'):(a,b)=>b.updatedAt-a.updatedAt);
  for(const chat of visible){
    const button=document.createElement('button');button.className=chat.id===selected?'selected':'';button.title=chat.title;button.setAttribute('aria-current',String(chat.id===selected));
    const name=document.createElement('span');name.className='chat-name';name.textContent=chat.title+(sending===chat.id?' ···':'');button.append(name);
    if(chat.messages.some(m=>m.files?.length)){const mark=svg('files');mark.classList.add('chat-file-mark');button.append(mark);}
    button.onclick=()=>selectChat(chat.id);(chat.pinned?$('pinned-chats'):$('chats')).append(button);
  }
  $('sidebar-empty').hidden=visible.length>0;
}
function renderMessages(){
  const messages=$('messages');$('workspace').classList.toggle('is-empty',!current()?.messages.length&&current()?.loaded!==false);$('prompt').placeholder=current()?.messages.length?'Ответить…':'Чем я могу вам помочь сегодня?';const nearBottom=messages.scrollHeight-messages.scrollTop-messages.clientHeight<150;messages.replaceChildren();const chat=current();
  if(!chat?.messages.length){const intro=document.createElement('div');intro.className='welcome';intro.textContent=chat?.loaded===false?'Загружаем разговор…':'';messages.append(intro);}
  for(const m of chat?.messages||[]){const article=document.createElement('article');article.className=m.role;if(m.role==='assistant'){const mark=svg('spark');mark.classList.add('claude-mark');article.append(mark);}const label=document.createElement('b');label.textContent=m.role==='user'?'Вы':'Claude';const text=document.createElement('div');text.className='message-text';appendText(text,m.text||'');article.append(label,text);if(!m.text&&m.role==='assistant'&&!m.error){const wait=document.createElement('span');wait.className='typing';wait.textContent='Думает…';article.append(wait);}for(const file of m.files||[])article.append(fileCard(file));if(m.error){const error=document.createElement('p');error.className='message-error';error.textContent=m.error;article.append(error);}messages.append(article);}
  if(nearBottom)messages.scrollTop=messages.scrollHeight;
}
function renderOptions(){
  const settings=current()?.settings||{},model=settings.model||catalog?.current?.model||'',effort=settings.effort||catalog?.current?.effort||'';
  $('model-label').textContent=model||'Выбрать модель';$('effort-label').textContent=effortLabels[effort]||'';
  $('model-toggle').setAttribute('aria-label',model?'Модель: '+model+' '+(effortLabels[effort]||''):'Выбрать модель');
  $('current-model-name').textContent=model||'Подключите Claude';
  $('current-model-detail').textContent=catalog?.current?.description|| (model?'Текущая модель':'Откройте Claude на домашнем Mac');
  $('current-effort-name').textContent=effortLabels[effort]||'Не выбран';
  $('catalog-loading').hidden=!operation||!!catalog;$('catalog-error').hidden=!catalogError;$('catalog-error').textContent=catalogError;
  $('model-submenu').replaceChildren();
  const back=document.createElement('button');back.className='submenu-back';back.textContent='‹ Модель';back.onclick=()=>closeSubmenus();$('model-submenu').append(back);
  const models=[...new Set(catalog?.models||[])];
  for(const value of models){const button=document.createElement('button');button.type='button';button.setAttribute('role','menuitemradio');button.setAttribute('aria-checked',String(value===model));button.dataset.model=value;const name=document.createElement('span');name.textContent=value;button.append(name);if(value===model){const check=svg('check');check.classList.add('checked');button.append(check);}button.onclick=()=>chooseModel(value);$('model-submenu').append(button);}
  if(!models.length){const text=document.createElement('p');text.className='submenu-empty';text.textContent=catalogError||'Список появится после подключения вкладки Claude.';$('model-submenu').append(text);}
  $('effort-options').replaceChildren();
  for(const value of catalog?.efforts||[]){const button=document.createElement('button');button.type='button';button.dataset.effort=value;button.setAttribute('role','menuitemradio');button.setAttribute('aria-checked',String(value===effort));const name=document.createElement('span');name.textContent=effortLabels[value]||value;
    if(value==='medium'){const badge=document.createElement('span');badge.className='effort-recommended';badge.textContent='Рекомендуется';name.append(badge);}
    if(value==='max'){const note=document.createElement('small');note.className='effort-warning';note.textContent='Больше расход лимита';name.append(note);}
    button.append(name);if(value===effort){const check=svg('check');check.classList.add('checked');button.append(check);}button.onclick=()=>chooseEffort(value);$('effort-options').append(button);
  }
  if(!catalog?.efforts?.length){const text=document.createElement('p');text.className='submenu-empty';text.textContent=catalog?'У этой модели уровни усилий не обнаружены.':'Подключите вкладку Claude, чтобы получить уровни усилий.';$('effort-options').append(text);}
  updateControls();
}
function renderAttachments(){$('attachments').replaceChildren(...(draft().files||[]).map(f=>fileCard(f,true)));updateControls();}
function updateControls(){const blocked=operation||!!sending;
  for(const id of ['model-toggle','sync','refresh-models','refresh-chat','attach','other-models-trigger','effort-menu-trigger','chat-title-button'])$(id).disabled=blocked;
  for(const button of document.querySelectorAll('#model-submenu button,#effort-options button'))button.disabled=blocked;
  $('selected-model').disabled=blocked||$('current-model-name').textContent==='Подключите Claude';
  $('send').disabled=blocked||!($('prompt').value.trim()||draft().files.length);$('new-chat').disabled=operation;
  $('catalog-loading').hidden=!operation||!!catalog;
}
function render(){renderSidebar();renderMessages();renderOptions();$('chat-title').textContent=current()?.title||'Новая сессия';$('pin-chat').textContent=current()?.pinned?'Открепить':'Закрепить';$('prompt').value=draft().text;renderAttachments();updateControls();}
async function newChat(){try{const {chat}=await api('/api/chats/new',{settings:current()?.settings||{}});upsert(chat);await selectChat(chat.id);}catch(e){status(e.message);}}
async function selectChat(id){selected=id;localStorage.setItem('clauderu-selected',id);$('sidebar').classList.remove('open');$('sidebar-backdrop').hidden=true;$('toggle-sidebar').setAttribute('aria-expanded','false');status(sending?'Claude продолжает отвечать в выбранном ранее чате…':'');render();$('messages').scrollTop=$('messages').scrollHeight;const chat=current();if(chat?.loaded===false&&!sending&&!operation){operation=true;updateControls();try{const data=await api('/api/chats/open',{id});upsert(data.chat);if(selected===id)render();}catch(e){status(e.message);}finally{operation=false;updateControls();}}}
async function sync({quiet=false}={}){
  if(operation||sending)return;operation=true;lastSyncAttempt=Date.now();updateControls();if(!quiet)status('Обновляем чаты и модели из Claude…');
  try{const data=await api('/api/sync',{});chats=data.chats;catalog=data.catalog;catalogError=catalog?.warning||'';if(!current())selected=chats[0]?.id||null;if(!selected){operation=false;await newChat();operation=true;}render();if(catalogError)status(catalogError);else if(!quiet)status('');}
  catch(e){catalogError=e.message;renderOptions();status(e.message);}finally{operation=false;renderOptions();}
}
async function showApp(){
  $('login').hidden=true;$('app').hidden=false;
  try{
    ({chats}=await api('/api/chats'));
    if(!localStorage.getItem('clauderu-migrated')){
      let legacy=[];try{legacy=JSON.parse(localStorage.getItem('clauderu-chats')||'[]');}catch{}
      if(Array.isArray(legacy)&&legacy.some(c=>c.messages?.length))({chats}=await api('/api/chats/import',{chats:legacy.filter(c=>c.messages?.length)}));
      localStorage.setItem('clauderu-migrated','1');
    }
    selected=localStorage.getItem('clauderu-selected');if(!current())selected=chats[0]?.id||null;
    if(!selected)await newChat();else render();
    await bridgeStatus();
  }catch(e){status(e.message);}
}
$('login-form').onsubmit=async e=>{e.preventDefault();try{await api('/api/login',{password:$('password').value});$('password').value='';await showApp();}catch(e){$('login-error').textContent=e.message;}};
$('logout').onclick=async()=>{await post('/api/logout',{});location.reload();};$('new-chat').onclick=newChat;$('search').oninput=renderSidebar;$('sync').onclick=sync;$('refresh-models').onclick=sync;
$('refresh-chat').onclick=async()=>{const chat=current();if(!chat?.url){status('У этого чата ещё нет адреса в Claude. Сначала отправьте сообщение.');return;}operation=true;updateControls();status('Обновляем разговор и файлы из Claude…');try{const data=await api('/api/chats/open',{id:chat.id});upsert(data.chat);renderMessages();status((data.warnings||[]).join(' '));}catch(e){status(e.message);}finally{operation=false;updateControls();}};
$('toggle-sidebar').onclick=()=>{if(matchMedia('(max-width:700px)').matches){$('sidebar').classList.toggle('open');$('sidebar-backdrop').hidden=!$('sidebar').classList.contains('open');$('toggle-sidebar').setAttribute('aria-expanded',String($('sidebar').classList.contains('open')));}else document.body.classList.remove('sidebar-collapsed');};
$('collapse-sidebar').onclick=()=>{if(matchMedia('(max-width:700px)').matches){$('sidebar').classList.remove('open');$('sidebar-backdrop').hidden=true;}else document.body.classList.add('sidebar-collapsed');};
$('sidebar-backdrop').onclick=()=>$('collapse-sidebar').click();
$('prompt').oninput=()=>{draft().text=$('prompt').value;$('prompt').style.height='auto';$('prompt').style.height=Math.min($('prompt').scrollHeight,260)+'px';updateControls();};
$('prompt').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();if(!$('send').disabled)$('chat-form').requestSubmit();}};
async function chooseModel(model){
  if(operation||sending)return;const chat=current(),previous=chat.settings;closePopovers();operation=true;updateControls();status('Переключаем модель…');
  try{const data=await api('/api/options',{id:chat.id,settings:{model,effort:''}});upsert(data.chat);catalog=data.catalog;catalogError=catalog?.warning||'';status(catalogError);}catch(e){chat.settings=previous;status(e.message);}finally{operation=false;renderOptions();}
}
async function chooseEffort(effort){
  if(operation||sending)return;const chat=current(),model=chat.settings?.model||catalog?.current?.model||'';closePopovers();operation=true;updateControls();
  try{const data=await api('/api/chats/settings',{id:chat.id,settings:{model,effort}});upsert(data.chat);status('');}catch(e){status(e.message);}finally{operation=false;renderOptions();}
}
async function attachFiles(files){
  if(operation||sending)return;const target=draft();const chatId=selected;const list=[...files];
  if(target.files.length+list.length>5){status('Можно прикрепить до 5 файлов');return;}
  if(list.some(f=>f.size>20*1024*1024)||list.reduce((sum,f)=>sum+f.size,0)+target.files.reduce((sum,f)=>sum+f.size,0)>25*1024*1024){status('До 20 МБ на файл и до 25 МБ на все вложения');return;}
  operation=true;updateControls();
  try{for(const file of list){status('Загружаем '+file.name+' на Mac…');const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(Error('Не удалось прочитать файл'));reader.readAsDataURL(file);});const result=await api('/api/uploads',{name:file.name,type:file.type,data});target.files.push(result.file);if(selected===chatId)renderAttachments();}status('Файлы готовы к отправке');}
  catch(e){status(e.message);}finally{operation=false;$('file-input').value='';updateControls();}
}
$('file-input').onchange=()=>attachFiles($('file-input').files);
$('chat-form').ondragover=e=>{e.preventDefault();$('chat-form').classList.add('dragging');};$('chat-form').ondragleave=()=>$('chat-form').classList.remove('dragging');$('chat-form').ondrop=e=>{e.preventDefault();$('chat-form').classList.remove('dragging');void attachFiles(e.dataTransfer.files);};
$('chat-form').onsubmit=async e=>{
  e.preventDefault();if(operation||sending)return;const chat=current(),pending=draft(),text=$('prompt').value.trim();if(!chat||(!text&&!pending.files.length))return;
  const previousTitle=chat.title,files=[...pending.files];pending.text='';pending.files=[];$('prompt').value='';renderAttachments();sending=chat.id;status('Claude отвечает…');
  if(!chat.customTitle&&!chat.messages.length&&text)chat.title=text.slice(0,60);chat.messages.push({role:'user',text,files});const answer={role:'assistant',text:'',files:[]};chat.messages.push(answer);renderMessages();renderSidebar();updateControls();const warnings=[];
  try{
    const res=await post('/api/chat',{chatId:chat.id,text,fileIds:files.map(f=>f.id),settings:chat.settings||{}});if(!res.ok){const data=await res.json();const error=Error(data.error);error.notSent=true;throw error;}
    const reader=res.body.getReader(),decoder=new TextDecoder();let buffer='',done=false;
    while(true){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});let end;
      while((end=buffer.indexOf('\n'))>=0){const event=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
        if(event.type==='error')throw Error(event.error);
        if(event.type==='warning')warnings.push(event.warning);
        if(event.type==='update'){answer.text=event.text;if(event.url)chat.url=event.url;}
        if(event.type==='file')answer.files.push(event.file);
        if(event.type==='done'){done=true;if(event.chat)upsert(event.chat);}
        if(selected===chat.id){renderMessages();$('chat-title').textContent=current().title;}renderSidebar();
      }
    }
    if(!done)throw Error('Соединение прервано. Проверьте чат на Mac перед повторной отправкой.');status(warnings.join(' '));
  }catch(e){if(e.notSent){chat.title=previousTitle;const index=chat.messages.indexOf(answer);if(index>=1)chat.messages.splice(index-1,2);pending.text=text;pending.files=files;if(selected===chat.id){$('prompt').value=text;renderAttachments();}}else answer.error=e.message;status(e.message);if(selected===chat.id)renderMessages();}
  finally{sending=null;updateControls();renderSidebar();}
};
$('close-preview').onclick=()=>$('file-preview').close();
function closeSubmenus(){$('model-submenu').hidden=true;$('effort-submenu').hidden=true;$('other-models-trigger').setAttribute('aria-expanded','false');$('effort-menu-trigger').setAttribute('aria-expanded','false');}
function closePopovers(){for(const id of ['model-menu','attach-menu','account-menu','chat-actions'])$(id).hidden=true;for(const id of ['model-toggle','attach','account-toggle','chat-title-button'])$(id).setAttribute('aria-expanded','false');closeSubmenus();}
function openPopover(id,trigger){const open=$(id).hidden;closePopovers();$(id).hidden=!open;$(trigger).setAttribute('aria-expanded',String(open));if(open)$(id).querySelector('button:not(:disabled)')?.focus();}
$('model-toggle').onclick=()=>{openPopover('model-menu','model-toggle');if(!$('model-menu').hidden&&!catalog&&!operation&&!sending)void sync({quiet:true});};
$('selected-model').onclick=closePopovers;$('effort-back').onclick=closeSubmenus;
function openSubmenu(id,trigger){closeSubmenus();$(id).hidden=false;$(trigger).setAttribute('aria-expanded','true');}
$('other-models-trigger').onclick=()=>{openSubmenu('model-submenu','other-models-trigger');$('model-submenu').querySelector('button:not(.submenu-back):not(:disabled)')?.focus();};
$('effort-menu-trigger').onclick=()=>{openSubmenu('effort-submenu','effort-menu-trigger');$('effort-options').querySelector('button:not(:disabled)')?.focus();};
for(const [id,trigger] of [['model-submenu','other-models-trigger'],['effort-submenu','effort-menu-trigger']])$(trigger).onpointerenter=e=>{if(e.pointerType==='mouse'&&!operation&&!sending&&!$('model-menu').hidden)openSubmenu(id,trigger);};
$('attach').onclick=()=>openPopover('attach-menu','attach');$('upload-files').onclick=()=>{closePopovers();$('file-input').click();};
$('account-toggle').onclick=()=>openPopover('account-menu','account-toggle');$('chat-title-button').onclick=()=>openPopover('chat-actions','chat-title-button');
$('pinned-toggle').onclick=()=>{const hidden=!$('pinned-chats').hidden;$('pinned-chats').hidden=hidden;$('pinned-toggle').setAttribute('aria-expanded',String(!hidden));};
$('recent-sort').onclick=()=>{sortMode=sortMode==='recent'?'az':'recent';$('recent-sort').firstChild.textContent=sortMode==='recent'?'Недавние':'По названию';renderSidebar();};
$('show-search').onclick=()=>{$('search-box').hidden=!$('search-box').hidden;if(!$('search-box').hidden)$('search').focus();else{$('search').value='';renderSidebar();}};
$('rename-chat').onclick=()=>{closePopovers();$('rename-title').value=current()?.title||'';$('rename-dialog').showModal();$('rename-title').focus();};
$('cancel-rename').onclick=()=>$('rename-dialog').close();
$('rename-form').onsubmit=async e=>{e.preventDefault();try{const {chat}=await api('/api/chats/metadata',{id:selected,title:$('rename-title').value});upsert(chat);render();$('rename-dialog').close();}catch(e){status(e.message);}};
$('pin-chat').onclick=async()=>{closePopovers();try{const {chat}=await api('/api/chats/metadata',{id:selected,pinned:!current()?.pinned});upsert(chat);render();}catch(e){status(e.message);}};
function openFiles(onlyCurrent=false){closePopovers();$('files-title').textContent=onlyCurrent?'Файлы разговора':'Артефакты';$('files-description').textContent=onlyCurrent?'Созданные файлы и вложения этого разговора.':'Файлы, созданные Claude в ваших разговорах.';$('files-list').replaceChildren();let count=0;
  for(const chat of onlyCurrent?[current()]:chats){const files=chat.messages.flatMap(m=>onlyCurrent||m.role==='assistant'?m.files||[]:[]);if(!files.length)continue;const heading=document.createElement('p');heading.className='file-group-title';heading.textContent=chat.title;$('files-list').append(heading);const seen=new Set();for(const file of files){if(seen.has(file.id))continue;seen.add(file.id);$('files-list').append(fileCard(file));count++;}}
  if(!count){const empty=document.createElement('p');empty.className='submenu-empty';empty.textContent='Здесь появятся файлы из ответов Claude.';$('files-list').append(empty);}$('files-library').showModal();}
$('show-files').onclick=()=>openFiles();$('chat-files').onclick=()=>openFiles(true);$('close-files').onclick=()=>$('files-library').close();
document.addEventListener('pointerdown',e=>{if(!e.target.closest('.menu-anchor,footer,.header-start'))closePopovers();});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){const active=document.activeElement;const trigger=active?.closest('#attach-menu')?'attach':active?.closest('#account-menu')?'account-toggle':active?.closest('#chat-actions')?'chat-title-button':active?.closest('.popover')?'model-toggle':null;closePopovers();if(trigger)$(trigger).focus();return;}
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();$('search-box').hidden=false;$('search').focus();}
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='u'){e.preventDefault();if(!operation&&!sending)$('file-input').click();}
  if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){const menu=document.activeElement?.closest('[role="menu"]');if(!menu)return;const buttons=[...menu.querySelectorAll('button:not(:disabled)')].filter(b=>b.getClientRects().length);if(!buttons.length)return;e.preventDefault();const i=buttons.indexOf(document.activeElement);const index=e.key==='Home'?0:e.key==='End'?buttons.length-1:(i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;buttons[index].focus();}
  if(e.key==='ArrowLeft'&&!$('model-menu').hidden){closeSubmenus();$('other-models-trigger').focus();}
});
async function bridgeStatus(){try{const r=await fetch('/api/bridge');if(!r.ok)return;const state=await r.json();document.querySelector('.badge').textContent=state.connected?'Mac подключён':'Mac не подключён';document.querySelector('.badge').dataset.connected=String(state.connected);$('account-toggle').querySelector('.account-state').textContent=state.connected?'Домашний Mac · онлайн':'Домашний Mac · офлайн';if(state.error){lastBridgeError=state.error;catalogError=state.error;if(!operation&&!sending){status(state.error);renderOptions();}}else if(lastBridgeError){if(catalogError===lastBridgeError)catalogError='';if($('status').textContent===lastBridgeError)status('');lastBridgeError=null;renderOptions();}if(state.connected&&!state.busy&&!catalog&&!operation&&!sending&&Date.now()-lastSyncAttempt>20000)await sync({quiet:true});}catch{document.querySelector('.badge').textContent='Нет связи с Mac';}}
setInterval(bridgeStatus,10000);
fetch('/api/session').then(r=>r.json()).then(s=>{if(s.authenticated)showApp();}).catch(()=>{$('login-error').textContent='Нет связи с домашним Mac';});
