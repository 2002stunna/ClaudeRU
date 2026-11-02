// Isolated extension world. No account credentials or private APIs are read.
(() => {
  let busy=false;
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const all=(selector,root=document)=>[...root.querySelectorAll(selector)];
  const label=node=>{const text=(node?.innerText||node?.textContent||'').replace(/[\uE000-\uF8FF]/g,'').trim();return text||node?.getAttribute('aria-label')||'';};
  const visible=node=>!!node && node.getClientRects().length>0 && getComputedStyle(node).visibility!=='hidden';
  const editor=()=>all('[data-testid="chat-input"][contenteditable="true"],[contenteditable="true"][role="textbox"], div.ProseMirror[contenteditable="true"]').find(visible);
  const responses=()=>{const nodes=all('[data-testid="assistant-message"],.font-claude-response');return nodes.filter(n=>visible(n)&&!n.parentElement?.closest('[data-testid="assistant-message"],.font-claude-response'));};
  function messageText(node){
    const read=n=>{if(n.nodeType===3)return n.textContent;if(n.nodeType!==1)return '';if(n.matches('button,[aria-hidden="true"],.sr-only,[data-testid="message-actions"],[data-testid="user-message-actions"],script,style'))return '';if(n.tagName==='BR')return '\n';if(n.tagName==='PRE')return '\n'+n.textContent+'\n';const text=[...n.childNodes].map(read).join('');return /^(P|DIV|LI|H[1-6]|SECTION|ARTICLE|BLOCKQUOTE)$/.test(n.tagName)?text+'\n':text;};
    return read(node).replace(/\n{3,}/g,'\n\n').trim();
  }
  const modelName=text=>text.match(/(?:Claude\s+)?(?:Opus|Sonnet|Haiku|Fable)\s+\d+(?:\.\d+)*(?:\s+(?:Thinking|Extended))?/i)?.[0]?.trim()||'';
  const same=(a,b)=>a.replace(/^Claude\s+/i,'').toLowerCase()===b.replace(/^Claude\s+/i,'').toLowerCase();
  const effortNames=[['xhigh',/сверхвысок|extra[ -]?high/i],['max',/максимал|maximum|\bmax\b/i],['medium',/средни|medium/i],['low',/низки|\blow\b/i],['high',/высоки|\bhigh\b/i]];
  const effortValue=text=>effortNames.find(([,pattern])=>pattern.test(text))?.[0]||'';
  const choices=()=>all('[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="option"],[data-radix-collection-item],button').filter(visible);
  const modelButton=()=>all('[data-testid="model-selector-dropdown"]').find(visible)||all('button,[role="button"]').filter(visible).find(b=>!b.closest('[role="menu"],[role="listbox"]') && modelName(label(b)));
  const waitFor=async(fn,timeout=12000)=>{const end=Date.now()+timeout;do{const found=fn();if(found)return found;await delay(150);}while(Date.now()<end);throw Error('Элемент интерфейса Claude не появился. Проверьте вкладку на Mac.');};
  async function closeMenus(){for(let i=0;i<2;i++){(document.activeElement||document).dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));await delay(100);}}
  async function openModels(){await closeMenus();const button=modelButton();if(!button)throw Error('Не найдено меню модели в Claude. Обновите вкладку на Mac.');button.click();await waitFor(()=>choices().some(n=>n!==button&&n.closest('[role="menu"],[role="listbox"]')),5000);return button;}
  async function submenu(pattern){const item=choices().find(b=>pattern.test(label(b)));if(!item)return false;const previous=new Set(choices());item.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerType:'mouse'}));item.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));item.click();await waitFor(()=>item.getAttribute('aria-expanded')==='true'||choices().some(n=>!previous.has(n)),5000);return true;}
  const menuModels=()=>[...new Set(choices().filter(b=>b!==modelButton()).map(b=>modelName(label(b))).filter(Boolean))];
  async function inspectCatalog(){
    let trigger=modelButton();if(!trigger){try{trigger=await waitFor(modelButton,8000);}catch{}}if(!trigger)return {models:[],efforts:[],current:{model:'',effort:''},warning:'Меню модели не найдено. Проверьте вход в Claude.'};
    const current={model:modelName(label(trigger)||trigger.getAttribute('aria-label')||''),effort:effortValue(label(trigger))};
    const models=new Set([current.model]);let efforts=[],warning='';
    try{
      await openModels();menuModels().forEach(m=>models.add(m));const selected=choices().find(b=>b!==trigger&&same(modelName(label(b)),current.model));if(selected){const description=label(selected).replace(current.model,'').trim();if(description)current.description=description.slice(0,200);}
      await submenu(/другие модели|other models|more models/i);menuModels().forEach(m=>models.add(m));
      await openModels();
      if(await submenu(/уровень усили|effort level|^effort\b/i)){
        efforts=[...new Set(choices().map(b=>{const text=label(b);return /^(низки|средни|высоки|сверхвысоки|максимал|low\b|medium\b|high\b|extra[ -]?high|maximum|\bmax\b)/i.test(text)?effortValue(text):'';}).filter(Boolean))];
      }
    }catch(e){warning='Не удалось полностью прочитать меню Claude: '+e.message;}finally{await closeMenus();}
    return {models:[...models].filter(Boolean),efforts,current,...(warning?{warning}:{})};
  }
  async function applySettings(settings={}){
    if(settings.model && !same(modelName(label(modelButton())),settings.model)){
      await openModels();
      let item=choices().find(b=>b!==modelButton()&&same(modelName(label(b)),settings.model));
      if(!item){await submenu(/другие модели|other models|more models/i);item=choices().find(b=>same(modelName(label(b)),settings.model));}
      if(!item){await closeMenus();throw Error('Модель «'+settings.model+'» не найдена в вашем Claude. Обновите список моделей.');}
      if(item.getAttribute('aria-disabled')==='true'||item.disabled)throw Error('Эта модель сейчас недоступна в Claude');
      item.click();await delay(350);await closeMenus();
      if(!same(modelName(label(modelButton())),settings.model))throw Error('Claude не подтвердил смену модели. Сообщение не отправлено.');
    }
    if(settings.effort){
      await openModels();
      const effortMenu=choices().find(b=>/уровень усили|effort level|^effort\b/i.test(label(b)));
      if(!effortMenu){await closeMenus();throw Error('У выбранной модели не найдено управление уровнем усилий. Выберите «Как в Claude» или другую модель.');}
      if(effortValue(label(effortMenu))!==settings.effort){
        await submenu(/уровень усили|effort level|^effort\b/i);
        const item=choices().find(b=>/^(низки|средни|высоки|сверхвысоки|максимал|low\b|medium\b|high\b|extra[ -]?high|maximum|\bmax\b)/i.test(label(b))&&effortValue(label(b))===settings.effort);
        if(!item||item.getAttribute('aria-disabled')==='true'||item.disabled){await closeMenus();throw Error('Этот уровень усилий недоступен у выбранной модели.');}
        item.click();await delay(250);
      }
      await closeMenus();await openModels();
      const confirmed=effortValue(label(choices().find(b=>/уровень усили|effort level|^effort\b/i.test(label(b)))))||effortValue(label(modelButton()));
      await closeMenus();if(confirmed!==settings.effort)throw Error('Claude не подтвердил уровень усилий. Сообщение не отправлено.');
    }
  }
  function chatURL(){return /^\/chat\/[a-zA-Z0-9-]+$/.test(location.pathname)?location.origin+location.pathname:null;}
  function snapshot(){
    const root=document.querySelector('main')||document;
    const nodes=all('[data-testid="user-message"],[data-message-author-role="user"],.font-claude-response,[data-testid="assistant-message"]',root).filter(n=>visible(n)&&!n.parentElement?.closest('[data-testid="user-message"],[data-message-author-role="user"],.font-claude-response,[data-testid="assistant-message"]'));
    const messages=nodes.map(n=>({role:n.matches('.font-claude-response,[data-testid="assistant-message"]')?'assistant':'user',text:messageText(n),files:[]}));
    const rawTitle=document.title.replace(/\s*[-|—]\s*Claude.*$/i,'').trim();
    const title=/^claude(?:\.ai)?$/i.test(rawTitle)?'':rawTitle;
    return {url:chatURL(),title,messages};
  }
  function chatIndex(){
    const index=new Map();
    for(const a of all('a[href]')){let u;try{u=new URL(a.href);}catch{continue;}if(u.origin!=='https://claude.ai'||!/^\/chat\/[a-zA-Z0-9-]+$/.test(u.pathname))continue;const title=(a.getAttribute('title')||a.innerText).trim();if(title)index.set(u.origin+u.pathname,{title:title.slice(0,160),url:u.origin+u.pathname});}
    const current=snapshot();if(current.url&&!index.has(current.url))index.set(current.url,{title:current.title,url:current.url});
    return [...index.values()];
  }
  async function attachFiles(files=[]){
    if(!files.length)return;
    if(files.length>5)throw Error('Можно прикрепить до 5 файлов');
    let input=document.querySelector('[data-testid="file-upload"],input[type="file"]');
    if(!input){
      const add=all('button').find(b=>visible(b)&&/add files|attach|добавить файлы|прикрепить|добавить вложения/i.test(label(b)));
      if(add){add.click();await delay(300);input=document.querySelector('[data-testid="file-upload"],input[type="file"]');}
    }
    if(!input)throw Error('В Claude не найдено поле загрузки файлов. Откройте меню «+» во вкладке на Mac и повторите.');
    const transfer=new DataTransfer();
    for(const file of files){const binary=atob(file.data);if(binary.length>20*1024*1024)throw Error('Файл больше 20 МБ');const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));transfer.items.add(new File([bytes],file.name,{type:file.type||'application/octet-stream'}));}
    input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    await waitFor(()=>files.every(file=>all('[title],[aria-label],button,span,p').some(n=>visible(n)&&(n.getAttribute('title')===file.name||n.getAttribute('aria-label')===file.name||n.innerText?.trim()===file.name))),20000);
    await waitFor(()=>!all('[role="progressbar"],[data-testid*="upload-progress"]').some(visible),20000);
  }
  function base64(bytes){let text='';for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(text);}
  const textFile=(name,text)=>({name,type:'text/plain',data:base64(new TextEncoder().encode(text))});
  async function collectFiles(){
    const files=[],warnings=[];let total=0;const seen=new Set();
    const root=responses().at(-1)||document.querySelector('main')||document;
    const artifact=all('[data-testid="artifact-button"],button[aria-label*="artifact" i],button[aria-label*="артефакт" i]',root).find(visible);
    if(artifact){artifact.click();await delay(350);const panel=document.querySelector('[data-testid="artifact-panel"],[data-testid="artifact-content"]');if(panel){const source=all('button,[role="tab"]',panel).find(b=>/^(code|код)$/i.test(label(b)));if(source){source.click();await delay(250);}}}
    const links=all('a[download],a[href^="blob:"],a[href*="/download"],a[href*="/files/"],a[href*="/artifacts/"]',root);
    for(const a of links){
      if(files.length>=5)break;
      const url=new URL(a.href,location.href);
      if(seen.has(url.href))continue;seen.add(url.href);
      if(url.username||url.password||!((url.protocol==='https:'&&url.origin===location.origin)||(url.protocol==='blob:'&&url.origin===location.origin))){warnings.push('Файл «'+(a.innerText||'вложение')+'» находится на другом домене и не перенесён.');continue;}
      let name=a.getAttribute('download')||a.innerText.trim()||url.pathname.split('/').at(-1)||'file';
      try{
        const response=await fetch(url.href,{credentials:'same-origin',redirect:'error'});if(!response.ok)throw Error('HTTP '+response.status);
        const disposition=response.headers.get('Content-Disposition')||'';
        const encoded=/filename\*=UTF-8''([^;]+)/i.exec(disposition),plain=/filename="([^"]+)"|filename=([^;]+)/i.exec(disposition);
        if(encoded){try{name=decodeURIComponent(encoded[1]);}catch{}}else if(plain)name=(plain[1]||plain[2]).trim();
        const reader=response.body.getReader(),chunks=[];let size=0;
        while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>20*1024*1024||total+size>25*1024*1024){await reader.cancel();throw Error('превышен лимит размера файлов');}chunks.push(value);}
        const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
        total+=size;files.push({name,type:(response.headers.get('Content-Type')||'application/octet-stream').split(';')[0],data:base64(bytes)});
      }catch(e){warnings.push('Не удалось перенести «'+name+'»: '+e.message);}
    }
    // Export code as a file; never execute generated HTML/JS in our interface.
    const codeNodes=[...all('pre code',root),...all('[data-testid="artifact-panel"] pre code,[data-testid="artifact-content"] pre code'),...all('[data-testid="artifact-code"] code,[data-testid="artifact-code"] pre,[data-testid="artifact-code"]:not(:has(code,pre))')];
    for(const [i,code] of [...new Set(codeNodes)].entries()){
      if(files.length>=5)break;const text=code.innerText;if(!text)continue;
      const ext=({javascript:'js',typescript:'ts',python:'py',html:'html',css:'css',json:'json',markdown:'md',sql:'sql',bash:'sh'})[(code.className.match?.(/language-([\w]+)/)||[])[1]]||'txt';
      const file=textFile('code-'+(i+1)+'.'+ext,text);const size=new TextEncoder().encode(text).length;
      if(size<=20*1024*1024&&total+size<=25*1024*1024){files.push(file);total+=size;}
    }
    if(artifact&&!files.length)warnings.push('Артефакт создан, но его исходный файл не найден в разметке. Откройте вкладку «Код» артефакта на Mac и обновите этот чат.');
    return {files,warnings};
  }
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(sender.id!==chrome.runtime.id)return;
    if(message.type==='ready'){respond({ready:document.readyState==='complete',version:4});return;}
    if(message.type!=='run')return;
    if(busy){respond({error:'Во вкладке уже выполняется запрос'});return;}busy=true;
    (async()=>{
      try{
        if(message.kind==='inspect'||message.kind==='options'){
          if(message.kind==='options')await applySettings(message.settings);
          const catalog=await inspectCatalog();respond({done:true,result:{catalog,chats:chatIndex(),snapshot:snapshot()}});return;
        }
        if(message.kind==='open'){
          await waitFor(()=>responses().length||all('[data-testid="user-message"]').length||editor());
          const state=snapshot(),generated=await collectFiles();const last=state.messages.findLast(m=>m.role==='assistant');if(last)last.files=generated.files;
          respond({done:true,result:{snapshot:state,warnings:generated.warnings}});return;
        }
        let input=await waitFor(editor);
        if(input.innerText.trim())throw Error('Во вкладке есть неотправленный черновик. Отправьте или удалите его вручную.');
        await applySettings(message.settings);
        await attachFiles(message.files);
        input=await waitFor(editor);
        if(input.innerText.trim())throw Error('Во вкладке появился черновик. Сообщение не отправлено.');
        const before=responses().length;
        input.focus();if(!document.execCommand('insertText',false,message.text||'Посмотри прикреплённые файлы.'))throw Error('Не удалось вставить текст в поле Claude.');
        await delay(400);
        const findSend=()=>all('[data-testid="chat-input-send"]').find(visible)||all('button').find(b=>/^(send message|send|отправить сообщение|отправить)$/i.test(label(b)))||document.querySelector('button[data-testid="send-button"]');
        const send=await waitFor(()=>{const b=findSend();return b&&!b.disabled&&b.getAttribute('aria-disabled')!=='true'?b:null;},20000);
        send.click();
        let previous='',stable=0,seenStop=false;
        const deadline=Date.now()+165000;
        while(Date.now()<deadline){
          await delay(800);
          const list=responses(),text=list.length>before?messageText(list.at(-1)):'';
          const stopping=list.at(-1)?.getAttribute('data-is-streaming')==='true'||all('button').some(b=>visible(b)&&/stop response|stop generating|остановить/i.test(label(b)));
          if(stopping)seenStop=true;
          if(text&&text!==previous){previous=text;stable=0;await chrome.runtime.sendMessage({type:'update',id:message.id,text,url:chatURL()});}
          else if(text)stable++;
          if(text&&!stopping&&stable>=(seenStop?4:12)){
            const {files,warnings}=await collectFiles();
            for(const file of files){const ack=await chrome.runtime.sendMessage({type:'file',id:message.id,file});if(!ack?.ok)throw Error('Не удалось сохранить созданный файл на Mac');}
            for(const warning of warnings)await chrome.runtime.sendMessage({type:'warning',id:message.id,warning});
            const state=snapshot();respond({done:true,result:{url:state.url,title:state.title}});return;
          }
        }
        throw Error('Время ожидания истекло. Проверьте чат на Mac перед повторной отправкой.');
      }catch(e){respond({error:e.message});}finally{busy=false;}
    })();return true;
  });
})();
