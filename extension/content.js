// Isolated extension world. No account credentials or private APIs are read.
(() => {
  let busy=false, modelCache={}, managedCache=false;
  const MODELS=['Fable 5.1','Opus 5.5','Sonnet 5.5','Haiku 5.5','Fable 5','Opus 5'];
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
  const waitFor=async(fn,timeout=12000)=>{const end=Date.now()+timeout;do{const found=fn();if(found)return found;await delay(50);}while(Date.now()<end);throw Error('Элемент интерфейса Claude не появился. Проверьте вкладку на Mac.');};
  async function closeMenus(){for(let i=0;i<2;i++){(document.activeElement||document).dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true}));await delay(25);}}
  async function openModels(){await closeMenus();const button=modelButton();if(!button)throw Error('Не найдено меню модели в Claude. Обновите вкладку на Mac.');button.click();await waitFor(()=>choices().some(n=>n!==button&&n.closest('[role="menu"],[role="listbox"]')),5000);return button;}
  async function submenu(pattern){const item=choices().find(b=>pattern.test(label(b)));if(!item||item.disabled||item.getAttribute('aria-disabled')==='true')return false;const previous=new Set(choices());item.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerType:'mouse'}));item.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));await delay(60);if(item.getAttribute('aria-expanded')!=='true'&&!choices().some(n=>!previous.has(n)))item.click();await waitFor(()=>item.getAttribute('aria-expanded')==='true'||choices().some(n=>!previous.has(n)),5000);return true;}
  function hydrateCache(cache){
    managedCache=cache?.version===1;if(!managedCache)return;modelCache={};
    for(const model of MODELS){const entry=cache.byModel?.[model];if(typeof entry?.available==='boolean'&&Array.isArray(entry.efforts)&&entry.efforts.every(e=>effortNames.some(([name])=>name===e)))modelCache[model]={available:entry.available,efforts:[...entry.efforts]};}
  }
  async function selectModel(model,{restore=false}={}){
    if(!model||same(readState().model,model))return;
    if(!restore&&!MODELS.includes(model))throw Error('Модель «'+model+'» не найдена в списке ClaudeRU.');
    await openModels();
    let item=choices().find(b=>b!==modelButton()&&same(modelName(label(b)),model));
    if(!item){await submenu(/другие модели|other models|more models/i);item=choices().find(b=>b!==modelButton()&&same(modelName(label(b)),model));}
    if(!item||item.disabled||item.getAttribute('aria-disabled')==='true'){await closeMenus();const error=Error('Модель «'+model+'» не найдена или недоступна в вашем Claude.');error.unavailable=true;throw error;}
    item.click();await waitFor(()=>same(readState().model,model),2500);await closeMenus();
  }
  const isEffortChoice=n=>/^(низки|средни|высоки|сверхвысоки|максимал|low\b|medium\b|high\b|extra[ -]?high|maximum|\bmax\b)/i.test(label(n));
  async function selectEffort(effort){
    if(!effort||readState().effort===effort)return;
    await openModels();
    const menu=choices().find(b=>/уровень усили|effort level|^effort\b/i.test(label(b)));
    if(!menu){await closeMenus();throw Error('У выбранной модели не найдено управление уровнем усилий.');}
    if(effortValue(label(menu))!==effort){
      await submenu(/уровень усили|effort level|^effort\b/i);
      const item=choices().find(b=>isEffortChoice(b)&&effortValue(label(b))===effort);
      if(!item||item.disabled||item.getAttribute('aria-disabled')==='true'){await closeMenus();throw Error('Этот уровень усилий недоступен у выбранной модели.');}
      item.click();await delay(50);
    }
    await closeMenus();if(readState().effort===effort)return;
    await openModels();const confirmed=effortValue(label(choices().find(b=>/уровень усили|effort level|^effort\b/i.test(label(b)))))||readState().effort;
    await closeMenus();if(confirmed!==effort)throw Error('Claude не подтвердил уровень усилий. Сообщение не отправлено.');
  }
  async function applySettings(settings={}){await selectModel(settings.model);await selectEffort(settings.effort);}
  async function learnCatalog(){
    let trigger=modelButton();if(!trigger){try{trigger=await waitFor(modelButton,8000);}catch{}}
    if(!trigger)return quickCatalog('Меню модели не найдено. Проверьте вход в Claude.');
    if(MODELS.every(model=>Object.hasOwn(modelCache,model))||readState().streaming)return quickCatalog();
    const original=readState();let warning='';
    try{
      for(const model of MODELS){
        if(Object.hasOwn(modelCache,model))continue;
        try{await selectModel(model);}catch(e){if(e.unavailable){modelCache[model]={available:false,efforts:[]};continue;}throw e;}
        await openModels();let efforts=[];
        if(await submenu(/уровень усили|effort level|^effort\b/i))efforts=[...new Set(choices().filter(n=>isEffortChoice(n)&&!n.disabled&&n.getAttribute('aria-disabled')!=='true').map(n=>effortValue(label(n))).filter(Boolean))];
        modelCache[model]={available:true,efforts};await closeMenus();
      }
    }catch(e){warning='Не удалось сохранить все уровни усилий: '+e.message;}
    finally{
      await closeMenus();
      try{await selectModel(original.model,{restore:true});await selectEffort(original.effort);}catch(e){warning='Не удалось восстановить настройки Claude после чтения уровней: '+e.message;}
    }
    return quickCatalog(warning);
  }
  async function inspectCatalog(){return managedCache?quickCatalog():learnCatalog();}
  function chatURL(){return /^\/chat\/[a-zA-Z0-9-]+$/.test(location.pathname)?location.origin+location.pathname:null;}
  function readState(){
    const trigger=modelButton(),text=(trigger?.getAttribute('aria-label')||'')+' '+label(trigger);
    const roots=all('[data-testid="hub-composer-notices"],[data-testid="notice-region-slot-shift"],#notice-region-slot-shift,[role="alert"],[role="status"]');
    const composer=composerRoot();if(composer)roots.push(...all('p,span,div',composer).filter(n=>outsideTranscript(n)&&!n.querySelector('[data-testid="user-message"],[data-testid="assistant-message"],[data-message-author-role],.font-claude-response')));
    const notice=roots.filter(n=>visible(n)&&outsideTranscript(n)).map(label).find(t=>/закончил[а-я]* (?:кредиты|лимит)|лимит.{0,50}(?:исчерпан|достигнут|законч)|(?:usage|message|rate) limit|out of (?:credits|usage)|(?:credits|usage).{0,30}(?:exhausted|reached)|смените модель.{0,30}продолж|switch models? to continue|you.{0,10}(?:ve|have) reached.{0,40}limit|limit reached|недостаточно кредитов/i.test(t));
    return {model:modelName(text),effort:effortValue(text),blocked:notice?notice.slice(0,1500):'',streaming:responses().some(n=>n.getAttribute('data-is-streaming')==='true')||all('button').some(b=>visible(b)&&/stop response|stop generating|остановить/i.test(label(b)))};
  }
  function requireAvailable(){const state=readState();if(state.blocked){const error=Error(state.blocked);error.state=state;throw error;}}
  function quickCatalog(warning=''){const current=readState();return {models:[...MODELS],byModel:JSON.parse(JSON.stringify(modelCache)),efforts:modelCache[current.model]?.efforts||[],current,...(warning?{warning}:{})};}
  async function openChatMenu(){
    await closeMenus();const url=chatURL();
    const link=all('a[href]').find(a=>{try{return new URL(a.href).origin+new URL(a.href).pathname===url;}catch{return false;}});
    let root=link,button;
    for(let i=0;root&&i<5;i++,root=root.parentElement){
      button=all('button,[role="button"]',root).find(b=>/more|дополн|действ|меню|options|ellipsis/i.test((b.getAttribute('aria-label')||'')+' '+(b.getAttribute('data-testid')||''))||b.getAttribute('aria-haspopup')==='menu'||/^(⋯|…|\.\.\.)$/.test(label(b)));
      if(button)break;
    }
    if(!button){const header=document.querySelector('[data-testid="chat-header"]');button=header&&all('button',header).find(b=>b.getAttribute('aria-haspopup')==='menu');}
    if(!button)throw Error('Не найдено меню этого чата в Claude. Откройте боковую панель на Mac и обновите чат.');
    button.click();await waitFor(()=>all('[role="menuitem"],[role="menuitemradio"]').some(visible),2500);
  }
  const actionPatterns={rename:/^(переименовать|rename)/i,pin:/^(закрепить|pin)/i,unpin:/^(открепить|unpin)/i,unread:/^(отметить как непрочитан|mark as unread)/i,archive:/^(архивировать|archive)/i,delete:/^(удалить|delete)/i,move:/^(переместить в группу|move to (?:group|project)|переместить в проект)/i};
  async function manageChat(message){
    const pattern=actionPatterns[message.action];if(!pattern)throw Error('Неизвестное действие с чатом');
    await openChatMenu();const item=choices().find(n=>n.closest('[role="menu"]')&&pattern.test(label(n)));
    if(!item||item.disabled||item.getAttribute('aria-disabled')==='true'){await closeMenus();throw Error('Действие недоступно в меню Claude');}
    if(message.action==='move'){
      await submenu(pattern);
      const items=choices().filter(n=>n!==item&&n.closest('[role="menu"],[role="listbox"]')&&!Object.values(actionPatterns).some(p=>p.test(label(n))));
      const groups=[...new Set(items.map(label).filter(t=>t&&!/создать|create|new group/i.test(t)))];
      if(message.group===undefined){await closeMenus();return {groups};}
      const group=items.find(n=>label(n)===message.group);if(!group)throw Error('Группа не найдена в Claude');group.click();
    }else item.click();
    if(message.action==='rename'){
      const input=await waitFor(()=>all('[role="dialog"] input,dialog input').find(visible),2500);
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,message.title);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
      const dialog=input.closest('[role="dialog"],dialog');const confirm=all('button',dialog).find(b=>/^(сохранить|save|переименовать|rename)$/i.test(label(b)));if(!confirm)throw Error('Не найдена кнопка сохранения имени в Claude');confirm.click();
      await waitFor(()=>!visible(dialog)&&chatIndex().some(c=>c.url===message.url&&c.title===message.title),3000);
    }else{
      // Native delete/archive confirmations are accepted only for the exact requested action.
      await delay(100);const dialog=all('[role="alertdialog"],[role="dialog"],dialog').find(visible);
      if(dialog){const confirm=all('button',dialog).find(b=>pattern.test(label(b)));if(!confirm)throw Error('Claude запросил дополнительное подтверждение во вкладке на Mac');confirm.click();await waitFor(()=>!visible(dialog),3000);}
      await waitFor(()=>!all('[role="menu"]').some(visible),3000);
      if(['delete','archive'].includes(message.action))await waitFor(()=>!all('a[href]').some(a=>{try{return new URL(a.href).origin+new URL(a.href).pathname===message.url;}catch{return false;}}),3000);
      else if(message.action==='pin'||message.action==='unpin'){
        await openChatMenu();const opposite=actionPatterns[message.action==='pin'?'unpin':'pin'];if(!choices().some(n=>opposite.test(label(n))))throw Error('Claude не подтвердил закрепление');await closeMenus();
      }
    }
    return {applied:true,action:message.action};
  }
  function snapshot(){
    const root=document.querySelector('main')||document;
    const nodes=all('[data-testid="user-message"],[data-message-author-role="user"],.font-claude-response,[data-testid="assistant-message"]',root).filter(n=>visible(n)&&!n.parentElement?.closest('[data-testid="user-message"],[data-message-author-role="user"],.font-claude-response,[data-testid="assistant-message"]'));
    const messages=nodes.map(n=>({role:n.matches('.font-claude-response,[data-testid="assistant-message"]')?'assistant':'user',text:messageText(n),files:[]}));
    const rawTitle=document.title.replace(/\s*[-|—]\s*Claude.*$/i,'').trim();
    const header=document.querySelector('[data-testid="session-title-split"] h2,[data-testid="chat-header"] h2');
    const title=(header&&visible(header)?label(header):'')||(/^claude(?:\.ai)?$/i.test(rawTitle)?'':rawTitle);
    return {url:chatURL(),title,messages,state:readState()};
  }
  function chatIndex(){
    const index=new Map();
    for(const a of all('a[href]')){let u;try{u=new URL(a.href);}catch{continue;}if(u.origin!=='https://claude.ai'||!/^\/chat\/[a-zA-Z0-9-]+$/.test(u.pathname))continue;const title=(a.getAttribute('title')||label(a.querySelector('[data-row-label]'))||label(a)).trim();if(title)index.set(u.origin+u.pathname,{title:title.slice(0,160),url:u.origin+u.pathname,pinned:!!a.closest('[data-testid="sidebar-pinned"],[data-testid="nav-pin-rows"]')});}
    const current=snapshot();if(current.url&&!index.has(current.url))index.set(current.url,{title:current.title,url:current.url});
    return [...index.values()];
  }
  const uploadInput=()=>composerRoot()?.querySelector('[data-testid="file-upload"],input[type="file"]');
  function composerRoot(){
    const box=editor();if(!box)return null;
    const fieldset=box.closest('fieldset,form,[data-testid="composer"],[data-testid="chat-composer"]');if(fieldset)return fieldset;
    let root=box.parentElement;
    while(root&&root!==document.body){if(root.querySelector('input[type="file"]')&&root.querySelector('[data-testid="chat-input-send"],button[aria-label*="отправ" i],button[aria-label*="send" i]'))return root;root=root.parentElement;}
    return box.parentElement;
  }
  const outsideTranscript=node=>!node.closest('[data-testid="user-message"],[data-testid="assistant-message"],[data-message-author-role],.font-claude-response');
  function imagePreviews(root){return root?all('img',root).filter(n=>visible(n)&&outsideTranscript(n)&&!!n.getAttribute('src')):[];}
  function uploadProblem(root){
    const notice=all('[role="alert"],[data-testid*="upload-error"],[data-upload-state="error"]',root).find(n=>visible(n)&&outsideTranscript(n)&&/файл|загруз|вложен|file|upload|attachment/i.test(label(n)));
    return notice?label(notice).slice(0,500):'';
  }
  function uploading(root){return all('[role="progressbar"],[aria-busy="true"],[data-testid*="upload-progress"],[data-upload-state="uploading"],[data-state="uploading"],.animate-spin',root).some(n=>visible(n)&&outsideTranscript(n));}
  const normalized=text=>(text||'').replace(/\r\n/g,'\n').replace(/\u00a0/g,' ').normalize('NFC').trim();
  function hasFilename(root,name){
    const expected=normalized(name);
    return all('[title],[aria-label],[alt],button,span,p,small',root).some(n=>visible(n)&&outsideTranscript(n)&&[n.getAttribute('title'),n.getAttribute('aria-label'),n.getAttribute('alt'),n.innerText].some(text=>typeof text==='string'&&normalized(text)===expected));
  }
  async function attachFiles(files=[]){
    if(!files.length)return null;
    if(files.length>5)throw Error('Можно прикрепить до 5 файлов');
    let input=uploadInput();
    if(!input){const add=all('button').find(b=>visible(b)&&/add files|attach|добавить файлы|прикрепить|добавить вложения/i.test(label(b)));if(add){add.click();await delay(50);input=uploadInput();}}
    if(!input)throw Error('В Claude не найдено поле загрузки файлов. Откройте меню «+» во вкладке на Mac и повторите.');
    const root=composerRoot();if(!root)throw Error('Не найдено поле сообщения для вложений');
    const existingPreviews=imagePreviews(root);
    const existingCards=all('[data-testid="attachment"],[data-testid*="file-preview"],[data-testid*="file-thumbnail"]',root).filter(visible);
    if(existingPreviews.length||existingCards.length||input.files?.length)throw Error('Во вкладке Claude остались неотправленные вложения. Сначала отправьте или уберите их вручную; повторно файл не загружался.');
    const before=new Map(existingPreviews.map(img=>[img,img.getAttribute('src')]));
    const transfer=new DataTransfer();
    for(const file of files){const binary=atob(file.data);if(binary.length>20*1024*1024)throw Error('Файл больше 20 МБ');const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));transfer.items.add(new File([bytes],file.name,{type:file.type||'application/octet-stream'}));}
    input.files=transfer.files;input.dispatchEvent(new Event('input',{bubbles:true,composed:true}));input.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
    return {files,before};
  }
  function uploadsAccepted(upload,root){
    if(!upload)return true;
    const images=imagePreviews(root).filter(img=>!upload.before.has(img)||upload.before.get(img)!==img.getAttribute('src'));
    const groups=new Set(images.map(img=>img.closest('[data-testid="attachment"],[data-testid*="file-preview"],[data-testid*="file-thumbnail"],button')||img));
    const anonymousImages=upload.files.filter(file=>(/^image\//i.test(file.type||'')||/\.(png|jpe?g|gif|webp|avif|heic|bmp|svg)$/i.test(file.name))&&!hasFilename(root,file.name));
    return upload.files.every(file=>hasFilename(root,file.name)||anonymousImages.includes(file))&&groups.size>=anonymousImages.length;
  }
  function insertOwnedText(text){
    const input=editor();if(!input)return false;
    const current=normalized(input.innerText);if(current&&current!==normalized(text))throw Error('Текст во вкладке Claude изменился. Отправка остановлена, чтобы сохранить черновик.');
    if(current)return true;
    input.focus();if(!document.execCommand('insertText',false,text))throw Error('Не удалось вставить текст в поле Claude.');
    input.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'insertText',data:text}));return true;
  }
  const findSend=()=>all('[data-testid="chat-input-send"]').find(visible)||all('button').find(b=>visible(b)&&/^(send message|send|отправить сообщение|отправить)$/i.test(label(b)));
  const sendEnabled=button=>!!button&&button.isConnected&&!button.disabled&&button.getAttribute('aria-disabled')!=='true'&&button.getAttribute('aria-busy')!=='true';
  function userMessages(){return all('[data-testid="user-message"],[data-message-author-role="user"]').filter(n=>visible(n)&&!n.parentElement?.closest('[data-testid="user-message"],[data-message-author-role="user"]'));}
  const turnKey=node=>node.getAttribute('data-message-id')||node.getAttribute('data-turn-key')||node.id||node;
  function base64(bytes){let text='';for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(text);}
  const textFile=(name,text)=>({name,type:'text/plain',data:base64(new TextEncoder().encode(text))});
  async function collectFiles({openArtifact=false}={}){
    const files=[],warnings=[];let total=0;const seen=new Set();
    const root=responses().at(-1);if(!root)return {files,warnings};
    const artifact=all('[data-testid="artifact-button"],button[aria-label*="artifact" i],button[aria-label*="артефакт" i]',root).find(n=>visible(n)&&(n.dataset.testid==='artifact-button'||/^(open artifact|открыть артефакт|artifact\b|артефакт(?:\s|:|$))/i.test(label(n))));
    let panel=null;
    const codeSelector='pre code,pre:not(:has(code)),[data-testid="artifact-code"]:not(:has(code,pre)),textarea[readonly]';
    if(artifact&&openArtifact){
      const panelSelector='[data-testid="artifact-panel"],[data-testid="artifact-content"]';
      const previous=new Map(all(panelSelector).filter(visible).map(n=>[n,n.textContent]));
      const controlledBefore=document.getElementById(artifact.getAttribute('aria-controls')||'');if(visible(controlledBefore))previous.set(controlledBefore,controlledBefore.textContent);
      const wasOpen=artifact.getAttribute('aria-expanded')==='true'||artifact.getAttribute('aria-pressed')==='true';
      if(!wasOpen)artifact.click();
      try{
        panel=await waitFor(()=>{const id=artifact.getAttribute('aria-controls'),candidates=id?[document.getElementById(id)]:all(panelSelector);return candidates.find(n=>visible(n)&&(wasOpen||!previous.has(n)||previous.get(n)!==n.textContent));},2000);
        const source=all('button,[role="tab"]',panel).find(b=>visible(b)&&/^(code|код)$/i.test(label(b)));
        if(source)source.click();
        await waitFor(()=>all(codeSelector+',a[download],a[href^="blob:"],a[href*="/files/"]',panel).some(visible),2000);
      }catch{/* Missing export does not invalidate the assistant's answer. */}
    }
    const linkSelector='a[download],a[href^="blob:"],a[href*="/download"],a[href*="/files/"],a[href*="/artifacts/"]';
    const links=[...new Set([...all(linkSelector,root),...(panel?all(linkSelector,panel):[])])].filter(visible);
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
    const codeNodes=[...all('pre code',root),...(panel?all(codeSelector,panel):[])].filter(visible);
    for(const [i,code] of [...new Set(codeNodes)].entries()){
      if(files.length>=5)break;const text=code.tagName==='TEXTAREA'?code.value:code.innerText;if(!text)continue;
      const ext=({javascript:'js',typescript:'ts',python:'py',html:'html',css:'css',json:'json',markdown:'md',sql:'sql',bash:'sh'})[(code.className.match?.(/language-([\w]+)/)||[])[1]]||'txt';
      const file=textFile('code-'+(i+1)+'.'+ext,text);const size=new TextEncoder().encode(text).length;
      if(size<=20*1024*1024&&total+size<=25*1024*1024){files.push(file);total+=size;}
    }
    if(artifact&&openArtifact&&!files.length)warnings.push('Не удалось добавить файл артефакта в этот чат. Его можно открыть и скачать на claude.ai.');
    return {files,warnings};
  }
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if(sender.id!==chrome.runtime.id)return;
    if(message.type==='ready'){respond({ready:document.readyState==='complete',version:8});return;}
    if(message.type!=='run')return;
    if(message.kind==='state'){respond({done:true,result:{state:readState()}});return;}
    if(busy){respond({error:'Во вкладке уже выполняется запрос',notSent:true});return;}busy=true;
    (async()=>{
      let submissionAttempted=false;
      try{
        hydrateCache(message.catalogCache);
        if(message.kind==='catalog'){respond({done:true,result:{catalog:await learnCatalog()}});return;}
        if(message.kind==='inspect'||message.kind==='options'){
          if(message.kind==='options')await applySettings(message.settings);
          const catalog=message.kind==='options'?quickCatalog():await inspectCatalog();respond({done:true,result:{catalog,chats:chatIndex(),snapshot:snapshot()}});return;
        }
        if(message.kind==='manage'){const result=await manageChat(message);respond({done:true,result});return;}
        if(message.kind==='open'){
          await waitFor(()=>responses().length||all('[data-testid="user-message"]').length||editor());
          const state=snapshot(),generated=await collectFiles({openArtifact:message.collectArtifacts===true});const last=state.messages.findLast(m=>m.role==='assistant');if(last)last.files=generated.files;
          respond({done:true,result:{snapshot:state,catalog:await inspectCatalog(),warnings:generated.warnings}});return;
        }
        if(message.kind!=='chat')throw Error('Неизвестная команда расширения. Обновите ClaudeRU и вкладку Claude.');
        let input=await waitFor(editor);
        if(input.innerText.trim())throw Error('Во вкладке есть неотправленный черновик. Отправьте или удалите его вручную.');
        await applySettings(message.settings);
        requireAvailable();if(readState().streaming)throw Error('В этом чате Claude ещё отвечает. Дождитесь завершения ответа.');
        const upload=await attachFiles(message.files);
        const text=message.text||'Посмотри прикреплённые файлы.';
        let textInsertions=0,readySince=0;
        const prepareUntil=Date.now()+(upload?45000:20000);
        let send=null;
        while(Date.now()<prepareUntil){
          const root=composerRoot(),box=editor();if(!root||!box){await delay(100);continue;}
          requireAvailable();const problem=uploadProblem(root);if(problem)throw Error('Claude не принял файл: '+problem);
          if(!normalized(box.innerText)){
            if(textInsertions>=3)throw Error('Claude несколько раз сбросил текст после загрузки файла. Черновик оставлен во вкладке; сообщение не отправлено.');
            if(insertOwnedText(text))textInsertions++;
          }else if(normalized(box.innerText)!==normalized(text))throw Error('Текст во вкладке Claude изменился. Черновик сохранён, отправка остановлена.');
          const button=findSend();
          if(uploadsAccepted(upload,root)&&!uploading(root)&&sendEnabled(button)&&normalized(editor()?.innerText)===normalized(text)){
            if(!readySince)readySince=Date.now();
            if(Date.now()-readySince>=400){send=button;break;}
          }else readySince=0;
          await delay(100);
        }
        if(!send)throw Error(upload?'Claude ещё обрабатывает файл или не разрешил отправку. Текст и вложения оставлены в черновике; сообщение не отправлено.':'Кнопка отправки не стала доступной. Текст оставлен в черновике Claude.');
        const before=responses().length,beforeUsers=new Set(userMessages().map(turnKey)),beforeAnswers=new Set(responses().map(turnKey));
        // One click only. A failed acknowledgement must never trigger a blind resend.
        if(!sendEnabled(send))throw Error('Поле Claude обновилось перед отправкой. Черновик сохранён.');
        submissionAttempted=true;send.click();
        try{
          await waitFor(()=>{requireAvailable();return userMessages().some(n=>!beforeUsers.has(turnKey(n))&&normalized(messageText(n)).includes(normalized(text)))||responses().some(n=>!beforeAnswers.has(turnKey(n))&&n.getAttribute('data-is-streaming')==='true')||responses().length>before;},10000);
        }catch(e){if(e.state){e.notSent=!userMessages().some(n=>!beforeUsers.has(turnKey(n)));throw e;}throw Error('После нажатия Claude не подтвердил отправку. Проверьте вкладку на Mac; повторного нажатия не было.');}
        let previous='',unchangedSince=0,completedSince=0,seenStop=false;
        const deadline=Date.now()+165000;
        while(Date.now()<deadline){
          await delay(250);requireAvailable();
          const list=responses(),text=list.length>before?messageText(list.at(-1)):'';
          const stopping=list.at(-1)?.getAttribute('data-is-streaming')==='true'||all('button').some(b=>visible(b)&&/stop response|stop generating|остановить/i.test(label(b)));
          if(stopping)seenStop=true;
          if(text&&text!==previous){previous=text;unchangedSince=Date.now();await chrome.runtime.sendMessage({type:'update',id:message.id,text,url:chatURL()});}
          const explicitlyDone=list.at(-1)?.getAttribute('data-is-streaming')==='false';
          if(explicitlyDone&&!stopping){if(!completedSince)completedSince=Date.now();}else completedSince=0;
          const settleMs=explicitlyDone?500:seenStop?1000:10000;
          if(text&&!stopping&&Date.now()-unchangedSince>=settleMs&&(!explicitlyDone||Date.now()-completedSince>=settleMs)){
            const {files,warnings}=await collectFiles({openArtifact:true});
            for(const file of files){const ack=await chrome.runtime.sendMessage({type:'file',id:message.id,file});if(!ack?.ok)throw Error('Не удалось сохранить созданный файл на Mac');}
            for(const warning of warnings)await chrome.runtime.sendMessage({type:'warning',id:message.id,warning});
            const state=snapshot();respond({done:true,result:{url:state.url,title:state.title,state:state.state}});return;
          }
        }
        throw Error('Время ожидания истекло. Проверьте чат на Mac перед повторной отправкой.');
      }catch(e){respond({error:e.message,notSent:e.notSent===true||!submissionAttempted,state:e.state});}finally{busy=false;}
    })();return true;
  });
})();
