// Isolated extension world. No account credentials or private APIs are read.
(() => {
  let busy=false, modelCache={}, managedCache=false, activeJobId=null, ownedDraft=null;
  const downloadedCards=new WeakMap();
  const MODELS=['Fable 5.1','Opus 5.5','Sonnet 5.5','Haiku 5.5','Fable 5','Opus 5'];
  // Timers in a hidden Claude tab can be throttled for seconds. The extension's
  // worker owns short waits; readiness is still checked in the actual page.
  const delay=async ms=>{let reply;try{reply=await chrome.runtime.sendMessage({type:'wait',id:activeJobId,ms});}catch{}if(reply?.ok!==true)throw Error('Связь с расширением прервана. Обновите расширение ClaudeRU и вкладку Claude.');};
  const all=(selector,root=document)=>[...root.querySelectorAll(selector)];
  const label=node=>{const text=(node?.innerText||node?.textContent||'').replace(/[\uE000-\uF8FF]/g,'').trim();return text||node?.getAttribute('aria-label')||'';};
  const visible=node=>!!node && node.getClientRects().length>0 && getComputedStyle(node).visibility!=='hidden';
  const activeControl=node=>visible(node)&&!node.closest('[inert],[aria-hidden="true"]');
  const editor=()=>all('[data-testid="chat-input"][contenteditable="true"]').find(activeControl)||all('[contenteditable="true"][role="textbox"],div.ProseMirror[contenteditable="true"]').find(activeControl);
  const responses=()=>{const nodes=all('[data-testid="assistant-message"],.font-claude-response');return nodes.filter(n=>visible(n)&&!n.parentElement?.closest('[data-testid="assistant-message"],.font-claude-response'));};
  function messageText(node){
    const cards=new Set(pdfCards(node).map(c=>c.container));
    const read=n=>{if(n.nodeType===3)return n.textContent;if(n.nodeType!==1)return '';if(cards.has(n))return '';if(n.matches('button,[role="button"],[data-testid="file-thumbnail"],[data-testid="file-card"],[data-testid="generated-file"],[data-testid="attachment"],[aria-hidden="true"],.sr-only,[data-testid="message-actions"],[data-testid="user-message-actions"],script,style'))return '';if(n.tagName==='BR')return '\n';if(n.tagName==='PRE')return '\n'+n.textContent+'\n';const text=[...n.childNodes].map(read).join('');return /^(P|DIV|LI|H[1-6]|SECTION|ARTICLE|BLOCKQUOTE)$/.test(n.tagName)?text+'\n':text;};
    return read(node).replace(/\n{3,}/g,'\n\n').trim();
  }
  const modelName=text=>text.match(/(?:Claude\s+)?(?:Opus|Sonnet|Haiku|Fable)\s+\d+(?:\.\d+)*(?:\s+(?:Thinking|Extended))?/i)?.[0]?.trim()||'';
  const same=(a,b)=>a.replace(/^Claude\s+/i,'').toLowerCase()===b.replace(/^Claude\s+/i,'').toLowerCase();
  const effortNames=[['xhigh',/сверхвысок|extra[ -]?high/i],['max',/максимал|maximum|\bmax\b/i],['medium',/средни|medium/i],['low',/низки|\blow\b/i],['high',/высоки|\bhigh\b/i]];
  const effortValue=text=>effortNames.find(([,pattern])=>pattern.test(text))?.[0]||'';
  const choices=()=>all('[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="option"],[data-radix-collection-item],button').filter(visible);
  const modelButton=()=>all('[data-testid="model-selector-dropdown"]').find(activeControl)||all('button,[role="button"]').filter(activeControl).find(b=>!b.closest('[role="menu"],[role="listbox"]') && modelName(label(b)));
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
  function targetLinks(url){return all('a[href]').filter(a=>{try{const u=new URL(a.href);return u.origin+u.pathname===url;}catch{return false;}});}
  function targetMenuButton(url){
    for(const link of targetLinks(url)){
      let row=link.parentElement;
      for(let i=0;row&&i<4;i++,row=row.parentElement){
        // Never broaden the search to other conversations in the sidebar.
        const links=all('a[href]',row).filter(a=>{try{return /^\/chat\//.test(new URL(a.href).pathname);}catch{return false;}});
        if(links.some(a=>!targetLinks(url).includes(a)))break;
        const button=all('[data-row-action],button,[role="button"]',row).find(n=>n.hasAttribute('data-row-action')||n.getAttribute('aria-haspopup')==='menu'||/more|дополн|действ|меню|options|ellipsis/i.test(n.getAttribute('aria-label')||'')||/^(⋯|…|\.\.\.)$/.test(label(n)));
        if(button)return button;
        if(row.matches('aside,nav,[data-testid="sidebar"]'))break;
      }
    }
    if(chatURL()!==url)return null;
    const header=document.querySelector('[data-testid="chat-header"]');
    return header&&all('button',header).find(n=>n.getAttribute('aria-haspopup')==='menu'&&!/share|поделиться|model|модель/i.test(label(n)));
  }
  async function openChatMenu(url=chatURL()){
    await closeMenus();let button;
    try{button=await waitFor(()=>targetMenuButton(url),4000);}catch{throw Error('Не найдено меню именно этого чата в Claude. Действие не выполнялось.');}
    button.click();await waitFor(()=>all('[role="menuitem"],[role="menuitemradio"]').some(visible),4000);
  }
  const actionPatterns={rename:/^(переименовать|rename)/i,pin:/^(закрепить|pin)/i,unpin:/^(открепить|unpin)/i,unread:/^(отметить как непрочитан|mark as unread)/i,archive:/^(архивировать|archive)/i,delete:/^(удалить|delete)/i,move:/^(переместить в группу|move to (?:group|project)|переместить в проект)/i};
  async function manageChat(message){
    const pattern=actionPatterns[message.action];if(!pattern)throw Error('Неизвестное действие с чатом');
    if(chatURL()!==message.url)throw Error('Вкладка Claude открыта на другом чате. Обновите разговор.');
    await openChatMenu(message.url);const item=choices().find(n=>n.closest('[role="menu"]')&&pattern.test(label(n)));
    if(!item||item.disabled||item.getAttribute('aria-disabled')==='true'){await closeMenus();throw Error('Действие недоступно в меню Claude');}
    const hadLink=targetLinks(message.url).length>0;
    const dialogsBefore=new Map(all('[role="alertdialog"],[role="dialog"],dialog').filter(visible).map(n=>[n,label(n)]));
    const noticesBefore=new Set(all('[role="status"],[role="alert"]').filter(visible).map(label));
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
    }else if(['delete','archive'].includes(message.action)){
      const applied=()=>hadLink&&!targetLinks(message.url).length||(location.origin==='https://claude.ai'&&['/','/new'].includes(location.pathname))||all('[role="status"],[role="alert"]').some(n=>visible(n)&&!noticesBefore.has(label(n))&&!/ошиб|не\s+(?:был[аи]?\s+)?(?:удал|архив)|не удалось|failed|error|not\s+(?:deleted|archived)/i.test(label(n))&&(message.action==='delete'?/удал[её]н(?:а|о|ы)?(?:[\s.!,:;]|$)|deleted\b/i:/архивирован(?:а|о|ы)?(?:[\s.!,:;]|$)|archived\b/i).test(label(n)));
      const dialog=await waitFor(()=>{const failure=all('[role="alert"],[role="status"]').find(n=>visible(n)&&!noticesBefore.has(label(n))&&/ошиб|не\s+(?:был[аи]?\s+)?(?:удал|архив)|не удалось|failed|error|not\s+(?:deleted|archived)/i.test(label(n)));if(failure)throw Error(label(failure));const next=all('[role="alertdialog"],[role="dialog"],dialog').find(n=>visible(n)&&(!dialogsBefore.has(n)||dialogsBefore.get(n)!==label(n))&&all('button',n).some(b=>pattern.test(label(b))));return next||applied()&&{completed:true};},6000);
      if(!dialog.completed){const confirm=await waitFor(()=>all('button',dialog).find(n=>pattern.test(label(n))&&!n.disabled&&n.getAttribute('aria-disabled')!=='true'),4000);confirm.click();await waitFor(()=>!visible(dialog)&&applied(),8000);}
    }else{
      // Handle optional confirmations for the remaining actions.
      await delay(100);const dialog=all('[role="alertdialog"],[role="dialog"],dialog').find(visible);
      if(dialog){const confirm=all('button',dialog).find(b=>pattern.test(label(b)));if(!confirm)throw Error('Claude запросил дополнительное подтверждение во вкладке на Mac');confirm.click();await waitFor(()=>!visible(dialog),3000);}
      await waitFor(()=>!all('[role="menu"]').some(visible),3000);
      if(message.action==='pin'||message.action==='unpin'){
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
    while(root&&root!==document.body){if(all('button,[role="button"],input[type="submit"]',root).some(isSendButton))return root;root=root.parentElement;}
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
    input.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'insertText',data:text}));ownedDraft={text:normalized(text),url:location.href};return true;
  }
  function replaceOwnedDraft(input,text){
    // Replace only our unsubmitted text. A manual edit or attachment keeps the
    // native draft protected. The wrapper retains failed drafts by local chat.
    if(!ownedDraft||ownedDraft.url!==location.href||ownedDraft.text!==normalized(input.innerText)||hasComposerAttachments(composerRoot()))return false;
    input.focus();const range=document.createRange();range.selectNodeContents(input);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
    if(!document.execCommand('insertText',false,text))throw Error('Не удалось обновить черновик Claude.');
    input.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'insertReplacementText',data:text}));ownedDraft={text:normalized(text),url:location.href};return true;
  }
  function isSendButton(node){
    if(/^(chat-input-send|send-button|send-message-button)$/.test(node.getAttribute('data-testid')||''))return true;
    const pattern=/^(?:send(?: (?:a |your )?message)?|отправить(?: сообщение)?)(?:\s*\([^)]*\)|\s+(?:Enter|Ввод))?$/i;
    const labelled=(node.getAttribute('aria-labelledby')||'').split(/\s+/).map(id=>document.getElementById(id)?.textContent||'').join(' ');
    return [node.getAttribute('aria-label'),labelled,node.getAttribute('title'),label(node)].some(value=>value&&pattern.test(value.replace(/\s+/g,' ').trim()));
  }
  function findSend(){
    const box=editor(),scope=composerRoot();if(!box||!scope)return null;
    const ownForm=box.closest('form'),inactive=[];
    // A toolbar can be a sibling of the editor's fieldset. Expand only as far
    // as this composer/column; reject controls owned by another editor or form.
    for(let root=scope;root&&root!==document.body;root=root.parentElement){
      if(root!==scope&&all('[data-testid="chat-input"][contenteditable="true"]',root).some(n=>n!==box&&activeControl(n)))break;
      const belongs=node=>{const form=node.form||node.closest('form'),popup=node.closest('[role="dialog"],[role="menu"],[role="listbox"]');return outsideTranscript(node)&&(!form||form===ownForm)&&(!popup||popup===box.closest('[role="dialog"]'));};
      const controls=all('button,[role="button"],input[type="submit"]',root).filter(n=>belongs(n)&&isSendButton(n));
      const candidates=controls.filter(activeControl);
      if(candidates.length)return candidates.find(sendEnabled)||candidates[0];
      inactive.push(...controls);
      if(root.matches('main,[role="main"],[data-testid="chat-column"]'))break;
    }
    if(ownForm){const submit=all('button,input[type="submit"]',ownForm).filter(n=>n.type==='submit'&&activeControl(n)&&outsideTranscript(n));if(submit.length===1)return submit[0];}
    return inactive[0]||null;
  }
  const sendEnabled=button=>!!button&&button.isConnected&&activeControl(button)&&!button.disabled&&!button.matches(':disabled')&&button.getAttribute('aria-disabled')!=='true'&&button.getAttribute('aria-busy')!=='true';
  function refreshComposerText(box,text){
    if(box!==editor()||normalized(box.innerText)!==normalized(text))return false;
    // SSR can expose an editable DOM before Claude subscribes to its input.
    // Replacing this exact text generates native editing events after hydration.
    box.focus();if(box!==editor()||normalized(box.innerText)!==normalized(text))return false;
    const range=document.createRange();range.selectNodeContents(box);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
    if(!document.execCommand('insertText',false,text))return false;
    box.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'insertText',data:text}));ownedDraft={text:normalized(text),url:location.href};return true;
  }
  function hasComposerAttachments(root){return !!root&&(uploadInput()?.files?.length>0||imagePreviews(root).length>0||all('[data-testid="attachment"],[data-testid*="file-preview"],[data-testid*="file-thumbnail"]',root).some(n=>visible(n)&&outsideTranscript(n)));}
  function userMessages(){return all('[data-testid="user-message"],[data-message-author-role="user"]').filter(n=>visible(n)&&!n.parentElement?.closest('[data-testid="user-message"],[data-message-author-role="user"]'));}
  const turnKey=node=>node.getAttribute('data-message-id')||node.getAttribute('data-turn-key')||node.id||node;
  function base64(bytes){let text='';for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(text);}
  const textFile=(name,text)=>({name,type:'text/plain',data:base64(new TextEncoder().encode(text))});
  function assistantFileScope(root){
    // Generated media may be a sibling of the text node. Stop at the boundary
    // of this turn; never scan the whole history or an unrelated open viewer.
    let scope=root;
    for(let depth=0;depth<5;depth++){
      const parent=scope.parentElement;
      if(!parent||parent.matches('main,body,html,[role="main"]')||parent.contains(editor())||all('[data-testid="user-message"],[data-message-author-role="user"]',parent).length)break;
      if(responses().some(n=>n!==root&&parent.contains(n)))break;
      scope=parent;
    }
    return scope;
  }
  const rasterExtension=/\.(png|jpe?g|gif|webp|avif|bmp)$/i;
  function imageReferences(scope,excluded=[]){
    const images=all('img',scope).filter(img=>!excluded.some(c=>c.contains(img))&&activeControl(img)&&img.getBoundingClientRect().width>=48&&img.getBoundingClientRect().height>=48&&!img.closest('[data-testid="message-actions"],[data-testid="user-message-actions"]'));
    const mentioned=[...new Set((scope.innerText||'').match(/[\p{L}\p{N}_-][\p{L}\p{N}_.-]*\.(?:png|jpe?g|gif|webp|avif|bmp)\b/giu)||[])];
    return images.flatMap((img,i)=>{
      const href=img.currentSrc||img.src;if(!href)return [];
      const container=img.closest('[data-filename],a[download]');
      let pathName='';try{pathName=decodeURIComponent(new URL(href,location.href).pathname.split('/').at(-1));}catch{}
      const name=[container?.getAttribute('data-filename'),container?.getAttribute('download'),img.alt,img.title,images.length===1&&mentioned.length===1?mentioned[0]:'',pathName].find(n=>n&&rasterExtension.test(n))||'image-'+(i+1);
      return [{href,download:name,innerText:name,requireImage:true}];
    });
  }
  function rasterType(bytes){
    if(bytes[0]===137&&new TextDecoder('ascii').decode(bytes.subarray(1,8))==='PNG\r\n\x1a\n')return ['image/png','png'];
    if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return ['image/jpeg','jpg'];
    const start=new TextDecoder('ascii').decode(bytes.subarray(0,16));
    if(/^GIF8[79]a/.test(start))return ['image/gif','gif'];
    if(start.startsWith('RIFF')&&start.slice(8,12)==='WEBP')return ['image/webp','webp'];
    if(start.slice(4,8)==='ftyp'&&/avif|avis/.test(start.slice(8)))return ['image/avif','avif'];
    if(start.startsWith('BM'))return ['image/bmp','bmp'];
    return null;
  }
  function fileDiagnostics(){
    const address=value=>{try{const u=new URL(value,location.href);if(u.protocol==='data:')return u.href.slice(0,80).split(',')[0]+',…';if(u.protocol==='blob:')return 'blob:'+u.origin+'/…';return u.origin+u.pathname.replace(/[a-f0-9-]{24,}/gi,'…')+(u.search?'?'+[...new Set(u.searchParams.keys())].join('&'):'');}catch{return '';}};
    const describe=node=>({tag:node.tagName,testId:node.getAttribute('data-testid'),role:node.getAttribute('role'),label:(node.getAttribute('aria-label')||node.getAttribute('title')||node.getAttribute('alt')||'').slice(0,160),parents:[...function*(n){for(let i=0;n&&i<5;i++,n=n.parentElement)yield n.tagName+(n.getAttribute('data-testid')?'[data-testid='+n.getAttribute('data-testid')+']':'')+(n.getAttribute('role')?'[role='+n.getAttribute('role')+']':'');}(node.parentElement)]});
    const root=responses().at(-1),scope=root?assistantFileScope(root):null;
    const imageInfo=img=>({...describe(img),inLastTurn:!!scope?.contains(img),width:img.getBoundingClientRect().width,height:img.getBoundingClientRect().height,naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight,complete:img.complete,source:address(img.currentSrc||img.src)});
    return {version:14,readyState:document.readyState,visibility:document.visibilityState,sendControls:all('button,[role="button"],input[type="submit"]').filter(isSendButton).slice(0,12).map(n=>({...describe(n),visible:visible(n),active:activeControl(n),enabled:sendEnabled(n),inert:!!n.closest('[inert]'),ariaHidden:!!n.closest('[aria-hidden="true"]')})),path:location.pathname.replace(/[a-f0-9-]{24,}/gi,'…'),assistantCount:responses().length,scope:scope?describe(scope):null,images:all('img').filter(visible).slice(-40).map(imageInfo),cards:scope?pdfCards(scope).slice(0,10).map(c=>({...describe(c.container),target:describe(c.target),references:pdfReferences(c.container,'document.pdf').map(r=>address(r.href))})):[],media:all('iframe[src],embed[src],object[data],a[download]').filter(visible).slice(-20).map(n=>({...describe(n),source:address(n.getAttribute('href')||n.getAttribute('src')||n.getAttribute('data'))})),buttons:all('button,[role="button"]').filter(n=>visible(n)&&/скачать|download|pdf|png|документ|document/i.test(label(n))).slice(-20).map(describe),editor:editor()?describe(editor()):null,composer:composerRoot()?describe(composerRoot()):null,hasComposerAttachments:hasComposerAttachments(composerRoot())};
  }
  const pdfCardSelector='[data-testid="file-thumbnail"],[data-testid="file-card"],[data-testid="generated-file"],[data-testid="file-attachment"],[role="button"],button';
  function pdfCards(root){
    const metadata=/^(?:документ|document)\s*[·•.\-:]?\s*pdf$/i;
    const found=all(pdfCardSelector,root).filter(n=>visible(n)&&((n.matches('[data-testid="file-thumbnail"],[data-testid="file-card"],[data-testid="generated-file"],[data-testid="file-attachment"],[data-filename]')&&/\bpdf\b/i.test(label(n)+' '+(n.getAttribute('data-filename')||'')))||/(?:документ|document)\s*[·•.\-:]?\s*pdf\b/i.test(label(n))));
    const cards=found.map(container=>({container,target:container}));
    for(const detail of all('span,small,p,div',root)){
      const text=(detail.textContent||'').replace(/[\uE000-\uF8FF]/g,'').trim();if(!metadata.test(text)||!visible(detail))continue;
      let container=detail.parentElement;
      for(let depth=0;container&&container!==root&&depth<4;depth++,container=container.parentElement){
        if(!label(container).replace(/(?:документ|document)\s*[·•.\-:]?\s*pdf/ig,'').trim())continue;
        const target=container.matches('button,[role="button"],a[href],[tabindex]')||getComputedStyle(container).cursor==='pointer'?container:all('button,[role="button"],a[href],[tabindex]',container).find(visible);
        if(target){cards.push({container,target});break;}
      }
    }
    const unique=[...new Map(cards.map(c=>[c.container,c])).values()];
    return unique.filter(c=>!unique.some(parent=>parent!==c&&parent.container.contains(c.container)));
  }
  function pdfCardName(card){
    const parts=[card.getAttribute('data-filename'),label(card.querySelector('[data-testid="file-name"],[data-testid="filename"]')),label(card).replace(/(?:document|документ)[\s\S]*$/i,'').trim(),card.getAttribute('title'),card.getAttribute('aria-label'),...label(card).split('\n')].filter(Boolean);
    return parts.find(t=>/^[^\n]+\.pdf$/i.test(t.trim()))?.trim()||((parts.find(t=>!/(?:document|документ|pdf|скачать|download)/i.test(t))||'document').trim()+'.pdf');
  }
  function pdfReferences(scope,name){
    const selector='a[href],iframe[src],embed[src],object[data],[data-download-url],[data-file-url]';
    const nodes=[...(scope.matches?.(selector)?[scope]:[]),...all(selector,scope)];
    return nodes.flatMap(node=>{
      const value=node.getAttribute('data-download-url')||node.getAttribute('data-file-url')||node.getAttribute('href')||node.getAttribute('src')||node.getAttribute('data');
      if(!value)return [];let url;try{url=new URL(value,location.href);}catch{return [];}
      // Some PDF viewers expose the document URL in a file= query parameter.
      const source=url.searchParams.get('file');if(source){try{url=new URL(source,url);}catch{return [];}}
      url.hash='';return [{href:url.href,download:node.getAttribute('download')||name,innerText:name,requirePDF:true}];
    });
  }
  function downloadControls(scope=document){return all('button,[role="button"]',scope).filter(n=>activeControl(n)&&[label(n),n.getAttribute('aria-label'),n.getAttribute('title')].some(s=>/^(download|скачать)(?:\s|$)/i.test(s||'')));}
  async function browserFileDownload(button,name){
    const nonce=crypto.randomUUID().replaceAll('-','');
    const begin=await chrome.runtime.sendMessage({type:'download-begin',id:activeJobId,nonce,name});
    if(!begin?.ok)throw Error(begin?.error||'Браузер не разрешил управление загрузками');
    try{
      button.click();const deadline=Date.now()+60000;
      while(Date.now()<deadline){
        const result=await chrome.runtime.sendMessage({type:'download-state',id:activeJobId,nonce});
        if(!result?.ok||result.state==='error')throw Error(result?.error||'Ошибка скачивания файла');
        if(result.state==='done'){if(!/^[a-f0-9]{32}$/.test(result.file?.id||''))throw Error('Сервер не подтвердил сохранение файла');return result.file;}
        await delay(150);
      }
      throw Error('Браузер не завершил скачивание за минуту');
    }finally{await chrome.runtime.sendMessage({type:'download-cancel',id:activeJobId,nonce}).catch(()=>{});}
  }
  function cardDownloadName(card,button){
    const title=card.getAttribute('data-filename')||(button.getAttribute('aria-label')||button.getAttribute('title')||label(button)).replace(/^(?:скачать|download)\s+/i,'').trim();
    if(/\.[a-z0-9]{2,8}$/i.test(title))return title;
    const ext=/\b(PDF|DOCX|XLSX|PPTX|PNG|JPE?G|GIF|WEBP|CSV|TXT|ZIP)\b/i.exec(label(card))?.[1]?.toLowerCase();
    return ext?title+'.'+ext:null;
  }
  async function pdfCardFiles(root,{force=false}={}){
    const references=[],warnings=[],files=[],exported=[];
    const cards=pdfCards(root);
    for(const block of all('[data-testid="file-card-block"]',root))if(!cards.some(c=>block.contains(c.container)))cards.push({container:block,target:block.querySelector('[data-testid="file-card-open"]')||block});
    for(const {container:card,target} of cards.slice(0,5)){
      const block=card.closest('[data-testid="file-card-block"]')||card,directButton=downloadControls(block)[0];
      if(exported.includes(block))continue;
      const name=directButton?cardDownloadName(block,directButton)||pdfCardName(card):pdfCardName(card);
      const cardSignature=location.pathname+'\n'+label(block)+'\n'+all('img[src],[data-file-id]',block).map(n=>n.getAttribute('src')||n.getAttribute('data-file-id')).join('\n'),cached=downloadedCards.get(block);
      if(!force&&cached?.signature===cardSignature){files.push(cached.file);exported.push(block);continue;}
      if(directButton){try{const file=await browserFileDownload(directButton,name);files.push(file);exported.push(block);downloadedCards.set(block,{signature:cardSignature,file});}catch(e){warnings.push('Не удалось скачать «'+name+'»: '+e.message);}continue;}
      const direct=pdfReferences(card,name);
      if(direct.length){references.push(...direct.map(r=>({...r,pdfGroup:card})));continue;}
      const panelSelector='[data-testid="file-preview"],[data-testid="document-preview"],[data-testid="file-viewer"],[data-testid="document-viewer"],[data-testid="artifact-panel"],[role="dialog"],iframe[src],embed[src],object[data]';
      const signature=n=>[n.textContent,...pdfReferences(n,name).map(r=>r.href)].join('\n');
      const previous=new Map(all(panelSelector).filter(visible).map(n=>[n,signature(n)]));
      const previousDownloads=new Set(downloadControls());
      const controlled=document.getElementById((target.getAttribute('aria-controls')||card.getAttribute('aria-controls'))||'');if(visible(controlled))previous.set(controlled,signature(controlled));
      const wasOpen=target.getAttribute('aria-expanded')==='true'||target.getAttribute('aria-pressed')==='true';
      if(!wasOpen)target.click();
      try{
        const sources=await waitFor(()=>{
          const id=(target.getAttribute('aria-controls')||card.getAttribute('aria-controls')),panels=id?[document.getElementById(id)]:all(panelSelector);
          const current=panels.filter(n=>visible(n)&&(wasOpen||!previous.has(n)||previous.get(n)!==signature(n)));
          const download=current.flatMap(n=>downloadControls(n)).find(Boolean)||downloadControls().find(n=>!previousDownloads.has(n));
          if(download)return {download};
          const links=current.flatMap(n=>pdfReferences(n,name));return links.length?{links}:null;
        },3500);
        if(sources.download){const file=await browserFileDownload(sources.download,name);files.push(file);exported.push(block);downloadedCards.set(block,{signature:cardSignature,file});}
        else references.push(...sources.links.map(r=>({...r,pdfGroup:card})));
      }catch{warnings.push('Не удалось получить PDF «'+name+'» из Claude. Откройте документ на Mac и обновите этот чат.');}
    }
    return {references,warnings,files,exported};
  }
  async function collectFiles({openArtifact=false}={}){
    const files=[],warnings=[];let total=0;const seen=new Set(),downloadedPDFs=new Set(),pdfErrors=new Map();
    const root=responses().at(-1);if(!root)return {files,warnings};const scope=assistantFileScope(root);
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
    const linkSelector='a[download],a[href^="blob:"],a[href*="/download"],a[href*="/files/"],a[href*="/artifacts/"],a[href$=".pdf" i],a[href*=".pdf?" i]';
    const pdfs=await pdfCardFiles(scope,{force:openArtifact});warnings.push(...pdfs.warnings);files.push(...pdfs.files);total+=pdfs.files.reduce((sum,f)=>sum+f.size,0);
    const links=[...imageReferences(scope,pdfs.exported),...[...new Set([...all(linkSelector,scope),...(panel?all(linkSelector,panel):[])])].filter(visible),...pdfs.references];
    for(const a of links){
      if(files.length>=5)break;if(a.pdfGroup&&downloadedPDFs.has(a.pdfGroup))continue;
      const url=new URL(a.href,location.href);
      if(seen.has(url.href))continue;seen.add(url.href);
      const imageData=a.requireImage&&/^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,/i.test(url.href);
      const externalImage=a.requireImage&&url.protocol==='https:'&&url.origin!==location.origin;
      if(url.username||url.password||!((url.protocol==='https:'&&(url.origin===location.origin||externalImage))||(url.protocol==='blob:'&&url.origin===location.origin)||imageData)){warnings.push('Файл «'+(a.innerText||'вложение')+'» имеет недоступный адрес и не перенесён.');continue;}
      let name=a.download||a.getAttribute?.('download')||a.innerText.trim()||url.pathname.split('/').at(-1)||'file';
      try{
        if(imageData&&url.href.length>Math.ceil(20*1024*1024*4/3)+200)throw Error('изображение больше 20 МБ');
        const response=await fetch(url.href,{credentials:externalImage?'omit':'same-origin',redirect:a.requireImage?'follow':'error',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('HTTP '+response.status);
        const disposition=response.headers.get('Content-Disposition')||'';
        const encoded=/filename\*=UTF-8''([^;]+)/i.exec(disposition),plain=/filename="([^"]+)"|filename=([^;]+)/i.exec(disposition);
        if(encoded){try{name=decodeURIComponent(encoded[1]);}catch{}}else if(plain)name=(plain[1]||plain[2]).trim();
        const reader=response.body.getReader(),chunks=[];let size=0;
        while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>20*1024*1024||total+size>25*1024*1024){await reader.cancel();throw Error('превышен лимит размера файлов');}chunks.push(value);}
        const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
        const isPDF=new TextDecoder('ascii').decode(bytes.subarray(0,1024)).includes('%PDF-');
        if((a.requirePDF||/\.pdf$/i.test(name))&&!isPDF)throw Error('вместо PDF получена страница просмотра');
        if(isPDF&&!/\.pdf$/i.test(name))name+='.pdf';
        const raster=rasterType(bytes);if(a.requireImage&&!raster)throw Error('вместо изображения получена страница просмотра');
        if(a.requireImage&&!rasterExtension.test(name))name+='.'+raster[1];
        total+=size;files.push({name,type:isPDF?'application/pdf':raster?.[0]||(response.headers.get('Content-Type')||'application/octet-stream').split(';')[0],data:base64(bytes)});
        if(a.pdfGroup){downloadedPDFs.add(a.pdfGroup);pdfErrors.delete(a.pdfGroup);}
      }catch(e){const warning='Не удалось перенести «'+name+'»: '+e.message;if(a.pdfGroup)pdfErrors.set(a.pdfGroup,warning);else warnings.push(warning);}
      finally{if(a.revoke)URL.revokeObjectURL(a.href);}
    }
    for(const reference of pdfs.references)if(reference.revoke)URL.revokeObjectURL(reference.href);
    warnings.push(...pdfErrors.values());
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
    if(message.type==='ready'){respond({ready:document.readyState==='complete',version:14});return;}
    if(message.type!=='run')return;
    if(message.kind==='state'){respond({done:true,result:{state:readState()}});return;}
    if(message.kind==='diagnostics'){respond({done:true,result:fileDiagnostics()});return;}
    if(busy){respond({error:'Во вкладке уже выполняется запрос',notSent:true});return;}busy=true;activeJobId=message.id;
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
        if(input.innerText.trim()&&(normalized(input.innerText)!==normalized(message.text)||(message.files?.length||0)>0||hasComposerAttachments(composerRoot()))){
          if(!replaceOwnedDraft(input,message.text||'Посмотри прикреплённые файлы.'))throw Error('Во вкладке есть другой неотправленный черновик или вложения. Отправьте или удалите их вручную.');
        }
        await applySettings(message.settings);
        requireAvailable();if(readState().streaming)throw Error('В этом чате Claude ещё отвечает. Дождитесь завершения ответа.');
        const upload=await attachFiles(message.files);
        const text=message.text||'Посмотри прикреплённые файлы.';
        let textInsertions=0,readySince=0,lastReadiness=null,readyEditor=null,readyButton=null,textRefreshes=0,lastRefresh=Date.now();
        const prepareUntil=Date.now()+(upload?45000:20000);
        let send=null;
        while(Date.now()<prepareUntil){
          const root=composerRoot(),box=editor();if(!root||!box){await delay(100);continue;}
          requireAvailable();const problem=upload?uploadProblem(root):'';if(problem)throw Error('Claude не принял файл: '+problem);
          if(!normalized(box.innerText)){
            if(textInsertions>=3)throw Error('Claude несколько раз сбросил текст после загрузки файла. Черновик оставлен во вкладке; сообщение не отправлено.');
            if(insertOwnedText(text))textInsertions++;
          }else if(normalized(box.innerText)!==normalized(text))throw Error('Текст во вкладке Claude изменился. Черновик сохранён, отправка остановлена.');
          const button=findSend();
          lastReadiness={buttonFound:!!button,buttonEnabled:sendEnabled(button),attachmentsReady:uploadsAccepted(upload,root),uploading:!!upload&&uploading(root),textMatches:normalized(editor()?.innerText)===normalized(text)};
          if(!lastReadiness.buttonEnabled&&lastReadiness.textMatches&&lastReadiness.attachmentsReady&&!lastReadiness.uploading&&textRefreshes<2&&Date.now()-lastRefresh>=1000*(textRefreshes+1)){
            if(refreshComposerText(box,text))textRefreshes++;lastRefresh=Date.now();readySince=0;await delay(100);continue;
          }
          if(lastReadiness.attachmentsReady&&!lastReadiness.uploading&&lastReadiness.buttonEnabled&&lastReadiness.textMatches){
            if(!readySince||readyEditor!==box||readyButton!==button){readySince=Date.now();readyEditor=box;readyButton=button;}
            if(Date.now()-readySince>=400){send=button;break;}
          }else readySince=0;
          await delay(100);
        }
        if(!send){const reason=!lastReadiness?'Поле сообщения Claude ещё не готово.':!lastReadiness.buttonFound?'Не найдена кнопка отправки в активном поле Claude.':!lastReadiness.buttonEnabled?'Claude пока не разрешил отправку этого сообщения.':!lastReadiness.attachmentsReady||lastReadiness.uploading?'Claude ещё обрабатывает вложения.':'Поле сообщения Claude продолжает обновляться.';throw Error(reason+' Черновик сохранён; сообщение не отправлено.');}
        const before=responses().length,beforeUsers=new Set(userMessages().map(turnKey)),beforeAnswers=new Set(responses().map(turnKey));
        // One click only. A failed acknowledgement must never trigger a blind resend.
        if(!sendEnabled(send))throw Error('Поле Claude обновилось перед отправкой. Черновик сохранён.');
        ownedDraft=null;submissionAttempted=true;send.click();
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
            for(const file of files){if(file.id)continue;const ack=await chrome.runtime.sendMessage({type:'file',id:message.id,file});if(!ack?.ok)throw Error('Не удалось сохранить созданный файл на Mac');}
            for(const warning of warnings)await chrome.runtime.sendMessage({type:'warning',id:message.id,warning});
            const state=snapshot();respond({done:true,result:{url:state.url,title:state.title,state:state.state}});return;
          }
        }
        throw Error('Время ожидания истекло. Проверьте чат на Mac перед повторной отправкой.');
      }catch(e){respond({error:e.message,notSent:e.notSent===true||!submissionAttempted,state:e.state});}finally{busy=false;activeJobId=null;}
    })();return true;
  });
})();
