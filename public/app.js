const $=id=>document.getElementById(id);
let chats=[],selected=null,operation=false,sending=null,catalog=null;
const drafts=new Map();const effortLabels={low:'Низкий',medium:'Средний',high:'Высокий',xhigh:'Сверхвысокий',max:'Максимальный'};
const current=()=>chats.find(c=>c.id===selected);
const draft=()=>{if(!drafts.has(selected))drafts.set(selected,{text:'',files:[]});return drafts.get(selected);};
const status=text=>$('status').textContent=text;
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
  $('chats').replaceChildren();const search=$('search').value.trim().toLowerCase();
  for(const chat of [...chats].sort((a,b)=>b.updatedAt-a.updatedAt)){
    if(search&&!chat.title.toLowerCase().includes(search))continue;
    const button=document.createElement('button');button.className=chat.id===selected?'selected':'';button.textContent=chat.title;button.title=chat.title;button.setAttribute('aria-current',String(chat.id===selected));button.onclick=()=>selectChat(chat.id);if(sending===chat.id)button.textContent+=' ···';$('chats').append(button);
  }
}
function renderMessages(){
  const messages=$('messages');const nearBottom=messages.scrollHeight-messages.scrollTop-messages.clientHeight<150;messages.replaceChildren();const chat=current();
  if(!chat?.messages.length){const intro=document.createElement('div');intro.className='welcome';intro.textContent=chat?.loaded===false?'Загружаем разговор…':'✳\nС чего начнём?';messages.append(intro);}
  for(const m of chat?.messages||[]){const article=document.createElement('article');article.className=m.role;const label=document.createElement('b');label.textContent=m.role==='user'?'Вы':'Claude';const text=document.createElement('div');text.className='message-text';appendText(text,m.text||'');article.append(label,text);if(!m.text&&m.role==='assistant'&&!m.error){const wait=document.createElement('span');wait.className='typing';wait.textContent='Думает…';article.append(wait);}for(const file of m.files||[])article.append(fileCard(file));if(m.error){const error=document.createElement('p');error.className='message-error';error.textContent=m.error;article.append(error);}messages.append(article);}
  if(nearBottom)messages.scrollTop=messages.scrollHeight;
}
function renderOptions(){
  const settings=current()?.settings||{};
  $('model').replaceChildren();const source=catalog?.current?.model;
  $('model').add(new Option(source?'Как в Claude · '+source:'Как в Claude',''));
  const models=[...new Set([...(catalog?.models||[]),settings.model].filter(Boolean))];for(const model of models)$('model').add(new Option(model,model));$('model').value=settings.model||'';
  $('effort').replaceChildren();const activeEffort=effortLabels[catalog?.current?.effort];$('effort').add(new Option(activeEffort?'Как в Claude · '+activeEffort:'Как в Claude',''));
  const efforts=[...new Set([...(catalog?.efforts||[]),settings.effort].filter(Boolean))];for(const level of efforts)$('effort').add(new Option(effortLabels[level]||level,level));$('effort').value=settings.effort||'';
  $('catalog-note').textContent=catalog?.warning|| (catalog?'Модели и усилия доступны в вашем Claude. Максимальный уровень быстрее расходует лимиты.':'Нажмите ↻, чтобы загрузить модели и чаты из открытого Claude.');
}
function renderAttachments(){$('attachments').replaceChildren(...(draft().files||[]).map(f=>fileCard(f,true)));}
function updateControls(){const blocked=operation||!!sending;for(const id of ['send','model','effort','sync','refresh-models','refresh-chat','attach'])$(id).disabled=blocked;$('new-chat').disabled=operation;}
function render(){renderSidebar();renderMessages();renderOptions();$('chat-title').textContent=current()?.title||'Новый разговор';$('prompt').value=draft().text;renderAttachments();updateControls();}
async function newChat(){try{const {chat}=await api('/api/chats/new',{settings:current()?.settings||{}});upsert(chat);await selectChat(chat.id);}catch(e){status(e.message);}}
async function selectChat(id){selected=id;localStorage.setItem('clauderu-selected',id);$('sidebar').classList.remove('open');$('toggle-sidebar').setAttribute('aria-expanded','false');status(sending?'Claude продолжает отвечать в выбранном ранее чате…':'');render();$('messages').scrollTop=$('messages').scrollHeight;const chat=current();if(chat?.loaded===false&&!sending&&!operation){operation=true;updateControls();try{const data=await api('/api/chats/open',{id});upsert(data.chat);if(selected===id)render();}catch(e){status(e.message);}finally{operation=false;updateControls();}}}
async function sync(){
  if(operation||sending)return;operation=true;updateControls();status('Обновляем чаты и модели из Claude…');
  try{const data=await api('/api/sync',{});chats=data.chats;catalog=data.catalog;if(!current())selected=chats[0]?.id||null;if(!selected){operation=false;await newChat();operation=true;}render();status('Загружены чаты из открытой боковой панели Claude.');}catch(e){status(e.message);}finally{operation=false;updateControls();}
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
$('toggle-sidebar').onclick=()=>{$('sidebar').classList.toggle('open');$('toggle-sidebar').setAttribute('aria-expanded',String($('sidebar').classList.contains('open')));};
$('prompt').oninput=()=>draft().text=$('prompt').value;
$('model').onchange=async()=>{
  const chat=current(),model=$('model').value,previous=chat.settings;operation=true;updateControls();status('Проверяем настройки выбранной модели в Claude…');
  try{const data=await api('/api/options',{id:chat.id,settings:{model,effort:''}});upsert(data.chat);catalog=data.catalog;renderOptions();status('');}catch(e){chat.settings=previous;renderOptions();status(e.message);}finally{operation=false;updateControls();}
};
$('effort').onchange=async()=>{const chat=current();operation=true;updateControls();try{const data=await api('/api/chats/settings',{id:chat.id,settings:{model:$('model').value,effort:$('effort').value}});upsert(data.chat);}catch(e){status(e.message);renderOptions();}finally{operation=false;updateControls();}};
$('attach').onclick=()=>$('file-input').click();
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
  const files=[...pending.files];pending.text='';pending.files=[];$('prompt').value='';renderAttachments();sending=chat.id;status('Claude отвечает…');
  if(!chat.messages.length&&text)chat.title=text.slice(0,60);chat.messages.push({role:'user',text,files});const answer={role:'assistant',text:'',files:[]};chat.messages.push(answer);renderMessages();renderSidebar();updateControls();const warnings=[];
  try{
    const res=await post('/api/chat',{chatId:chat.id,text,fileIds:files.map(f=>f.id),settings:chat.settings||{}});if(!res.ok)throw Error((await res.json()).error);
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
  }catch(e){answer.error=e.message;status(e.message);if(selected===chat.id)renderMessages();}
  finally{sending=null;updateControls();renderSidebar();}
};
$('close-preview').onclick=()=>$('file-preview').close();
async function bridgeStatus(){try{const r=await fetch('/api/bridge');if(!r.ok)return;const s=await r.json();document.querySelector('.badge').textContent=s.connected?'● Mac подключён':'○ Подключите расширение на Mac';}catch{document.querySelector('.badge').textContent='Нет связи с Mac';}}
setInterval(bridgeStatus,10000);
fetch('/api/session').then(r=>r.json()).then(s=>{if(s.authenticated)showApp();}).catch(()=>{$('login-error').textContent='Нет связи с домашним Mac';});
