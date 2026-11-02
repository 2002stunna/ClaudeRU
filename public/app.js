const $=id=>document.getElementById(id);
let chats=[],selected=null,operation=false,sending=new Set(),catalog=null,catalogError='',lastSyncAttempt=0,sortMode='recent',lastBridgeError=null;
let statusRequestInFlight=false,stateRequestInFlight=false,contextChat=null,renameTarget=null,archiveView=false,pendingSelection=null;const remoteBusy=new Set();
const busyHere=()=>sending.has(selected)||remoteBusy.has(selected);
const messageNodes=new WeakMap();
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
  $('chats').replaceChildren();$('pinned-chats').replaceChildren();$('grouped-chats').replaceChildren();const groups=new Map();const search=$('search').value.trim().toLowerCase();
  const visible=chats.filter(c=>!!c.archived===archiveView&&(!search||c.title.toLowerCase().includes(search)));
  visible.sort(sortMode==='az'?(a,b)=>a.title.localeCompare(b.title,'ru'):(a,b)=>b.updatedAt-a.updatedAt);
  for(const chat of visible){
    const button=document.createElement('button');const row=document.createElement('div');row.className='chat-row'+(chat.id===selected?' selected':'')+(chat.unread?' unread':'');button.className=chat.id===selected?'selected':'';button.title=chat.title;button.setAttribute('aria-current',String(chat.id===selected));
    const name=document.createElement('span');name.className='chat-name';name.textContent=chat.title+(sending.has(chat.id)?' ···':'');button.append(name);
    if(chat.messages.some(m=>m.files?.length)){const mark=svg('files');mark.classList.add('chat-file-mark');button.append(mark);}
    button.onclick=()=>selectChat(chat.id);const more=document.createElement('button');more.type='button';more.className='chat-more';more.textContent='…';more.setAttribute('aria-label','Действия: '+chat.title);more.setAttribute('aria-haspopup','menu');more.onclick=e=>{e.stopPropagation();openChatContext(chat,more);};row.append(button,more);let target=chat.pinned?$('pinned-chats'):$('chats');if(chat.group&&!chat.pinned){if(!groups.has(chat.group)){const section=document.createElement('details');section.open=true;const heading=document.createElement('summary');heading.textContent=chat.group;heading.className='section-label';const nav=document.createElement('nav');nav.setAttribute('aria-label',chat.group);section.append(heading,nav);$('grouped-chats').append(section);groups.set(chat.group,nav);}target=groups.get(chat.group);}target.append(row);
  }
  $('sidebar-empty').hidden=visible.length>0;
}
function renderMessages(){
  const messages=$('messages');$('workspace').classList.toggle('is-empty',!current()?.messages.length&&current()?.loaded!==false);$('prompt').placeholder=current()?.messages.length?'Ответить…':'Чем я могу вам помочь сегодня?';const nearBottom=messages.scrollHeight-messages.scrollTop-messages.clientHeight<150;messages.replaceChildren();const chat=current();
  if(!chat?.messages.length){const intro=document.createElement('div');intro.className='welcome';intro.textContent=chat?.loaded===false?'Загружаем разговор…':'';messages.append(intro);}
  for(const m of chat?.messages||[]){const article=document.createElement('article');article.className=m.role;messageNodes.set(m,article);if(m.role==='assistant'){const mark=svg('spark');mark.classList.add('claude-mark');article.append(mark);}const label=document.createElement('b');label.textContent=m.role==='user'?'Вы':'Claude';const text=document.createElement('div');text.className='message-text';appendText(text,m.text||'');article.append(label,text);if(!m.text&&m.role==='assistant'&&!m.error){const wait=document.createElement('span');wait.className='typing';wait.textContent='Думает…';article.append(wait);}for(const file of m.files||[])article.append(fileCard(file));if(m.error){const error=document.createElement('p');error.className='message-error';error.textContent=m.error;article.append(error);}messages.append(article);}
  if(nearBottom)messages.scrollTop=messages.scrollHeight;
}
function updateStreamingMessage(answer,event){
  const article=messageNodes.get(answer);if(!article?.isConnected){renderMessages();return;}
  const messages=$('messages'),atBottom=messages.scrollHeight-messages.scrollTop-messages.clientHeight<150;
  if(event.type==='update'){const text=article.querySelector('.message-text');text.replaceChildren();appendText(text,answer.text);article.querySelector('.typing')?.remove();}
  if(event.type==='file')article.append(fileCard(event.file));
  if(atBottom)messages.scrollTop=messages.scrollHeight;
}
function renderOptions(){
  const options=current()?.catalog||catalog,settings=current()?.settings||{},model=settings.model||'',effort=settings.effort||'';
  $('model-label').textContent=model||'Выбрать модель';$('effort-label').textContent=effortLabels[effort]||'';
  $('model-toggle').setAttribute('aria-label',model?'Модель: '+model+' '+(effortLabels[effort]||''):'Выбрать модель');
  $('current-model-name').textContent=model||'Подключите Claude';
  if(current()?.claudeState?.streaming&&!busyHere())status('Claude отвечает в этом чате…');else if($('status').textContent==='Claude отвечает в этом чате…')status('');
  $('current-model-detail').textContent=current()?.catalog?.current?.description|| (model?'Текущая модель':'Откройте Claude на домашнем Mac');
  $('current-effort-name').textContent=effortLabels[effort]||'Не выбран';
  $('catalog-loading').hidden=!operation||!!catalog;$('catalog-error').hidden=!catalogError;$('catalog-error').textContent=catalogError;
  $('model-submenu').replaceChildren();
  const back=document.createElement('button');back.className='submenu-back';back.textContent='‹ Модель';back.onclick=()=>closeSubmenus();$('model-submenu').append(back);
  const models=[...new Set(options?.models||[])];
  for(const value of models){const button=document.createElement('button');button.type='button';button.setAttribute('role','menuitemradio');button.setAttribute('aria-checked',String(value===model));button.dataset.model=value;const name=document.createElement('span');name.textContent=value;button.append(name);if(value===model){const check=svg('check');check.classList.add('checked');button.append(check);}button.onclick=()=>chooseModel(value);$('model-submenu').append(button);}
  if(!models.length){const text=document.createElement('p');text.className='submenu-empty';text.textContent=catalogError||'Список появится после подключения вкладки Claude.';$('model-submenu').append(text);}
  $('effort-options').replaceChildren();
  for(const value of options?.efforts||[]){const button=document.createElement('button');button.type='button';button.dataset.effort=value;button.setAttribute('role','menuitemradio');button.setAttribute('aria-checked',String(value===effort));const name=document.createElement('span');name.textContent=effortLabels[value]||value;
    if(value==='medium'){const badge=document.createElement('span');badge.className='effort-recommended';badge.textContent='Рекомендуется';name.append(badge);}
    if(value==='max'){const note=document.createElement('small');note.className='effort-warning';note.textContent='Больше расход лимита';name.append(note);}
    button.append(name);if(value===effort){const check=svg('check');check.classList.add('checked');button.append(check);}button.onclick=()=>chooseEffort(value);$('effort-options').append(button);
  }
  if(!options?.efforts?.length){const text=document.createElement('p');text.className='submenu-empty';text.textContent=catalog?'У этой модели уровни усилий не обнаружены.':'Подключите вкладку Claude, чтобы получить уровни усилий.';$('effort-options').append(text);}
  updateControls();
}
function renderAttachments(){$('attachments').replaceChildren(...(draft().files||[]).map(f=>fileCard(f,true)));updateControls();}
function updateControls(){const blocked=operation||busyHere()||current()?.claudeState?.streaming===true;
  for(const id of ['model-toggle','sync','refresh-models','refresh-chat','attach','other-models-trigger','effort-menu-trigger','chat-title-button'])$(id).disabled=blocked;
  for(const button of document.querySelectorAll('#model-submenu button,#effort-options button'))button.disabled=blocked;
  $('selected-model').disabled=blocked||$('current-model-name').textContent==='Подключите Claude';
  $('claude-notice').textContent=current()?.claudeState?.blocked||'';$('claude-notice').hidden=!$('claude-notice').textContent;
  $('send').disabled=blocked||!!current()?.claudeState?.blocked||!($('prompt').value.trim()||draft().files.length);$('new-chat').disabled=operation;
  $('catalog-loading').hidden=!operation||!!catalog;
}
function render(){renderSidebar();renderMessages();renderOptions();$('chat-title').textContent=current()?.title||'Новая сессия';$('pin-chat').textContent=current()?.pinned?'Открепить':'Закрепить';$('prompt').value=draft().text;renderAttachments();updateControls();}
async function newChat(){try{const {chat}=await api('/api/chats/new',{settings:{}});upsert(chat);await selectChat(chat.id);}catch(e){status(e.message);}}
async function selectChat(id){
  selected=id;localStorage.setItem('clauderu-selected',id);$('sidebar').classList.remove('open');$('sidebar-backdrop').hidden=true;$('toggle-sidebar').setAttribute('aria-expanded','false');closePopovers();status(sending.has(id)?'Claude отвечает…':'');render();$('messages').scrollTop=$('messages').scrollHeight;
  if(!busyHere()){if(operation)pendingSelection=id;else await refreshSelected(id);}
}
function finishOperation(){operation=false;updateControls();const id=pendingSelection;pendingSelection=null;if(id&&selected===id&&!busyHere())void refreshSelected(id);}
async function refreshSelected(id=selected,{collectArtifacts=false}={}){
  if(operation)return;operation=true;updateControls();
  try{const data=await api('/api/chats/open',{id,collectArtifacts});upsert(data.chat);if(data.catalog){catalog={...catalog,...data.catalog,models:[...new Set([...(catalog?.models||[]),...(data.catalog.models||[])])]};catalogError=data.catalog.warning||'';}if(selected===id){render();status((data.warnings||[]).join(' '));}}
  catch(e){if(selected===id)status(e.message);}finally{finishOperation();}
}
async function sync({quiet=false}={}){
  if(operation||busyHere())return;operation=true;lastSyncAttempt=Date.now();updateControls();if(!quiet)status('Обновляем чаты и модели из Claude…');
  try{let prepared=false;const data=await api('/api/sync',{});chats=data.chats.map(c=>sending.has(c.id)?chats.find(local=>local.id===c.id)||c:c);catalog={...catalog,...data.catalog,models:[...new Set([...(catalog?.models||[]),...(data.catalog.models||[])])]};catalogError=catalog?.warning||'';if(!current())selected=chats[0]?.id||null;if(!selected){operation=false;await newChat();operation=true;prepared=true;}render();if(catalogError)status(catalogError);else if(!quiet)status('');operation=false;if(!prepared&&!busyHere())await refreshSelected();operation=true;}
  catch(e){catalogError=e.message;renderOptions();status(e.message);}finally{finishOperation();renderOptions();}
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
    if(!selected){const bridge=await api('/api/bridge');if(bridge.connected)await sync({quiet:true});if(!selected)await newChat();}else{render();await refreshSelected();}
    await bridgeStatus();
  }catch(e){status(e.message);}
}
$('login-form').onsubmit=async e=>{e.preventDefault();try{await api('/api/login',{password:$('password').value});$('password').value='';await showApp();}catch(e){$('login-error').textContent=e.message;}};
$('logout').onclick=async()=>{await post('/api/logout',{});location.reload();};$('new-chat').onclick=newChat;$('search').oninput=renderSidebar;$('sync').onclick=sync;$('refresh-models').onclick=sync;
$('refresh-chat').onclick=()=>refreshSelected(selected,{collectArtifacts:true});
$('toggle-sidebar').onclick=()=>{if(matchMedia('(max-width:700px)').matches){$('sidebar').classList.toggle('open');$('sidebar-backdrop').hidden=!$('sidebar').classList.contains('open');$('toggle-sidebar').setAttribute('aria-expanded',String($('sidebar').classList.contains('open')));}else document.body.classList.remove('sidebar-collapsed');};
$('collapse-sidebar').onclick=()=>{if(matchMedia('(max-width:700px)').matches){$('sidebar').classList.remove('open');$('sidebar-backdrop').hidden=true;}else document.body.classList.add('sidebar-collapsed');};
$('sidebar-backdrop').onclick=()=>$('collapse-sidebar').click();
$('prompt').oninput=()=>{draft().text=$('prompt').value;$('prompt').style.height='auto';$('prompt').style.height=Math.min($('prompt').scrollHeight,260)+'px';updateControls();};
$('prompt').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();if(!$('send').disabled)$('chat-form').requestSubmit();}};
async function chooseModel(model){
  if(operation||busyHere())return;const chat=current(),previous=chat.settings;closePopovers();operation=true;updateControls();status('Переключаем модель…');
  try{const data=await api('/api/options',{id:chat.id,settings:{model,effort:''}});upsert(data.chat);catalog={...catalog,...data.catalog,models:[...new Set([...(catalog?.models||[]),...(data.catalog.models||[])])]};catalogError=catalog?.warning||'';status(catalogError);}catch(e){chat.settings=previous;status(e.message);}finally{finishOperation();renderOptions();}
}
async function chooseEffort(effort){
  if(operation||busyHere())return;const chat=current(),model=chat.settings?.model||'';closePopovers();operation=true;updateControls();
  try{const data=await api('/api/options',{id:chat.id,settings:{model,effort}});upsert(data.chat);if(data.catalog)catalog={...catalog,...data.catalog,models:[...new Set([...(catalog?.models||[]),...(data.catalog.models||[])])]};status('');}catch(e){status(e.message);}finally{finishOperation();renderOptions();}
}
async function attachFiles(files){
  if(operation||busyHere())return;const target=draft();const chatId=selected;const list=[...files];
  if(target.files.length+list.length>5){status('Можно прикрепить до 5 файлов');return;}
  if(list.some(f=>f.size>20*1024*1024)||list.reduce((sum,f)=>sum+f.size,0)+target.files.reduce((sum,f)=>sum+f.size,0)>25*1024*1024){status('До 20 МБ на файл и до 25 МБ на все вложения');return;}
  operation=true;updateControls();
  try{for(const file of list){status('Загружаем '+file.name+' на Mac…');const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=()=>reject(Error('Не удалось прочитать файл'));reader.readAsDataURL(file);});const result=await api('/api/uploads',{name:file.name,type:file.type,data});target.files.push(result.file);if(selected===chatId)renderAttachments();}status('Файлы готовы к отправке');}
  catch(e){status(e.message);}finally{operation=false;$('file-input').value='';updateControls();}
}
$('file-input').onchange=()=>attachFiles($('file-input').files);
$('chat-form').ondragover=e=>{e.preventDefault();$('chat-form').classList.add('dragging');};$('chat-form').ondragleave=()=>$('chat-form').classList.remove('dragging');$('chat-form').ondrop=e=>{e.preventDefault();$('chat-form').classList.remove('dragging');void attachFiles(e.dataTransfer.files);};
$('chat-form').onsubmit=async e=>{
  e.preventDefault();if(operation||busyHere())return;const chat=current(),pending=draft(),text=$('prompt').value.trim();if(!chat||(!text&&!pending.files.length))return;
  const previousTitle=chat.title,files=[...pending.files];pending.text='';pending.files=[];$('prompt').value='';renderAttachments();sending.add(chat.id);status('Claude отвечает…');
  if(!chat.customTitle&&!chat.messages.length&&text)chat.title=text.slice(0,60);chat.messages.push({role:'user',text,files});const answer={role:'assistant',text:'',files:[]};chat.messages.push(answer);renderMessages();renderSidebar();updateControls();const warnings=[];
  try{
    const res=await post('/api/chat',{chatId:chat.id,text,fileIds:files.map(f=>f.id),settings:chat.settings||{}});if(!res.ok){const data=await res.json();const error=Error(data.error);error.notSent=true;throw error;}
    const reader=res.body.getReader(),decoder=new TextDecoder();let buffer='',done=false;
    while(true){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});let end;
      while((end=buffer.indexOf('\n'))>=0){const event=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
        if(event.type==='error'){if(event.state){chat.claudeState=event.state;chat.settings={model:event.state.model,effort:event.state.effort};}const error=Error(event.error);error.notSent=event.notSent===true;throw error;}
        if(event.type==='warning')warnings.push(event.warning);
        if(event.type==='update'){answer.text=event.text;if(event.url)chat.url=event.url;}
        if(event.type==='file')answer.files.push(event.file);
        if(event.type==='done'){done=true;if(event.chat)upsert(event.chat);}
        if(selected===chat.id){if(event.type==='done')renderMessages();else if(event.type==='update'||event.type==='file')updateStreamingMessage(answer,event);$('chat-title').textContent=current().title;}if(event.type==='done')renderSidebar();
      }
    }
    if(!done)throw Error('Соединение прервано. Проверьте чат на Mac перед повторной отправкой.');if(selected===chat.id)status(warnings.join(' '));
  }catch(e){if(e.notSent){chat.title=previousTitle;const index=chat.messages.indexOf(answer);if(index>=1)chat.messages.splice(index-1,2);pending.text=text;pending.files=files;if(selected===chat.id){$('prompt').value=text;renderAttachments();}}else answer.error=e.message;if(selected===chat.id){status(e.message);renderMessages();}}
  finally{sending.delete(chat.id);renderOptions();renderSidebar();}
};
$('close-preview').onclick=()=>$('file-preview').close();
function closeSubmenus(){$('model-submenu').hidden=true;$('effort-submenu').hidden=true;$('other-models-trigger').setAttribute('aria-expanded','false');$('effort-menu-trigger').setAttribute('aria-expanded','false');}
function closePopovers(){for(const id of ['model-menu','attach-menu','account-menu','chat-actions','chat-context'])$(id).hidden=true;for(const id of ['model-toggle','attach','account-toggle','chat-title-button'])$(id).setAttribute('aria-expanded','false');closeSubmenus();}
function openPopover(id,trigger){const open=$(id).hidden;closePopovers();$(id).hidden=!open;$(trigger).setAttribute('aria-expanded',String(open));if(open)$(id).querySelector('button:not(:disabled)')?.focus();}
$('model-toggle').onclick=()=>{openPopover('model-menu','model-toggle');if(!$('model-menu').hidden&&(!catalog||!lastSyncAttempt)&&!operation&&!busyHere())void sync({quiet:true});};
$('selected-model').onclick=closePopovers;$('effort-back').onclick=closeSubmenus;
function openSubmenu(id,trigger){closeSubmenus();$(id).hidden=false;$(trigger).setAttribute('aria-expanded','true');}
$('other-models-trigger').onclick=()=>{openSubmenu('model-submenu','other-models-trigger');$('model-submenu').querySelector('button:not(.submenu-back):not(:disabled)')?.focus();};
$('effort-menu-trigger').onclick=()=>{openSubmenu('effort-submenu','effort-menu-trigger');$('effort-options').querySelector('button:not(:disabled)')?.focus();};
for(const [id,trigger] of [['model-submenu','other-models-trigger'],['effort-submenu','effort-menu-trigger']])$(trigger).onpointerenter=e=>{if(e.pointerType==='mouse'&&!operation&&!busyHere()&&!$('model-menu').hidden)openSubmenu(id,trigger);};
$('attach').onclick=()=>openPopover('attach-menu','attach');$('upload-files').onclick=()=>{closePopovers();$('file-input').click();};
$('account-toggle').onclick=()=>openPopover('account-menu','account-toggle');$('chat-title-button').onclick=()=>openPopover('chat-actions','chat-title-button');
$('pinned-toggle').onclick=()=>{const hidden=!$('pinned-chats').hidden;$('pinned-chats').hidden=hidden;$('pinned-toggle').setAttribute('aria-expanded',String(!hidden));};
$('recent-sort').onclick=()=>{sortMode=sortMode==='recent'?'az':'recent';$('recent-sort').firstChild.textContent=sortMode==='recent'?'Недавние':'По названию';renderSidebar();};
$('show-search').onclick=()=>{$('search-box').hidden=!$('search-box').hidden;if(!$('search-box').hidden)$('search').focus();else{$('search').value='';renderSidebar();}};
function requestRename(chat){closePopovers();renameTarget=chat.id;$('rename-title').value=chat.title;$('rename-dialog').showModal();$('rename-title').focus();}
$('rename-chat').onclick=()=>requestRename(current());
$('cancel-rename').onclick=()=>$('rename-dialog').close();
$('rename-form').onsubmit=async e=>{e.preventDefault();await performChatAction(renameTarget,'rename',{title:$('rename-title').value});};
$('pin-chat').onclick=()=>performChatAction(selected,current()?.pinned?'unpin':'pin');
async function performChatAction(id,action,fields={}){
  closePopovers();if(operation||sending.has(id)||remoteBusy.has(id))return;operation=true;updateControls();status('Сохраняем изменение в Claude…');
  try{
    const data=await api('/api/chats/action',{id,action,...fields});
    if(data.groups){$('group-list').replaceChildren();for(const group of data.groups){const button=document.createElement('button');button.textContent=group;button.onclick=()=>{$('group-dialog').close();void performChatAction(id,'move',{group});};$('group-list').append(button);}if(!data.groups.length)$('group-list').textContent='В Claude пока нет доступных групп.';$('group-dialog').showModal();}
    else{if(action==='delete')chats=chats.filter(c=>c.id!==id);else if(data.chat)upsert(data.chat);$('rename-dialog').close();if(id===selected&&['delete','archive'].includes(action)){selected=chats.find(c=>!c.archived)?.id||null;if(!selected){operation=false;await newChat();operation=true;}}render();status('');}
  }catch(e){status(e.message);}finally{finishOperation();}
}
function openChatContext(chat,trigger){
  closePopovers();contextChat=chat.id;const menu=$('chat-context');menu.replaceChildren();
  for(const [action,text] of [['unread','Отметить как непрочитанное'],[chat.pinned?'unpin':'pin',chat.pinned?'Открепить':'Закрепить'],['rename','Переименовать'],['move','Переместить в группу'],['archive','Архивировать'],['delete','Удалить']]){
    const button=document.createElement('button');button.type='button';button.setAttribute('role','menuitem');button.dataset.action=action;button.textContent=text;button.disabled=operation||sending.has(chat.id)||remoteBusy.has(chat.id);if(action==='delete')button.className='danger';button.onclick=()=>{if(action==='rename')requestRename(chat);else if(action==='delete'){closePopovers();$('delete-title').textContent='Удалить «'+chat.title+'» из Claude?';$('delete-dialog').showModal();}else void performChatAction(chat.id,action);};menu.append(button);
  }
  const rect=trigger.getBoundingClientRect();menu.hidden=false;menu.style.left=Math.max(8,Math.min(rect.left,innerWidth-300))+'px';menu.style.top=Math.max(8,Math.min(rect.bottom,innerHeight-menu.offsetHeight-8))+'px';menu.querySelector('button:not(:disabled)')?.focus();
}
$('confirm-delete').onclick=()=>{$('delete-dialog').close();void performChatAction(contextChat,'delete');};$('cancel-delete').onclick=()=>$('delete-dialog').close();$('close-groups').onclick=()=>$('group-dialog').close();
$('show-archive').onclick=()=>{archiveView=!archiveView;$('show-archive').classList.toggle('active',archiveView);renderSidebar();};
function openFiles(onlyCurrent=false){closePopovers();$('files-title').textContent=onlyCurrent?'Файлы разговора':'Артефакты';$('files-description').textContent=onlyCurrent?'Созданные файлы и вложения этого разговора.':'Файлы, созданные Claude в ваших разговорах.';$('files-list').replaceChildren();let count=0;
  for(const chat of onlyCurrent?[current()]:chats){const files=chat.messages.flatMap(m=>onlyCurrent||m.role==='assistant'?m.files||[]:[]);if(!files.length)continue;const heading=document.createElement('p');heading.className='file-group-title';heading.textContent=chat.title;$('files-list').append(heading);const seen=new Set();for(const file of files){if(seen.has(file.id))continue;seen.add(file.id);$('files-list').append(fileCard(file));count++;}}
  if(!count){const empty=document.createElement('p');empty.className='submenu-empty';empty.textContent='Здесь появятся файлы из ответов Claude.';$('files-list').append(empty);}$('files-library').showModal();}
