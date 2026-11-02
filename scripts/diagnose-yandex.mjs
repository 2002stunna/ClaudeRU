import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// Chromium reference: extensions/browser/disable_reason.h.
// Yandex may add its own codes, so preserve numbers and leave unknowns unknown.
const knownReasons = new Map([
  [1, 'отключено действием пользователя'],
  [2, 'нужно подтвердить новые разрешения'],
  [4, 'перезагрузка расширения'],
  [8, 'неподдерживаемые требования'],
  [16, 'отключена сторонняя установка'],
  [256, 'не удалось проверить установку'],
  [512, 'ограничение проверки безопасности'],
  [1024, 'повреждение расширения'],
  [2048, 'удалённая установка'],
  [8192, 'сторонняя установка требует подтверждения'],
  [16384, 'политика требует обновления'],
  [32768, 'нужно разрешение родительского контроля'],
  [65536, 'заблокировано политикой управления'],
  [524288, 'требуется переустановка'],
  [1048576, 'расширение не в списке разрешённых'],
  [4194304, 'политика требует публикации в магазине'],
  [8388608, 'неподдерживаемая версия manifest'],
  [16777216, 'локальное расширение отключено при выключенном режиме разработчика'],
  [33554432, 'неизвестная причина'],
  [67108864, 'блокировка облачной политикой'],
  [134217728, 'отключено другим расширением'],
]);
export function decodeReasons(raw) {
  // Old Chromium uses a bitmask; newer versions use a set of integer flags.
  let codes;
  if (Number.isSafeInteger(raw) && raw >= 0 && raw <= 0x7fffffff) {
    codes = Array.from({length:31},(_,i)=>2**i).filter(bit=>(raw & bit)!==0);
  } else if (Array.isArray(raw)) {
    codes = [...new Set(raw.filter(v=>Number.isSafeInteger(v)&&v>0&&v<=0x7fffffff))];
  } else return null;
  return codes.map(code=>({code,description:knownReasons.get(code)||'неизвестный код; не делаем вывод о причине'}));
}
export function summarizePreferences(data, manifests = new Map()) {
  const developerMode = data?.extensions?.ui?.developer_mode;
  const settings = data?.extensions?.settings;
  if (!settings || typeof settings !== 'object') return [];
  const result=[];
  for (const [id, entry] of Object.entries(settings)) {
    if(!/^[a-p]{32}$/.test(id) || !entry || typeof entry!=='object') continue;
    const manifest = entry.manifest || manifests.get(id);
    if(manifest?.name !== 'ClaudeRU — домашний мост') continue;
    // Explicit whitelist: never include paths, session data or arbitrary prefs.
    result.push({
      id,
      identification: entry.manifest ? 'настройки браузера' : 'manifest.json установленной папки',
      version: typeof manifest?.version==='string' && /^\d+(\.\d+){0,3}$/.test(manifest.version) ? manifest.version : null,
      state: Number.isInteger(entry.state) ? entry.state : null,
      location: Number.isInteger(entry.location) ? entry.location : null,
      developerMode: typeof developerMode==='boolean' ? developerMode : null,
      reasons: decodeReasons(entry.disable_reasons),
    });
  }
  return result;
}
// Unpacked extensions deliberately have no cached manifest in Chromium prefs.
// Read only manifest.json at the registered extension path; never print that path
// or return the full manifest. Nothing here executes extension code.
export async function installedManifests(data, profileDirectory) {
  const manifests = new Map();
  let unreadable = 0;
  const settings = data?.extensions?.settings;
  if (!settings || typeof settings !== 'object') return { manifests, unreadable };
  for (const [id, entry] of Object.entries(settings)) {
    if (!/^[a-p]{32}$/.test(id) || !entry || typeof entry !== 'object' || entry.manifest) continue;
    if (typeof entry.path !== 'string' || !entry.path || entry.path.length > 4096 || entry.path.includes('\0')) continue;
    const directory = isAbsolute(entry.path) ? entry.path : resolve(profileDirectory, 'Extensions', entry.path);
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
      if (manifest && typeof manifest === 'object') manifests.set(id, manifest);
    } catch { unreadable++; }
  }
  return { manifests, unreadable };
}
export async function diagnose(root) {
  let directories;
  const counters = { profiles: 0, files: 0, registrations: 0, unreadableManifests: 0 };
  try { directories=await readdir(root,{withFileTypes:true}); }
  catch(e){if(e.code==='ENOENT')return {foundRoot:false,records:[],errors:[],counters};throw e;}
  const records=[],errors=[];
  for(const directory of directories){
    if(!directory.isDirectory() || !/^(Default|Profile \d+)$/.test(directory.name))continue;
    counters.profiles++;
    const profileDirectory = join(root,directory.name);
    for(const filename of ['Preferences','Secure Preferences']){
      try {
        const data=JSON.parse(await readFile(join(profileDirectory,filename),'utf8'));
        counters.files++;
        const settings = data?.extensions?.settings;
        if(settings && typeof settings === 'object') counters.registrations += Object.keys(settings).filter(id=>/^[a-p]{32}$/.test(id)).length;
        const { manifests, unreadable } = await installedManifests(data,profileDirectory);
        counters.unreadableManifests += unreadable;
        for(const summary of summarizePreferences(data,manifests))records.push({profile:directory.name,file:filename,...summary});
      }catch(e){if(e.code!=='ENOENT')errors.push({profile:directory.name,file:filename,error:e.code==='EACCES'?'нет доступа':'не удалось прочитать настройки'});}
    }
  }
  return {foundRoot:true,records,errors,counters};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  if(process.platform!=='darwin'){console.error('Эту команду нужно запустить на домашнем Mac, где установлен Яндекс.');process.exitCode=1;}
  else {
    try {
      const root=join(homedir(),'Library','Application Support','Yandex','YandexBrowser');
      const report=await diagnose(root);
      console.log('Диагностика ClaudeRU (только чтение). Пароли, cookies, история и код подключения не выводятся.');
      console.log(`Диагностика v2. Профилей: ${report.counters.profiles}; файлов настроек: ${report.counters.files}; записей расширений: ${report.counters.registrations}.`);
      if(!report.foundRoot)console.log('Стандартная папка профилей Яндекса не найдена. Настройки не проверены.');
      else if(!report.records.length)console.log('ClaudeRU не найден в сохранённых настройках стандартных профилей. Причина отключения не определена.');
      for(const r of report.records){
        console.log(`\nПрофиль: ${r.profile}; файл: ${r.file}`);
        console.log(`Название определено через: ${r.identification}`);
        console.log(`Версия: ${r.version ?? 'не указана'}; ID: ${r.id}`);
        console.log(`state: ${r.state ?? 'не сохранён'}; location: ${r.location ?? 'не сохранён'}`);
        console.log(`Режим разработчика в этом файле: ${r.developerMode===null?'неизвестно':r.developerMode?'включён':'выключен'}`);
        if(r.reasons===null)console.log('Причины отключения: поле отсутствует или формат не распознан.');
        else if(!r.reasons.length)console.log('Список причин отключения пуст. Это не доказывает, что расширение работает.');
        else for(const reason of r.reasons)console.log(`Код ${reason.code}: ${reason.description} (трактовка Chromium).`);
      }
      if(report.counters.unreadableManifests)console.log(`Не удалось прочитать manifest.json у ${report.counters.unreadableManifests} записей без сохранённого названия. Распознавание может быть неполным.`);
      for(const e of report.errors)console.log(`${e.profile}, ${e.file}: ${e.error}`);
      console.log('\nНастройки на диске могут отставать от открытого браузера. Ничего не изменено.');
    }catch{console.error('Диагностика не завершена: не удалось прочитать папку настроек Яндекса.');process.exitCode=1;}
  }
}
