import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../extension/content.js',import.meta.url),'utf8');
function page(draft=''){
  let listener, sent=false, inserted='';const updates=[];
  const input={innerText:draft,focus(){}};
  const send={disabled:false,getAttribute:name=>name==='aria-label'?'Send message':null,click(){sent=true;}};
  const document={readyState:'complete',querySelector:()=>input,querySelectorAll:selector=>selector==='button'?[send]:sent?[{innerText:'Ответ Claude'}]:[],execCommand:(name,_,text)=>{inserted=text;return true;}};
  vm.runInNewContext(source,{document,location:{pathname:'/chat/test-123',origin:'https://claude.ai'},setTimeout:callback=>setImmediate(callback),chrome:{runtime:{id:'extension',onMessage:{addListener:fn=>listener=fn},sendMessage:async event=>updates.push(event)}}});
  return {run:message=>new Promise(resolve=>listener(message,{id:'extension'},resolve)),updates,get inserted(){return inserted;},get sent(){return sent;}};
}
test('content script inserts and sends once, forwards answer and finishes',async()=>{
  const p=page();const result=await p.run({type:'run',id:'job',text:'Привет'});
  assert.equal(result.done,true);assert.equal(p.sent,true);assert.equal(p.inserted,'Привет');
  assert.equal(p.updates.length,1);assert.equal(p.updates[0].text,'Ответ Claude');assert.equal(p.updates[0].url,'https://claude.ai/chat/test-123');
});
test('content script preserves a personal unsent draft',async()=>{
  const p=page('Мой черновик');const result=await p.run({type:'run',id:'job',text:'Привет'});
  assert.match(result.error,/черновик/);assert.equal(p.sent,false);assert.equal(p.inserted,'');assert.equal(p.updates.length,0);
});