$('show-files').onclick=()=>openFiles();$('chat-files').onclick=()=>openFiles(true);$('close-files').onclick=()=>$('files-library').close();
document.addEventListener('pointerdown',e=>{if(!e.target.closest('.menu-anchor,footer,.header-start,.chat-row,#chat-context'))closePopovers();});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){const active=document.activeElement;const trigger=active?.closest('#attach-menu')?'attach':active?.closest('#account-menu')?'account-toggle':active?.closest('#chat-actions')?'chat-title-button':active?.closest('.popover')?'model-toggle':null;closePopovers();if(trigger)$(trigger).focus();return;}
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();$('search-box').hidden=false;$('search').focus();}
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='u'){e.preventDefault();if(!operation&&!busyHere())$('file-input').click();}
  if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){const menu=document.activeElement?.closest('[role="menu"]');if(!menu)return;const buttons=[...menu.querySelectorAll('button:not(:disabled)')].filter(b=>b.getClientRects().length);if(!buttons.length)return;e.preventDefault();const i=buttons.indexOf(document.activeElement);const index=e.key==='Home'?0:e.key==='End'?buttons.length-1:(i+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;buttons[index].focus();}
  if(e.key==='ArrowLeft'&&!$('model-menu').hidden){closeSubmenus();$('other-models-trigger').focus();}
});
async function bridgeStatus(){if(statusRequestInFlight)return;statusRequestInFlight=true;try{const r=await fetch('/api/bridge',{signal:AbortSignal.timeout(5000)});if(!r.ok)return;const state=await r.json();remoteBusy.clear();for(const job of state.activeChats||[])if(job.kind==='chat')remoteBusy.add(job.id);updateControls();if(state.connected&&!operation&&!busyHere()&&current()?.verifiedAt)void refreshState();document.querySelector('.badge').textContent=state.connected?'Mac подключён':'Mac не подключён';document.querySelector('.badge').dataset.connected=String(state.connected);$('account-toggle').querySelector('.account-state').textContent=state.connected?'Домашний Mac · онлайн':'Домашний Mac · офлайн';if(state.error){lastBridgeError=state.error;catalogError=state.error;if(!operation&&!busyHere()){status(state.error);renderOptions();}}else if(lastBridgeError){if(catalogError===lastBridgeError)catalogError='';if($('status').textContent===lastBridgeError)status('');lastBridgeError=null;renderOptions();}if(state.connected&&!state.busy&&(!catalog||!lastSyncAttempt)&&!operation&&!busyHere()&&Date.now()-lastSyncAttempt>20000)void sync({quiet:true});}catch{document.querySelector('.badge').textContent='Нет связи с Mac';}finally{statusRequestInFlight=false;}}
async function refreshState(){
  if(stateRequestInFlight)return;stateRequestInFlight=true;const id=selected,settingsBefore=current()?.settings;
  try{const data=await api('/api/chats/state',{id});if(data.state){const chat=chats.find(c=>c.id===id);if(chat&&chat.settings===settingsBefore&&!operation){const changed=JSON.stringify(chat.claudeState)!==JSON.stringify(data.state);chat.settings={model:data.state.model||'',effort:data.state.effort||''};chat.claudeState=data.state;if(selected===id&&changed)renderOptions();}}}catch{}finally{stateRequestInFlight=false;}
}
setInterval(bridgeStatus,1000);
fetch('/api/session').then(r=>r.json()).then(s=>{if(s.authenticated)showApp();}).catch(()=>{$('login-error').textContent='Нет связи с домашним Mac';});
