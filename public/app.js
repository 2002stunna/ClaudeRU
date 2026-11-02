const $ = id => document.getElementById(id);
let chats = [], selected, busy = false;
// Conversation text is plain text: never inject model output as HTML.
try { chats = JSON.parse(localStorage.getItem('clauderu-chats') || '[]'); if (!Array.isArray(chats)) chats = []; } catch {}
function save() { try { localStorage.setItem('clauderu-chats',JSON.stringify(chats)); } catch { $('status').textContent='Не удалось сохранить историю в браузере.'; } }
function select(id) { if (busy) return; selected=id; render(); }
function newChat() { if (busy) return; const chat={id:crypto.randomUUID(),title:'Новый разговор',messages:[],url:null}; chats.unshift(chat); selected=chat.id; save(); render(); }
function render() {
  $('chats').replaceChildren();
  for (const c of chats) { const button=document.createElement('button'); button.textContent=c.title; button.className=c.id===selected?'selected':''; button.onclick=()=>select(c.id); $('chats').append(button); }
  $('messages').replaceChildren();
  const chat=chats.find(c=>c.id===selected);
  if (!chat?.messages.length) { const intro=document.createElement('div'); intro.className='welcome'; intro.textContent='✳\nС чего начнём?'; $('messages').append(intro); }
  for (const m of chat?.messages || []) { const article=document.createElement('article'); article.className=m.role; const label=document.createElement('b'); label.textContent=m.role==='user'?'Вы':'Claude'; const text=document.createElement('div'); text.textContent=m.text; article.append(label,text); $('messages').append(article); }
}
async function post(path,body) { return fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); }
function showApp() { $('login').hidden=true; $('app').hidden=false; if (!chats.length) newChat(); else {selected=chats[0].id;render();} }
$('login-form').onsubmit=async e=>{ e.preventDefault(); try { const res=await post('/api/login',{password:$('password').value}); const data=await res.json(); if(!res.ok) throw Error(data.error); $('password').value='';showApp(); } catch(e) { $('login-error').textContent=e.message; } };
$('logout').onclick=async()=>{ await post('/api/logout',{}); location.reload(); };
$('new-chat').onclick=newChat;
$('chat-form').onsubmit=async e=>{
  e.preventDefault(); if (busy) return;
  const text=$('prompt').value.trim(); if(!text)return;
  const chat=chats.find(c=>c.id===selected); if(!chat)return;
  busy=true;$('send').disabled=true;$('prompt').value='';$('status').textContent='Claude отвечает…';
  if(!chat.messages.length)chat.title=text.slice(0,45);
  chat.messages.push({role:'user',text}); const answer={role:'assistant',text:''};chat.messages.push(answer);save();render();
  try {
    const res=await post('/api/chat',{text,url:chat.url});
    if(!res.ok)throw Error((await res.json()).error);
    const reader=res.body.getReader(),decoder=new TextDecoder();let buffer='',done=false;
    while(true) { const chunk=await reader.read(); if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});let end;
      while((end=buffer.indexOf('\n'))>=0){const event=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);if(event.type==='error')throw Error(event.error);if(event.type==='done')done=true;if(event.type==='update'){answer.text=event.text;if(event.url)chat.url=event.url;render();$('messages').scrollTop=$('messages').scrollHeight;save();}}
    }
    if(!done)throw Error('Соединение прервано. Проверьте чат на Mac перед повторной отправкой.');
    $('status').textContent='';
  } catch(e) { $('status').textContent=e.message; }
  finally { busy=false;$('send').disabled=false;save(); }
};
fetch('/api/session').then(r=>r.json()).then(s=>{if(s.authenticated)showApp();}).catch(()=>{$('login-error').textContent='Нет связи с домашним Mac';});
