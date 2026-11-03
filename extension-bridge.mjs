import http from 'node:http';
import {readBrowserDownload} from './browser-download.mjs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { conversationURL } from './bridge.mjs';

export class ExtensionBridge {
  constructor({ token = randomBytes(32).toString('hex'), timeout = 240000 } = {}) {
    this.token = token; this.timeout = timeout; this.lastSeen = 0; this.jobs = new Map(); this.compatibilityError=null; this.clientVersion=null; this.pollWaiters=new Set();
  }
  get pending() { return this.jobs.values().next().value||null; }
  get status() { const connected=Date.now()-this.lastSeen<5000;return {connected,mode:'extension',extensionVersion:this.clientVersion,error:connected?null:this.compatibilityError}; }
  async open(port = 3001) {
    this.server = http.createServer(async (req, res) => {
      const json = (status, data) => { res.writeHead(status, {'Content-Type':'application/json','Cache-Control':'no-store'}); res.end(JSON.stringify(data)); };
      const origin = req.headers.origin;
      if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host || '')) return json(403, {error:'Invalid host'});
      if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return json(403, {error:'Extension only'});
      if(origin)res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type, X-ClaudeRU-Protocol, X-ClaudeRU-Page-Protocol, X-ClaudeRU-Version');
        res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
        res.writeHead(204); res.end(); return;
      }
      const token = (req.headers.authorization || '').replace(/^Bearer /,'');
      if (!/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token),Buffer.from(this.token))) return json(401,{error:'Неверный код подключения'});
      if(req.method==='GET'&&['/poll','/health'].includes(req.url)){
        const version=req.headers['x-clauderu-version'];
        this.clientVersion=typeof version==='string'&&/^\d+\.\d+\.\d+$/.test(version)?version:null;
        if(req.headers['x-clauderu-protocol']!=='13'||req.headers['x-clauderu-page-protocol']!=='13'){
          this.lastSeen=0;
          this.compatibilityError=req.headers['x-clauderu-protocol']!=='13'
            ?'Работает старая версия расширения. Перезагрузите ClaudeRU до версии 0.6.0 на странице browser://extensions/ и обновите вкладку Claude.'
            :'Расширение обновлено, но вкладка Claude использует старый код. Обновите страницу claude.ai и подключите её заново.';
          return json(426,{error:this.compatibilityError,requiredProtocol:13});
        }
        this.lastSeen=Date.now();this.compatibilityError=null;
        if(req.url==='/health')return json(200,{ok:true,protocol:13});
      }
      if (req.method === 'GET' && req.url === '/poll') {
        let timer;
        const cleanup=()=>{clearTimeout(timer);this.pollWaiters.delete(deliver);};
        const deliver=()=>{
          if(res.destroyed||res.writableEnded){cleanup();return false;}
          const job=[...this.jobs.values()].find(j=>!j.delivered);
          if(!job||job.delivered)return false;
          job.delivered=true;cleanup();json(200,{id:job.id,...job.payload});return true;
        };
        if(deliver())return;
        this.pollWaiters.add(deliver);
        timer=setTimeout(()=>{cleanup();if(!res.destroyed&&!res.writableEnded)json(200,{idle:true});},1000);
        res.on('close',cleanup);
        return;
      }
      if (req.method === 'POST' && req.url === '/event') {
        try {
          let size=0; const chunks=[]; for await (const chunk of req) { size+=chunk.length; if(size>36_000_000) return json(413,{error:'Too large'});chunks.push(chunk); }
          const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));const job=this.jobs.get(event.id);
          if (!job || event.id !== job.id) return json(409,{error:'Задание уже завершено'});
          if (event.type === 'update') {
            if(typeof event.text!=='string') return json(400,{error:'Invalid text'});
            job.onUpdate?.({text:event.text,url:event.url ? conversationURL(event.url) : null});
          } else if (event.type === 'file') {
            if(!job.onFile)return json(400,{error:'Files not accepted'});
            await job.onFile(event.file);
          } else if(event.type==='download'){
            if(!job.onFile)return json(400,{error:'Files not accepted'});
            try{const file=await readBrowserDownload(job.id,event.download,job.createdAt);const saved=await job.onFile(file);return json(200,{ok:true,file:saved});}catch(e){return json(400,{error:e.message});}
          } else if (event.type === 'warning') { job.onWarning?.(String(event.warning).slice(0,1000));
          } else if (event.type === 'done') { this.finish(job.id,null,event.result); }
          else if (event.type === 'error') { const error=new Error(String(event.error || 'Ошибка расширения').slice(0,1000));error.notSent=event.notSent===true;error.state=event.state;this.finish(job.id,error); }
          else return json(400,{error:'Invalid event'});
          return json(200,{ok:true});
        } catch { return json(400,{error:'Invalid event'}); }
      }
      json(404,{error:'Not found'});
    });
    await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(port,'127.0.0.1',resolve);});
  }
  finish(id,error,result) {
    const job=this.jobs.get(id);if(!job)return;
    clearTimeout(job.timer);this.jobs.delete(id);
    if(error)job.reject(error);else job.resolve(result);
  }
  async execute(payload, handlers={}) {
    const key=payload.chatId||payload.url||'default';
    if([...this.jobs.values()].some(j=>j.key===key&&j.payload.kind!=='state'&&payload.kind!=='state'))throw Error('В этом чате уже выполняется запрос');
    if(this.jobs.size>=12)throw Error('Слишком много одновременных действий. Подождите завершения одного из них.');
    if(!this.status.connected)throw Error(this.status.error||'Расширение не подключено. Откройте вкладку Claude на Mac и подключите её через значок ClaudeRU.');
    if(payload.url)conversationURL(payload.url);
    return new Promise((resolve,reject)=>{
      const id=randomBytes(16).toString('hex');
      const timer=setTimeout(()=>this.finish(id,new Error('Нет завершённого ответа за 4 минуты. Проверьте вкладку Claude на Mac перед повторной отправкой.')),this.timeout);
      this.jobs.set(id,{id,key,payload,...handlers,resolve,reject,timer,delivered:false,createdAt:Date.now()});
      for(const deliver of [...this.pollWaiters])deliver();
    });
  }
  async send({chatId,text,url,settings={},files=[],catalogCache,onUpdate,onFile,onWarning}) {
    return this.execute({kind:'chat',chatId,text,url,settings,files,catalogCache},{onUpdate,onFile,onWarning});
  }
  async close() {
    for(const id of this.jobs.keys())this.finish(id,new Error('Сервер остановлен'));
    if(this.server)await new Promise(resolve=>{this.server.closeAllConnections();this.server.close(resolve);});
  }
}
