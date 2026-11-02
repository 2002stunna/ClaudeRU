import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
test('background carries full job and file events between selected tab and authenticated local server',async()=>{
  const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
  let handler,config={token:'a'.repeat(64),tabId:7},pollCount=0,releasePoll;
  const outgoing=[],navigation=[],jobs=[];
  let completed;const completion=new Promise(r=>completed=r);
  const job={id:'test-job',kind:'chat',text:'hello',url:'https://claude.ai/chat/selected-123',settings:{model:'Sonnet 5.5',effort:'high'},files:[{name:'input.txt',data:'aGk='}]};
  const respond=data=>({ok:true,status:200,json:async()=>data});
  const fetch=async(url,options)=>{
    assert.equal(options.headers.Authorization,'Bearer '+'a'.repeat(64));
    if(url.endsWith('/poll')){if(pollCount++===0)return respond(job);return new Promise(r=>releasePoll=()=>r(respond({idle:true})));}
    const event=JSON.parse(options.body);outgoing.push(event);
    if(event.type==='done'){config={};releasePoll?.();completed();}return respond({ok:true});
  };
  const chrome={
    storage:{local:{get:async()=>config,set:async()=>{},setAccessLevel:async()=>{}}},
    tabs:{get:async()=>({url:job.url,status:'complete'}),update:async(...args)=>navigation.push(args),sendMessage:async(tabId,message)=>{
      assert.equal(tabId,7);if(message.type==='ready')return {ready:true,version:4};jobs.push(message);
      await new Promise(resolve=>handler({type:'file',id:job.id,file:{name:'output.txt',data:'aGk='}},{tab:{id:7}},ack=>{assert.equal(ack.ok,true);resolve();}));
      return {done:true,result:{url:job.url,title:'Done'}};
    }},
    alarms:{create(){},onAlarm:{addListener(){}}},runtime:{id:'test-extension',getManifest:()=>({version:'0.4.1'}),onMessage:{addListener:fn=>handler=fn},onStartup:{addListener(){}},getURL:p=>'chrome-extension://test/'+p}
  };
  vm.runInNewContext(source,{chrome,fetch,URL,AbortSignal,setTimeout:fn=>setImmediate(fn)});
  await completion;
  assert.equal(navigation.length,0);assert.equal(jobs.length,1);assert.equal(jobs[0].settings.effort,'high');assert.equal(jobs[0].files[0].name,'input.txt');
  assert.equal(outgoing[0].type,'file');assert.equal(outgoing[0].file.name,'output.txt');assert.equal(outgoing[1].type,'done');assert.equal(outgoing[1].result.title,'Done');
});
test('background checks stale page readiness before requesting or running a job',async()=>{
  const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
  let config={token:'a'.repeat(64),tabId:7},completed;const done=new Promise(r=>completed=r),messages=[];
  const chrome={storage:{local:{get:async()=>config,set:async data=>{assert.match(data.lastStatus,/Обновите вкладку/);config={};completed();},setAccessLevel:async()=>{}}},tabs:{get:async()=>({url:'https://claude.ai/new'}),sendMessage:async(id,message)=>{messages.push(message.type);return{ready:true};}},alarms:{create(){},onAlarm:{addListener(){}}},runtime:{id:'test-extension',getManifest:()=>({version:'0.4.1'}),onMessage:{addListener(){}},onStartup:{addListener(){}}}};
  const fetch=async(url,options)=>{assert.ok(url.endsWith('/poll'));assert.equal(options.headers['X-ClaudeRU-Protocol'],'4');assert.notEqual(options.headers['X-ClaudeRU-Page-Protocol'],'4');return{ok:false,status:426,json:async()=>({error:'Обновите вкладку Claude'})};};
  vm.runInNewContext(source,{chrome,fetch,URL,AbortSignal,setTimeout:fn=>setImmediate(fn)});await done;assert.deepEqual(messages,['ready']);
});
