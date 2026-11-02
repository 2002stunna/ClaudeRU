import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ClaudeBridge, conversationURL } from './bridge.mjs';

export function createApp({ auth, bridge, secure = false }) {
  const sessions = new Map();
  let failures = [], active = false;
  const assets = {'/':['index.html','text/html; charset=utf-8'], '/app.js':['app.js','text/javascript; charset=utf-8'], '/style.css':['style.css','text/css; charset=utf-8']};
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (code, value) => { res.writeHead(code, {'Content-Type':'application/json'}); res.end(JSON.stringify(value)); };
    const cookie = /(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    const now = Date.now();
    for (const [key, expiry] of sessions) if (expiry < now) sessions.delete(key);
    const authorized = cookie && sessions.has(cookie);
    try {
      if (req.method === 'GET' && assets[req.url]) {
        const [name, type] = assets[req.url];
        res.setHeader('Content-Type',type); res.end(await readFile(new URL('./public/'+name,import.meta.url))); return;
      }
      if (req.method === 'GET' && req.url === '/api/session') return json(200,{authenticated:!!authorized});
      if (req.method !== 'POST') return json(404,{error:'Не найдено'});
      // Require a same-origin browser request, including login (prevents login CSRF).
      const origin = req.headers.origin;
      const expected = `${secure ? 'https' : 'http'}://${req.headers.host}`;
      if (origin !== expected || req.headers['content-type'] !== 'application/json') return json(403,{error:'Недопустимый источник запроса'});
      if (req.url !== '/api/login' && !authorized) return json(401,{error:'Войдите в систему'});
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 64000) return json(413,{error:'Сообщение слишком большое'}); }
      let body; try { body = JSON.parse(raw); } catch { return json(400,{error:'Некорректный JSON'}); }
      if (req.url === '/api/login') {
        failures = failures.filter(t => now-t < 15*60*1000);
        if (failures.length >= 10) return json(429,{error:'Слишком много попыток. Подождите 15 минут.'});
        if (typeof body.password !== 'string' || body.password.length > 1024) return json(400,{error:'Некорректный пароль'});
        const actual = scryptSync(body.password,auth.salt,64);
        if (!timingSafeEqual(actual,Buffer.from(auth.hash,'hex'))) { failures.push(now); return json(401,{error:'Неверный пароль'}); }
        const token = randomBytes(32).toString('hex'); sessions.set(token,now+12*60*60*1000);
        res.setHeader('Set-Cookie',`session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure ? '; Secure' : ''}`);
        return json(200,{ok:true});
      }
      if (req.url === '/api/logout') {
        sessions.delete(cookie); res.setHeader('Set-Cookie','session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return json(200,{ok:true});
      }
      if (req.url === '/api/chat') {
        if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 20000) return json(400,{error:'Введите сообщение до 20 000 символов'});
        try { conversationURL(body.url); } catch { return json(400,{error:'Некорректный адрес чата'}); }
        if (active) return json(409,{error:'Уже формируется ответ. Дождитесь его завершения.'});
        active = true;
        res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','X-Accel-Buffering':'no'});
        const write = data => { if (!res.destroyed) res.write(JSON.stringify(data)+'\n'); };
        try { await bridge.send({text:body.text,url:body.url,onUpdate:data=>write({type:'update',...data})}); write({type:'done'}); }
        catch (e) { write({type:'error',error:e.message}); }
        finally { active = false; res.end(); }
        return;
      }
      return json(404,{error:'Не найдено'});
    } catch { if (!res.headersSent) json(500,{error:'Ошибка сервера. Проверьте терминал на Mac.'}); else res.end(); }
  });
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let auth;
  try { auth = JSON.parse(await readFile('.local/auth.json','utf8')); }
  catch { console.error('Сначала выполните npm run setup'); process.exit(1); }
  const bridge = new ClaudeBridge();
  await bridge.open();
  const server = createApp({auth,bridge,secure:process.env.COOKIE_SECURE === '1'});
  server.listen(Number(process.env.PORT || 3000),'127.0.0.1',()=>console.log('ClaudeRU запущен на порту '+(process.env.PORT || 3000)+'. Для внешнего доступа используйте HTTPS-туннель.'));
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,async()=>{ server.close(); await bridge.close(); process.exit(0); });
}
