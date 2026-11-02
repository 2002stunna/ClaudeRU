import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { conversationURL } from './bridge.mjs';

export const MAX_FILE = 20 * 1024 * 1024;
export const MAX_TOTAL = 25 * 1024 * 1024;
export const MAX_FILES = 5;
export function cleanName(value) {
  if (typeof value !== 'string' || !value.trim()) throw Error('У файла нет имени');
  return value.replace(/[\\/\x00-\x1f\x7f]/g,'_').slice(0,180);
}
export function decodeFile(file) {
  const name = cleanName(file?.name);
  if(typeof file.data !== 'string' || file.data.length > Math.ceil(MAX_FILE/3)*4 || (file.data.length%4!==0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data))) throw Error('Некорректный файл или превышен лимит 20 МБ');
  const bytes = Buffer.from(file.data,'base64');
  if(bytes.length > MAX_FILE) throw Error('Файл больше 20 МБ');
  const type = typeof file.type === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(file.type) ? file.type : 'application/octet-stream';
  return {name,type,size:bytes.length,bytes};
}
export function chatOptions(value = {}) {
  if(!value || typeof value !== 'object') throw Error('Некорректные настройки модели');
  const model=value.model || '';
  if(typeof model !== 'string' || model.length>100 || /[\x00-\x1f]/.test(model)) throw Error('Некорректная модель');
  const effort=value.effort || '';
  if(!['','low','medium','high','xhigh','max'].includes(effort)) throw Error('Некорректный уровень усилий');
  return {model,effort};
}
export class DataStore {
  constructor(root = null) { this.root=root;this.chats=[];this.files=new Map();this.queue=Promise.resolve();this.ready=this.load(); }
  async load() {
    if(!this.root)return;
    await mkdir(join(this.root,'files'),{recursive:true,mode:0o700});
    try { this.chats=JSON.parse(await readFile(join(this.root,'chats.json'),'utf8'));if(!Array.isArray(this.chats))throw Error('Некорректный файл истории'); }
    catch(e){if(e.code!=='ENOENT')throw e;}
  }
  async persist() {
    if(!this.root)return;
    const serialized=JSON.stringify(this.chats);
    const next=this.queue.then(async()=>{
      const tmp=join(this.root,'chats.json.tmp');
      await writeFile(tmp,serialized,{mode:0o600});await rename(tmp,join(this.root,'chats.json'));
    });
    this.queue=next.catch(()=>{});return next;
  }
  async list(){await this.ready;return this.chats.filter(c=>!c.deleted);}
  async get(id){await this.ready;const chat=this.chats.find(c=>c.id===id&&!c.deleted);if(!chat)throw Error('Чат не найден');return chat;}
  async create({title='Новый разговор',url=null,messages=[],settings={}}={}) {
    await this.ready;if(url)url=conversationURL(url);
    const existing=url && this.chats.find(c=>c.url===url);if(existing)return existing;
    const chat={id:randomUUID(),title:String(title).slice(0,160),url,messages,settings:chatOptions(settings),updatedAt:Date.now(),loaded:!url||messages.length>0};
    this.chats.unshift(chat);await this.persist();return chat;
  }
  async save(chat){chat.updatedAt=Date.now();await this.persist();return chat;}
  async importIndex(index){
    if(!Array.isArray(index))return;
    for(const item of index.slice(0,300).reverse()){
      if(!item || typeof item.title!=='string')continue;
      try{const chat=await this.create({title:item.title,url:conversationURL(item.url)});if(chat.deleted)continue;chat.title=item.title.slice(0,160);if(typeof item.pinned==='boolean')chat.pinned=item.pinned;await this.persist();}catch{}
    }
  }
  async putFile(file){
    await this.ready;const {bytes,...meta}=decodeFile(file);const id=randomBytes(16).toString('hex');const value={id,...meta};
    if(this.root){
      await writeFile(join(this.root,'files',id+'.bin'),bytes,{mode:0o600,flag:'wx'});
      await writeFile(join(this.root,'files',id+'.json'),JSON.stringify(value),{mode:0o600,flag:'wx'});
    }else this.files.set(id,{meta:value,bytes});
    return value;
  }
  async readFile(id){
    await this.ready;if(typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id))throw Error('Файл не найден');
    if(!this.root){const value=this.files.get(id);if(!value)throw Error('Файл не найден');return value;}
    const meta=JSON.parse(await readFile(join(this.root,'files',id+'.json'),'utf8'));
    const bytes=await readFile(join(this.root,'files',id+'.bin'));return {meta,bytes};
  }
  async wireFiles(ids=[]){
    if(!Array.isArray(ids)||ids.length>MAX_FILES)throw Error('Можно прикрепить до 5 файлов');
    const files=[];let total=0;
    for(const id of ids){const {meta,bytes}=await this.readFile(id);total+=bytes.length;if(total>MAX_TOTAL)throw Error('Общий размер файлов больше 25 МБ');files.push({...meta,data:bytes.toString('base64')});}
    return files;
  }
}
