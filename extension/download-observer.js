// MAIN world: observe only an explicitly requested native file download.
// No fetch/XHR interception, API discovery, account data or credential access.
(() => {
  const channel='clauderu-native-download-v1',limit=20*1024*1024;
  let pending=null;
  const emit=value=>window.postMessage({channel,...value},location.origin);
  window.addEventListener('message',event=>{
    const message=event.data;
    if(event.source!==window||event.origin!==location.origin||message?.channel!==channel||!/^\w{32}$/.test(message.nonce||''))return;
    if(message.type==='arm'){
      pending={nonce:message.nonce,name:String(message.name||'').slice(0,255),expires:Date.now()+10000,used:false};
      emit({type:'armed',nonce:pending.nonce});
    }else if(message.type==='cancel'&&pending?.nonce===message.nonce)pending=null;
  });
  function capture(anchor){
    const own=pending;if(!own||own.used||Date.now()>own.expires||!anchor.hasAttribute('download'))return false;
    let url;try{url=new URL(anchor.href,location.href);}catch{return false;}
    // Blob URLs are the result of Claude's own download handler. All ordinary
    // links and all downloads outside this short capture keep browser behavior.
    if(url.protocol!=='blob:'||url.origin!==location.origin)return false;
    const filename=anchor.download||own.name;
    if(!/\.pdf$/i.test(filename))return false;
    own.used=true;
    // Start reading before the native handler can revoke the object URL.
    const response=fetch(url.href);
    void (async()=>{
      try{
        const result=await response;if(!result.ok)throw Error('HTTP '+result.status);
        const reader=result.body.getReader(),chunks=[];let size=0;
        while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw Error('Файл больше 20 МБ');}chunks.push(value);}
        const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
        if(!new TextDecoder().decode(bytes.subarray(0,1024)).includes('%PDF-'))throw Error('Claude не предоставил PDF для скачивания');
        let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
        if(pending===own)emit({type:'file',nonce:own.nonce,file:{name:filename,type:'application/pdf',data:btoa(binary)}});
      }catch(error){if(pending===own)emit({type:'error',nonce:own.nonce,error:error.message});}
    })();
    return true;
  }
  const click=HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click=function(){if(!capture(this))return Reflect.apply(click,this,arguments);};
  document.addEventListener('click',event=>{const anchor=event.target.closest?.('a[download]');if(anchor&&capture(anchor)){event.preventDefault();event.stopImmediatePropagation();}},true);
})();
