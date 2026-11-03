import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ClaudeBridge, conversationURL } from './bridge.mjs';
import { ExtensionBridge } from './extension-bridge.mjs';
import { MODEL_NAMES, isModelCacheComplete, catalogFor } from './model-catalog.mjs';
import { DataStore, chatOptions, MAX_FILES, MAX_TOTAL } from './data-store.mjs';

export function createApp({ auth, bridge, secure = false, store = new DataStore() }) {
  bridge.onDeleted=records=>store.remoteDeletions(records);
  const sessions = new Map();let failures = [];const active=new Map();
  let catalogInitialization=null,catalogWarning='';
  const assets = {'/model-catalog.js':['../model-catalog.mjs','text/javascript; charset=utf-8'], '/':['index.html','text/html; charset=utf-8'], '/app.js':['app.js','text/javascript; charset=utf-8'], '/style.css':['style.css','text/css; charset=utf-8']};
  async function ensureModelCatalog(){
    await store.ready;if(!bridge.execute||isModelCacheComplete(store.modelCatalog))return;
    if(!catalogInitialization){
      catalogInitialization=(async()=>{const result=await bridge.execute({kind:'catalog',chatId:'catalog-init',catalogCache:store.modelCatalog});catalogWarning=result?.catalog?.warning||'';if(result?.catalog?.byModel)await store.saveModelCatalog({version:1,byModel:result.catalog.byModel});})().finally(()=>{catalogInitialization=null;});
    }
    await catalogInitialization;
  }
  async function executeWithCatalog(payload){
    let downloadedCount=0,downloadedSize=0;
    await ensureModelCatalog();const result=await bridge.execute({...payload,catalogCache:store.modelCatalog},{onFile:async file=>{const size=Buffer.byteLength(file.data,'base64');if(downloadedCount>=MAX_FILES||downloadedSize+size>MAX_TOTAL)throw Error('Превышен лимит созданных файлов');const meta=await store.putFile(file);downloadedCount++;downloadedSize+=meta.size;return meta;}});
    if(result?.catalog){
      result.catalog=catalogFor(store.modelCatalog,result.catalog.current,result.catalog.warning||catalogWarning);
    }
    return result;
  }
  function allowedSettings(value){const settings=chatOptions(value);if(settings.model&&!MODEL_NAMES.includes(settings.model))throw Error('Выберите одну из шести моделей в меню ClaudeRU');return settings;}
  async function applySnapshot(chat,snapshot) {
    if(!snapshot||typeof snapshot!=='object')throw Error('Расширение не вернуло содержимое чата');
    if(Object.hasOwn(snapshot,'url')&&(snapshot.url||null)!==(chat.url||null))throw Error('Вкладка Claude переключилась на другой разговор. Обновите текущий чат.');
    if(typeof snapshot.title==='string'&&snapshot.title.trim())chat.title=snapshot.title.slice(0,160);
    if(Array.isArray(snapshot.messages)) {
      const messages=[];
      for(const message of snapshot.messages.slice(0,2000)){
        if(!['user','assistant'].includes(message?.role)||typeof message.text!=='string')continue;
        const files=[];
        for(const file of (Array.isArray(message.files)?message.files:[]).slice(0,MAX_FILES))files.push(file.id?(await store.readFile(file.id)).meta:await store.putFile(file));
        const prior=chat.messages.find(m=>m.role===message.role&&m.text===message.text);
        if(!files.length&&prior?.files?.length)files.push(...prior.files);
        messages.push({role:message.role,text:message.text.slice(0,500000),files});
      }
      if(messages.length)chat.messages=messages;
    }
    applyState(chat,snapshot.state);chat.loaded=true;await store.save(chat);return chat;
  }
  function applyState(chat,state){
    if(!state||typeof state!=='object')return;
    chat.settings=chatOptions(state);chat.claudeState={...chat.settings,blocked:typeof state.blocked==='string'?state.blocked.slice(0,1500):'',streaming:state.streaming===true};chat.verifiedAt=Date.now();
  }
  async function chatAction(chat,action,fields={}){
    if(action==='delete'&&fields.localOnly){await store.deleteChat(chat,'local');return {chat,localOnly:true,historyRevision:store.deletionRevision};}
    if(chat.url){
      if(!bridge.execute)throw Error('Обновите расширение ClaudeRU');
      let result;try{result=await bridge.execute({kind:'manage',chatId:chat.id,url:chat.url,action,...fields});}catch(e){if(action==='delete'&&/Не найдено меню именно этого чата|Чат не найден|conversation not found/i.test(e.message)){await store.deleteChat(chat,'local');return {chat,localOnly:true,historyRevision:store.deletionRevision,warning:'Удалено из обёртки. Удаление в Claude не подтверждено.'};}throw e;}
      if(action==='move'&&fields.group===undefined)return result;
      if(result?.applied!==true)throw Error('Claude не подтвердил действие. Изменения не сохранены.');
    }else if(action==='move'&&fields.group===undefined)return {groups:[...new Set((await store.list()).map(c=>c.group).filter(Boolean))]};
    if(action==='rename'){chat.title=fields.title;chat.customTitle=true;}
    if(action==='pin'||action==='unpin')chat.pinned=action==='pin';
    if(action==='unread')chat.unread=true;
    if(action==='archive')chat.archived=true;
    if(action==='delete'){await store.deleteChat(chat);return {chat,historyRevision:store.deletionRevision};}
    if(action==='move')chat.group=fields.group;
    await store.save(chat);return {chat};
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (code, value) => { res.writeHead(code, {'Content-Type':'application/json'}); res.end(JSON.stringify(value)); };
    const cookie = /(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    const now = Date.now();for (const [key, expiry] of sessions) if (expiry < now) sessions.delete(key);
    const authorized = cookie && sessions.has(cookie);
    try {
      if (req.method === 'GET' && assets[req.url]) {
        const [name, type] = assets[req.url];res.setHeader('Content-Type',type);res.end(await readFile(new URL('./public/'+name,import.meta.url)));return;
      }
      if(req.method==='GET'){
        if(req.url==='/api/session')return json(200,{authenticated:!!authorized});
        if(!authorized)return json(401,{error:'Войдите в систему'});
        if(req.url==='/api/bridge')return json(200,{...(bridge.status||{mode:'browser',connected:true}),historyRevision:store.deletionRevision,busy:active.size>0,activeChats:[...active.entries()].map(([id,kind])=>({id,kind}))});
        if(req.url==='/api/chats')return json(200,{chats:await store.list(),historyRevision:store.deletionRevision});
        const fileMatch=/^\/api\/files\/([a-f0-9]{32})(\?preview=1)?$/.exec(req.url);
        if(fileMatch){
          try { const {meta,bytes}=await store.readFile(fileMatch[1]);const inline=!!fileMatch[2]&&/^image\/(png|jpeg|gif|webp|avif|bmp)$/i.test(meta.type);res.writeHead(200,{'Content-Type':meta.type,'Content-Disposition':`${inline?'inline':'attachment'}; filename="download"; filename*=UTF-8''${encodeURIComponent(meta.name.toWellFormed())}`,'Content-Length':bytes.length});res.end(bytes); }
          catch{return json(404,{error:'Файл не найден'});}return;
        }
        return json(404,{error:'Не найдено'});
      }
      if(req.method!=='POST')return json(404,{error:'Не найдено'});
      const expected=`${secure?'https':'http'}://${req.headers.host}`;
      if(req.headers.origin!==expected || req.headers['content-type']!=='application/json')return json(403,{error:'Недопустимый источник запроса'});
      if(req.url!=='/api/login'&&!authorized)return json(401,{error:'Войдите в систему'});
      const limit=req.url==='/api/uploads'?30_000_000:req.url==='/api/login'?16000:2_000_000;
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>limit)return json(413,{error:'Превышен допустимый размер запроса'});chunks.push(chunk);}
      let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!body||typeof body!=='object'||Array.isArray(body))throw Error();}catch{return json(400,{error:'Некорректный JSON'});}
      if(req.url==='/api/login'){
        failures=failures.filter(t=>now-t<15*60*1000);
        if(failures.length>=10)return json(429,{error:'Слишком много попыток. Подождите 15 минут.'});
        if(typeof body.password!=='string'||body.password.length>1024)return json(400,{error:'Некорректный пароль'});
        if(!timingSafeEqual(scryptSync(body.password,auth.salt,64),Buffer.from(auth.hash,'hex'))){failures.push(now);return json(401,{error:'Неверный пароль'});}
        const token=randomBytes(32).toString('hex');sessions.set(token,now+12*60*60*1000);
        res.setHeader('Set-Cookie',`session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure?'; Secure':''}`);return json(200,{ok:true});
      }
      if(req.url==='/api/logout'){sessions.delete(cookie);res.setHeader('Set-Cookie','session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return json(200,{ok:true});}
      if(req.url==='/api/uploads'){
        try{return json(200,{file:await store.putFile(body)});}catch(e){return json(400,{error:e.message});}
      }
      if(req.url==='/api/file-diagnostics'){
        try{const chat=await store.get(body.id);return json(200,{diagnostics:await bridge.execute({kind:'diagnostics',chatId:chat.id,url:chat.url})});}catch(e){return json(400,{error:e.message});}
      }
      if(req.url==='/api/chats/new'){
        try{return json(200,{chat:await store.create({settings:chatOptions(body.settings)})});}catch(e){return json(400,{error:e.message});}
      }
      if(req.url==='/api/chats/import'){
        if(!Array.isArray(body.chats))return json(400,{error:'Некорректная история'});
        for(const c of body.chats.slice(0,200)){
          try{if(!c||typeof c.title!=='string')continue;await store.create({title:c.title,url:c.url||null,messages:(Array.isArray(c.messages)?c.messages:[]).filter(m=>['user','assistant'].includes(m?.role)&&typeof m.text==='string').slice(0,1000).map(m=>({role:m.role,text:m.text.slice(0,100000),files:[]})),settings:chatOptions(c.settings)});}catch{}
        }return json(200,{chats:await store.list()});
      }
      if(req.url==='/api/chats/metadata'||req.url==='/api/chats/action'){
        const key=body.id;if(active.has(key))return json(409,{error:'В этом чате ещё выполняется действие'});active.set(key,'manage');
        try{
          let chat;try{chat=await store.get(body.id);}catch(e){const deleted=store.chats.find(c=>c.id===body.id&&c.deleted);if(body.action==='delete'&&deleted)return json(200,{chat:deleted,historyRevision:store.deletionRevision,localOnly:true});throw e;}
          let action=body.action;if(req.url.endsWith('/metadata'))action=body.title!==undefined?'rename':body.pinned?'pin':'unpin';
          if(!['rename','pin','unpin','unread','archive','delete','move'].includes(action))throw Error('Неизвестное действие с чатом');
          const fields={};
          if(action==='delete')fields.localOnly=body.localOnly===true;
          if(action==='rename'){if(typeof body.title!=='string'||!body.title.trim()||body.title.length>160)throw Error('Введите название до 160 символов');fields.title=body.title.trim();}
          if(action==='move'&&body.group!==undefined){if(typeof body.group!=='string'||!body.group.trim()||body.group.length>160)throw Error('Выберите группу');fields.group=body.group;}
          const result=await chatAction(chat,action,fields);if(req.url.endsWith('/metadata')&&action==='rename'&&typeof body.pinned==='boolean')await chatAction(chat,body.pinned?'pin':'unpin');return json(200,result);
        }catch(e){return json(400,{error:e.message});}finally{active.delete(key);}
      }
      if(req.url==='/api/chats/settings'||req.url==='/api/options'){
        const key=body.id;if(active.has(key))return json(409,{error:'В этом чате ещё выполняется действие'});
        if(!bridge.execute)return json(400,{error:'Обновите расширение ClaudeRU'});active.set(key,'options');
        try{
          const chat=await store.get(key),settings=allowedSettings(body.settings);
          const result=await executeWithCatalog({kind:'options',chatId:key,url:chat.url,settings});
          if(!result?.catalog?.current)throw Error('Не получены фактические настройки Claude');
          applyState(chat,result.catalog.current);chat.catalog=result.catalog;await store.save(chat);return json(200,{catalog:result.catalog,chat});
        }catch(e){return json(400,{error:e.message});}finally{active.delete(key);}
      }
      if(req.url==='/api/chats/state'){
        try{const chat=await store.get(body.id),verifiedBefore=chat.verifiedAt;if(active.has(chat.id))return json(409,{error:'В этом чате выполняется действие'});const result=await bridge.execute({kind:'state',chatId:chat.id,url:chat.url});if(chat.verifiedAt===verifiedBefore&&!active.has(chat.id))applyState(chat,result.state);return json(200,{state:chat.claudeState});}
        catch(e){return json(400,{error:e.message});}
      }
      if(req.url==='/api/current'){
        try{
          if(!bridge.execute)return json(200,{supported:false});
          const selected=(await store.list()).find(c=>c.id===body.id),selectedChatId=selected&&(selected.url||null)===(body.knownURL||null)?selected.id:undefined;
          const result=await bridge.execute({kind:'current',chatId:'native-current',selectedChatId,knownURL:body.knownURL,includeSnapshot:body.includeSnapshot===true});
          if(result?.current!==true)return json(200,{supported:false,loading:result?.loading===true});
          const url=result.url?conversationURL(result.url):null;let chat;
          if(url){chat=await store.create({url,title:result.snapshot?.title||result.title||'Без названия'});if(chat.deleted&&chat.deletionSource==='local'&&result.snapshot?.messages?.length)await store.restoreLocal(chat);if(chat.deleted)return json(200,{supported:true,hidden:true,url});}
          else if(result.isNew){const list=await store.list(),matches=c=>!c.url&&(!c.messages.length||active.get(c.id)==='chat');chat=list.find(c=>c.id===result.boundChatId&&matches(c))||list.find(c=>c.id===body.id&&matches(c))||list.find(c=>!c.url&&!c.messages.length)||await store.create({title:'Новая сессия'});}
          else return json(200,{supported:false});
          if(!active.has(chat.id)){if(result.snapshot)await applySnapshot(chat,result.snapshot);else if(result.state){const before=JSON.stringify(chat.claudeState);applyState(chat,result.state);if(before!==JSON.stringify(chat.claudeState))await store.save(chat);}}
          return json(200,{supported:true,chat,url,isNew:result.isNew===true,catalog:catalogFor(store.modelCatalog,result.state||chat.settings),historyRevision:store.deletionRevision});
        }catch(e){return json(400,{error:e.message});}
      }
      if(req.url==='/api/sync'||req.url==='/api/chats/open'){
        const key=req.url==='/api/sync'?'sync':body.id;
        if(active.has(key))return json(409,{error:'В этом чате ещё выполняется действие'});
        if(!bridge.execute)return json(400,{error:'Эта функция требует нового расширения ClaudeRU'});
        active.set(key,'open');
        try {
          if(req.url==='/api/sync'){
            if(body.refreshCatalog===true){if(catalogInitialization)await catalogInitialization;await store.saveModelCatalog({version:1,byModel:{}},{replace:true});}
            const result=await executeWithCatalog({kind:'inspect',chatId:'sync'});
            if(!result||!Array.isArray(result.chats))throw Error('Обновите расширение ClaudeRU и вкладку Claude');
            await store.importIndex(result.chats);
            if(result.snapshot?.url){const chat=await store.create({url:result.snapshot.url,title:result.snapshot.title});if(!chat.deleted&&!active.has(chat.id))await applySnapshot(chat,result.snapshot);}
            return json(200,{chats:await store.list(),catalog:result.catalog});
          }
          const chat=await store.get(body.id);
          const result=await executeWithCatalog({kind:'open',chatId:chat.id,url:chat.url,collectArtifacts:body.collectArtifacts===true,followNative:body.followNative===true});
          if(result?.unavailable===true){await store.deleteChat(chat,'missing');return json(200,{removed:true,id:chat.id,historyRevision:store.deletionRevision});}
          if(result?.snapshot)await applySnapshot(chat,result.snapshot);chat.unread=false;
          if(result?.catalog){applyState(chat,result.catalog.current);chat.catalog=result.catalog;await store.save(chat);}
          return json(200,{chat,catalog:result.catalog,warnings:result.warnings||[]});
        }catch(e){return json(400,{error:e.message});}finally{active.delete(key);}
      }
      if(req.url==='/api/chat'){
        let settings,files,chat;
        try{
          if(typeof body.text!=='string'||body.text.length>20000||(!body.text.trim()&&!(body.fileIds?.length)))throw Error('Введите сообщение до 20 000 символов или добавьте файл');
          if(body.url)conversationURL(body.url);
          if(bridge.status&&!bridge.status.connected)throw Error(bridge.status.error||'Расширение не подключено. Подключите вкладку Claude на Mac.');
          settings=allowedSettings(body.settings);files=await store.wireFiles(body.fileIds);
          if(!bridge.execute&&(files.length||settings.model||settings.effort))throw Error('Настройки и файлы поддерживаются в режиме расширения. Запустите сервер без BRIDGE_MODE=browser.');
          if(!bridge.execute&&active.size)return json(409,{error:'Уже формируется ответ. Дождитесь его завершения.'});
          await ensureModelCatalog();
          chat=body.chatId?await store.get(body.chatId):await store.create({url:body.url||null});
          if(bridge.execute&&!chat.url&&chat.messages.length)throw Error('У этой локальной копии нет связанного чата Claude. Откройте текущий чат Claude или создайте новую сессию.');
          if(active.has(chat.id))return json(409,{error:'В этом чате уже формируется ответ. Дождитесь его завершения.'});
        }catch(e){return json(400,{error:e.message});}
        const previousTitle=chat.title,previousLoaded=chat.loaded;active.set(chat.id,'chat');chat.settings=settings;delete chat.draft;
        if(!chat.customTitle&&!chat.messages.length&&body.text.trim())chat.title=body.text.slice(0,60);
        chat.messages.push({role:'user',text:body.text,files:files.map(({data,...meta})=>meta)});
        const answer={role:'assistant',text:'',files:[]};chat.messages.push(answer);chat.loaded=true;
        try{await store.save(chat);}catch{active.delete(chat.id);return json(500,{error:'Не удалось сохранить историю на Mac'});}
        res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','X-Accel-Buffering':'no'});
        const write=data=>{if(!res.destroyed)res.write(JSON.stringify(data)+'\n');};let generatedSize=0;
        try{
          const result=await bridge.send({chatId:chat.id,text:body.text,url:chat.url,settings,files,catalogCache:store.modelCatalog,
            onUpdate:data=>{answer.text=data.text;if(data.url)chat.url=conversationURL(data.url);write({type:'update',...data});},
            onFile:async file=>{if(answer.files.length>=MAX_FILES)throw Error('За один ответ можно получить до 5 файлов');if(typeof file?.data==='string'&&generatedSize+Buffer.byteLength(file.data,'base64')>MAX_TOTAL)throw Error('Общий размер созданных файлов больше 25 МБ');const meta=await store.putFile(file);generatedSize+=meta.size;answer.files.push(meta);write({type:'file',file:meta});return meta;},
            onWarning:warning=>write({type:'warning',warning})});
          if(result?.url)chat.url=conversationURL(result.url);
          applyState(chat,result?.state);
          if(result?.title&&!chat.customTitle)chat.title=String(result.title).slice(0,160);
          await store.save(chat);write({type:'done',chat});
        }catch(e){applyState(chat,e.state);if(e.notSent===true){const index=chat.messages.indexOf(answer);if(index>=1)chat.messages.splice(index-1,2);chat.title=previousTitle;chat.loaded=previousLoaded;chat.draft={text:body.text,files:files.map(({data,...meta})=>meta)};}else answer.error=e.message;try{await store.save(chat);}catch{}write({type:'error',error:e.message,notSent:e.notSent===true,state:e.state});}
        finally{active.delete(chat.id);res.end();}return;
      }
      return json(404,{error:'Не найдено'});
    }catch{if(!res.headersSent)json(500,{error:'Ошибка сервера. Проверьте терминал на Mac.'});else res.end();}
  });return server;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  let auth;try{auth=JSON.parse(await readFile('.local/auth.json','utf8'));}catch{console.error('Сначала выполните npm run setup');process.exit(1);}
  const store=new DataStore('.local');await store.ready;
  const bridge=process.env.BRIDGE_MODE==='browser'?new ClaudeBridge():new ExtensionBridge();await bridge.open();
  if(bridge instanceof ExtensionBridge)console.log('Код подключения расширения (вставьте только в расширение на своём Mac):\n'+bridge.token);
  const server=createApp({auth,bridge,store,secure:process.env.COOKIE_SECURE==='1'});
  server.listen(Number(process.env.PORT||3000),'127.0.0.1',()=>console.log('ClaudeRU запущен на порту '+(process.env.PORT||3000)+'. Для внешнего доступа используйте HTTPS-туннель.'));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{server.close();await bridge.close();process.exit(0);});
}
