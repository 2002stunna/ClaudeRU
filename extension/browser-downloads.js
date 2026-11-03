// Import only downloads started by an active ClaudeRU operation.
globalThis.ClaudeRUDownloads=class {
  constructor({api,onFile,isActive}){
    this.api=api;this.onFile=onFile;this.isActive=isActive;this.captures=new Map();
    api.onDeterminingFilename.addListener((item,suggest)=>{
      const capture=[...this.captures.values()].find(c=>c.state==='waiting'&&this.matches(c,item));
      if(!capture){suggest();return;}
      capture.downloadId=item.id;capture.state='downloading';
      suggest({filename:'ClaudeRU/'+capture.own.id+'/'+this.safeName(item.filename||capture.name),conflictAction:'uniquify'});
    });
    api.onChanged.addListener(delta=>void this.changed(delta));
  }
  safeName(name){return String(name||'file').normalize('NFC').split(/[\\/]/).at(-1).replace(/[\x00-\x1f<>:"|?*]/g,'_').replace(/^\.+/,'').slice(0,180)||'file';}
  matches(c,item){
    if(!this.isActive(c.own)||item.startTime&&Date.parse(item.startTime)<c.started-1000)return false;
    try{const referrer=new URL(item.referrer),page=new URL(c.pageURL);if(referrer.origin===page.origin&&referrer.pathname.startsWith('/chat/'))return referrer.pathname===page.pathname;}catch{}
    if(this.safeName(item.filename).toLowerCase()!==c.name.toLowerCase())return false;
    return [item.referrer,item.url].some(value=>{try{return ['https://claude.ai','https://www.claudeusercontent.com'].includes(new URL(value).origin);}catch{return false;}});
  }
  async begin(own,nonce,name,pageURL){
    if(!/^[a-f0-9]{32}$/.test(nonce)||!/^[a-f0-9]{32}$/.test(own.id))throw Error('Некорректный идентификатор загрузки');
    const deadline=Date.now()+30000;
    while([...this.captures.values()].some(c=>c.state==='waiting')){if(Date.now()>deadline||!this.isActive(own))throw Error('Другая загрузка ещё подготавливается');await new Promise(r=>setTimeout(r,50));}
    if(!this.isActive(own))throw Error('Запрос уже завершён');
    this.captures.set(nonce,{own,nonce,name:this.safeName(name),pageURL,state:'waiting',started:Date.now()});return {ok:true};
  }
  async changed(delta){
    const c=[...this.captures.values()].find(c=>c.downloadId===delta.id);if(!c||c.state!=='downloading')return;
    if(delta.error?.current||delta.state?.current==='interrupted'){c.state='error';c.error='Загрузка прервана: '+(delta.error?.current||'interrupted');return;}
    if(delta.state?.current!=='complete')return;c.state='saving';
    try{
      const [item]=await this.api.search({id:delta.id});if(!item||item.state!=='complete'||item.exists===false)throw Error('Скачанный файл не найден');
      if(item.fileSize>20*1024*1024)throw Error('Файл больше 20 МБ');
      if(!this.isActive(c.own))throw Error('Запрос уже завершён');
      c.file=await this.onFile(c.own,{path:item.filename,name:this.safeName(item.filename),type:item.mime||'application/octet-stream',size:item.fileSize});c.state='done';
    }catch(e){c.state='error';c.error=e.message;}
  }
  state(own,nonce){const c=this.captures.get(nonce);if(!c||c.own!==own)return {ok:false,error:'Загрузка не найдена'};return {ok:true,state:c.state,file:c.file,error:c.error};}
  cancel(own,nonce){const c=this.captures.get(nonce);if(c?.own===own)this.captures.delete(nonce);}
  clear(own){for(const [nonce,c]of this.captures)if(c.own===own)this.captures.delete(nonce);}
};
