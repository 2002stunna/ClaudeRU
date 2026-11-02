import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { conversationURL } from './bridge.mjs';

export class ExtensionBridge {
  constructor({ token = randomBytes(32).toString('hex'), timeout = 240000 } = {}) {
    this.token = token; this.timeout = timeout; this.lastSeen = 0; this.pending = null; this.compatibilityError=null; this.clientVersion=null;
  }
  get status() { const connected=Date.now()-this.lastSeen<30000;return {connected,mode:'extension',extensionVersion:this.clientVersion,error:connected?null:this.compatibilityError}; }
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
        if(req.headers['x-clauderu-protocol']!=='4'||req.headers['x-clauderu-page-protocol']!=='4'){
          this.lastSeen=0;
          this.compatibilityError=req.headers['x-clauderu-protocol']!=='4'
            ?'Работает старая версия расширения. Перезагрузите ClaudeRU до версии 0.4.1 на странице browser://extensions/ и обновите вкладку Claude.'
            :'Расширение обновлено, но вкладка Claude использует старый код. Обновите страницу claude.ai и подключите её заново.';
          return json(426,{error:this.compatibilityError,requiredProtocol:4});
        }
        this.lastSeen=Date.now();this.compatibilityError=null;
        if(req.url==='/health')return json(200,{ok:true,protocol:4});
      }
      if (req.method === 'GET' && req.url === '/poll') {
        this.lastSeen = Date.now();
        const job = this.pending;
        if (job && !job.delivered) { job.delivered = true; return json(200,{id:job.id,...job.payload}); }
        // Keep requests shorter than MV3's fetch timeout, and allow regular heartbeats.
        const timer = setTimeout(()=>json(200,{idle:true}), 15000);
        res.on('close',()=>clearTimeout(timer));
        return;
      }
      if (req.method === 'POST' && req.url === '/event') {
        try {
          let size=0; const chunks=[]; for await (const chunk of req) { size+=chunk.length; if(size>36_000_000) return json(413,{error:'Too large'});chunks.push(chunk); }
          const event = JSON.parse(Buffer.concat(chunks).toString('utf8')), job = this.pending;
          if (!job || event.id !== job.id) return json(409,{error:'Задание уже завершено'});
          if (event.type === 'update') {
            if(typeof event.text!=='string') return json(400,{error:'Invalid text'});
            job.onUpdate?.({text:event.text,url:event.url ? conversationURL(event.url) : null});
          } else if (event.type === 'file') {
            if(!job.onFile)return json(400,{error:'Files not accepted'});
            await job.onFile(event.file);
          } else if (event.type === 'warning') { job.onWarning?.(String(event.warning).slice(0,1000));
          } else if (event.type === 'done') { this.finish(null,event.result); }
          else if (event.type === 'error') { this.finish(new Error(String(event.error || 'Ошибка расширения').slice(0,1000))); }
          else return json(400,{error:'Invalid event'});
          return json(200,{ok:true});
        } catch { return json(400,{error:'Invalid event'}); }
      }
      json(404,{error:'Not found'});
    });
    await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(port,'127.0.0.1',resolve);});
  }
  finish(error,result) {
    const job=this.pending;if(!job)return;
    clearTimeout(job.timer);this.pending=null;
    if(error)job.reject(error);else job.resolve(result);
  }
  async execute(payload, handlers={}) {
    if(this.pending)throw Error('Уже выполняется запрос');
    if(!this.status.connected)throw Error(this.status.error||'Расширение не подключено. Откройте вкладку Claude на Mac и подключите её через значок ClaudeRU.');
    if(payload.url)conversationURL(payload.url);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.finish(new Error('Нет завершённого ответа за 4 минуты. Проверьте вкладку Claude на Mac перед повторной отправкой.')),this.timeout);
      this.pending={id:randomBytes(16).toString('hex'),payload,...handlers,resolve,reject,timer,delivered:false};
    });
  }
  async send({text,url,settings={},files=[],onUpdate,onFile,onWarning}) {
    return this.execute({kind:'chat',text,url,settings,files},{onUpdate,onFile,onWarning});
  }
  async close() {
    this.finish(new Error('Сервер остановлен'));
    if(this.server)await new Promise(resolve=>{this.server.closeAllConnections();this.server.close(resolve);});
  }
}
