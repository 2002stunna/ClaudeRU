import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes, scryptSync } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
await mkdir('.local', { recursive: true, mode: 0o700 });
const rl = createInterface({ input: stdin, output: stdout });
console.log('Создайте отдельный пароль для своего сайта. Он не связан с паролем Claude.\nВнимание: ввод пароля виден в терминале.');
const password = await rl.question('Пароль (минимум 12 символов): '); rl.close();
if (password.length < 12) throw new Error('Нужно минимум 12 символов');
const salt = randomBytes(16).toString('hex');
const config = { salt, hash: scryptSync(password, salt, 64).toString('hex') };
try { await writeFile('.local/auth.json', JSON.stringify(config), { mode: 0o600, flag: 'wx' }); }
catch (e) { if (e.code === 'EEXIST') throw new Error('Пароль уже настроен. Для смены остановите сервер и удалите .local/auth.json.'); throw e; }
console.log('Пароль сохранён в виде хеша. Далее: npm run login');
