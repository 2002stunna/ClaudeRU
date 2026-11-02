import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { conversationURL } from './bridge.mjs';

export class ExtensionBridge {
  constructor({ token = randomBytes(32).toString('hex'), timeout = 240000 } = {}) {
    this.token = token; this.timeout = timeout; this.lastSeen = 0; this.pending = null;
  }
  get status() { return { connected: Date.now() - this.lastSeen < 30000, mode: 'extension' }; }
  async open(port = 3001) {
    this.server = http.createServer(async (req, res) => {
      const json = (status, data) => { res.writeHead(status, {'Content-Type':'application/json','Cache-Control':'no-store'}); res.end(JSON.stringify(data)); };
      const origin = req.headers.origin;
      if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host || '')) return json(403, {error:'Invalid host'});
      if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return json(403, {error:'Extension only'});
      if(origin)res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');
        res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
        res.writeHead(204); res.end(); return;
      }
      const token = (req.headers.authorization || '').replace(/^Bearer /,'');
      if (!/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token),Buffer.from(this.token))) return json(401,{error:'Неверный код подключения'});
      if (req.method === 'GET' && req.url === '/poll') {
        this.lastSeen = Date.now();
        const job = this.pending;
        if (job && !job.delivered) { job.delivered = true; return json(200,{id:job.id,text:job.text,url:job.url}); }
        // Keep requests shorter than MV3's fetch timeout, and allow regular heartbeats.
        const timer = setTimeout(()=>json(200,{idle:true}), 15000);
        res.on('close',()=>clearTimeout(timer));
        return;
      }
      if (req.method === 'POST' && req.url === '/event') {
        try {
          let raw=''; for await (const chunk of req) { raw+=chunk; if(Buffer.byteLength(raw)>2_000_000) return json(413,{error:'Too large'}); }
          const event = JSON.parse(raw), job = this.pending;
          if (!job || event.id !== job.id) return json(409,{error:'Задание уже завершено'});
          if (event.type === 'update') {
            if(typeof event.text!=='string') return json(400,{error:'Invalid text'});
            job.onUpdate({text:event.text,url:event.url ? conversationURL(event.url) : null});
          } else if (event.type === 'done') { this.finish(); }
          else if (event.type === 'error') { this.finish(new Error(String(event.error || 'Ошибка расширения').slice(0,1000))); }
          else return json(400,{error:'Invalid event'});
          return json(200,{ok:true});
        } catch { return json(400,{error:'Invalid event'}); }
      }
      json(404,{error:'Not found'});
    });
    await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(port,'127.0.0.1',resolve);});
  }
  finish(error) {
    const job=this.pending;if(!job)return;
    clearTimeout(job.timer);this.pending=null;
    if(error)job.reject(error);else job.resolve();
  }
  async send({text,url,onUpdate}) {
    if(this.pending)throw Error('Уже выполняется запрос');
    if(!this.status.connected)throw Error('Расширение не подключено. Откройте вкладку Claude на Mac и подключите её через значок ClaudeRU.');
    conversationURL(url);
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.finish(new Error('Нет завершённого ответа за 4 минуты. Проверьте вкладку Claude на Mac перед повторной отправкой.')),this.timeout);
      this.pending={id:randomBytes(16).toString('hex'),text,url,onUpdate,resolve,reject,timer,delivered:false};
    });
  }
  async close() {
    this.finish(new Error('Сервер остановлен'));
    if(this.server)await new Promise(resolve=>{this.server.closeAllConnections();this.server.close(resolve);});
  }
}
