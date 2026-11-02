// Runs in an isolated extension world. Never reads passwords, cookies or tokens.
let busy=false;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const editor=()=>document.querySelector('[contenteditable="true"][role="textbox"], div.ProseMirror[contenteditable="true"]');
const responses=()=>[...document.querySelectorAll('.font-claude-response')];
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id)return;
  if(message.type==='ready'){respond({ready:document.readyState==='complete'});return;}
  if(message.type!=='run')return;
  if(busy){respond({error:'Во вкладке уже выполняется запрос'});return;}
  busy=true;
  (async()=>{
    try{
      const input=editor();
      if(!input)throw Error('Не найдено поле сообщения. Проверьте вход и страницу Claude на Mac.');
      if(input.innerText.trim())throw Error('Во вкладке есть неотправленный черновик. Отправьте или удалите его вручную.');
      const before=responses().length;
      input.focus();
      if(!document.execCommand('insertText',false,message.text))throw Error('Не удалось вставить текст в поле Claude.');
      await delay(400);
      const buttons=[...document.querySelectorAll('button')];
      const send=buttons.find(b=>/^(send message|send|отправить сообщение|отправить)$/i.test(b.getAttribute('aria-label')||b.getAttribute('data-testid')||'')) || document.querySelector('button[data-testid="send-button"]');
      if(!send||send.disabled)throw Error('Кнопка отправки недоступна. Проверьте вкладку Claude. Текст оставлен в черновике.');
      send.click();
      let previous='',stable=0,seenStop=false;
      const deadline=Date.now()+165000;
      while(Date.now()<deadline){
        await delay(800);
        const list=responses(),text=list.length>before?list.at(-1).innerText:'';
        const stopping=[...document.querySelectorAll('button')].some(b=>/stop response|stop generating|остановить/i.test(b.getAttribute('aria-label')||''));
        if(stopping)seenStop=true;
        if(text && text!==previous){previous=text;stable=0;await chrome.runtime.sendMessage({type:'update',id:message.id,text,url:/^\/chat\/[a-zA-Z0-9-]+$/.test(location.pathname)?location.origin+location.pathname:null});}
        else if(text)stable++;
        if(text&&!stopping&&stable>=(seenStop?4:12)){respond({done:true});return;}
      }
      throw Error('Время ожидания истекло. Проверьте чат на Mac перед повторной отправкой.');
    }catch(e){respond({error:e.message});}finally{busy=false;}
  })();return true;
});
