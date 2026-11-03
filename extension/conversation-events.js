// Observe completed native UI requests. No API calls, bodies or cookies are read.
globalThis.ClaudeRUConversationEvents=class {
  constructor({api,storage,report}){
    this.storage=storage;this.report=report;this.pending=new Map();this.confirmed=new Map();this.flushing=false;this.queue=Promise.resolve();
    this.ready=storage.get(['pendingDeletedChats']).then(value=>{for(const record of value.pendingDeletedChats||[])if(this.valid(record)){this.pending.set(record.url,record);this.confirmed.set(record.url,Date.now());}});
    api.onCompleted.addListener(details=>void this.observe(details),{urls:['https://claude.ai/*']});
  }
  valid(record){return record&&['deleted','missing'].includes(record.kind)&&/^https:\/\/claude\.ai\/chat\/[a-zA-Z0-9-]+$/.test(record.url);}
  evidence(details){
    let url;try{url=new URL(details.url);}catch{return null;}if(url.origin!=='https://claude.ai')return null;
    const detail=/^\/api\/(?:[^/]+\/)*(?:chat_conversations|conversations)\/([a-zA-Z0-9-]+)\/?$/.exec(url.pathname);
    const deletion=/^\/api\/(?:[^/]+\/)*(?:chat_conversations|conversations)\/([a-zA-Z0-9-]+)\/delete\/?$/.exec(url.pathname);
    if(details.statusCode>=200&&details.statusCode<300&&((details.method==='DELETE'&&detail)||(details.method==='POST'&&deletion)))return {url:'https://claude.ai/chat/'+(detail||deletion)[1],kind:'deleted'};
    if(details.method==='GET'&&details.statusCode===404){if(detail)return {url:'https://claude.ai/chat/'+detail[1],kind:'missing'};if(details.type==='main_frame'&&/^\/chat\/[a-zA-Z0-9-]+$/.test(url.pathname))return {url:url.origin+url.pathname,kind:'missing'};}
    return null;
  }
  observe(details){
    const record=this.evidence(details);if(!record)return Promise.resolve();
    this.confirmed.set(record.url,Date.now());if(this.confirmed.size>500)this.confirmed.delete(this.confirmed.keys().next().value);
    this.queue=this.queue.catch(()=>{}).then(async()=>{await this.ready;this.pending.set(record.url,record);await this.persist();});
    return this.queue.then(()=>this.flush()).catch(()=>{});
  }
  persist(){return this.storage.set({pendingDeletedChats:[...this.pending.values()]});}
  async waitForDeletion(url,started){
    await this.ready;
    const end=Date.now()+10000;
    while(Date.now()<end){if((this.confirmed.get(url)||0)>=started)return;await new Promise(r=>setTimeout(r,50));}
    throw Error('Claude не подтвердил успешное удаление. Обновите список чатов; повторное удаление не запускалось.');
  }
  async flush(){
    await this.ready;await this.queue;if(this.flushing||!this.pending.size)return;this.flushing=true;
    try{
      const records=[...this.pending.values()].slice(0,100);await this.report(records);
      for(const record of records)if(this.pending.get(record.url)===record)this.pending.delete(record.url);
      await this.persist();
    }catch{/* Keep observations until the local server is connected again. */}
    finally{this.flushing=false;}
  }
};
