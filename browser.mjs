import { chromium } from 'playwright';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function browserSettings(choice, platform = process.platform) {
  if (choice === 'chromium') return { profile: '.local/browser', options: { headless: false } };
  if (choice !== 'yandex') throw new Error('Неизвестный браузер: выберите chromium или yandex');
  if (platform !== 'darwin') throw new Error('Этот способ запуска Яндекс Браузера предназначен для macOS');
  return {
    profile: '.local/browser-yandex',
    options: { headless: false, executablePath: '/Applications/Yandex.app/Contents/MacOS/Yandex' }
  };
}
async function checkExecutable(settings) {
  if (!settings.options.executablePath) return;
  try { await access(settings.options.executablePath, constants.X_OK); }
  catch { throw new Error('Яндекс Браузер не найден. Установите его в папку «Программы» (/Applications/Yandex.app).'); }
}
export async function launchBrowser() {
  let choice = 'chromium';
  try { choice = JSON.parse(await readFile('.local/browser-choice.json', 'utf8')).browser; }
  catch (e) { if (e.code !== 'ENOENT') throw new Error('Не удалось прочитать выбор браузера. Повторите npm run browser:yandex.'); }
  const settings = browserSettings(choice);
  await checkExecutable(settings);
  await mkdir(settings.profile, { recursive: true, mode: 0o700 });
  return chromium.launchPersistentContext(settings.profile, settings.options);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const choice = process.argv[2];
  const settings = browserSettings(choice);
  await checkExecutable(settings);
  await mkdir('.local', { recursive: true, mode: 0o700 });
  await writeFile('.local/browser-choice.json', JSON.stringify({ browser: choice }), { mode: 0o600 });
  console.log(`Выбран браузер: ${choice}. Теперь выполните npm run login. Сервер будет использовать тот же браузер.`);
}
