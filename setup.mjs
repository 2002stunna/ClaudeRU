import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { randomBytes, scryptSync } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
const args=process.argv.slice(2),replace=args.includes('--replace');
if(args.some(arg=>arg!=='--replace'))throw Error('Неизвестный параметр настройки');
await mkdir('.local', { recursive: true, mode: 0o700 });
const rl = createInterface({ input: stdin, output: stdout });
console.log('Задайте PIN или пароль своего сайта. Он не связан с паролем Claude.\nВвод виден в терминале.');
const password = await rl.question('PIN из 4 цифр или пароль от 12 символов: '); rl.close();
const pin=/^[0-9]{4}$/.test(password);
if (!pin&&(password.length<12||password.length>1024)) throw Error('Введите ровно 4 цифры для PIN или пароль от 12 до 1024 символов');
const salt = randomBytes(16).toString('hex');
const config = { kind:pin?'pin':'password', salt, hash: scryptSync(password, salt, 64).toString('hex') };
if(replace){
  const temporary='.local/auth.'+randomBytes(8).toString('hex')+'.tmp';
  try{await writeFile(temporary,JSON.stringify(config),{mode:0o600,flag:'wx'});await rename(temporary,'.local/auth.json');}
  finally{await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}else{
  try { await writeFile('.local/auth.json', JSON.stringify(config), { mode: 0o600, flag: 'wx' }); }
  catch (e) { if (e.code === 'EEXIST') throw Error('Пароль уже настроен. Для смены остановите сервер и выполните npm run password.'); throw e; }
}
console.log((pin?'PIN':'Пароль')+' сохранён в виде хеша. '+(replace?'Перезапустите сервер.':'Теперь можно запустить npm start.'));
