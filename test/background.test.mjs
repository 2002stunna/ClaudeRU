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
      assert.equal(tabId,7);if(message.type==='ready')return {ready:true,version:5};jobs.push(message);
      await new Promise(resolve=>handler({type:'file',id:job.id,file:{name:'output.txt',data:'aGk='}},{tab:{id:7}},ack=>{assert.equal(ack.ok,true);resolve();}));
      return {done:true,result:{url:job.url,title:'Done'}};
    }},
    alarms:{create(){},onAlarm:{addListener(){}}},runtime:{id:'test-extension',getManifest:()=>({version:'0.4.3'}),onMessage:{addListener:fn=>handler=fn},onStartup:{addListener(){}},getURL:p=>'chrome-extension://test/'+p}
  };
  vm.runInNewContext(source,{chrome,fetch,URL,AbortSignal,setTimeout:fn=>setImmediate(fn)});
  await completion;
  assert.equal(navigation.length,0);assert.equal(jobs.length,1);assert.equal(jobs[0].settings.effort,'high');assert.equal(jobs[0].files[0].name,'input.txt');
  assert.equal(outgoing[0].type,'file');assert.equal(outgoing[0].file.name,'output.txt');assert.equal(outgoing[1].type,'done');assert.equal(outgoing[1].result.title,'Done');
});
test('background checks stale page readiness before requesting or running a job',async()=>{
  const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
  let config={token:'a'.repeat(64),tabId:7},completed;const done=new Promise(r=>completed=r),messages=[];
  const chrome={storage:{local:{get:async()=>config,set:async data=>{assert.match(data.lastStatus,/Обновите вкладку/);config={};completed();},setAccessLevel:async()=>{}}},tabs:{get:async()=>({url:'https://claude.ai/new'}),sendMessage:async(id,message)=>{messages.push(message.type);return{ready:true};}},alarms:{create(){},onAlarm:{addListener(){}}},runtime:{id:'test-extension',getManifest:()=>({version:'0.4.3'}),onMessage:{addListener(){}},onStartup:{addListener(){}}}};
  const fetch=async(url,options)=>{assert.ok(url.endsWith('/poll'));assert.equal(options.headers['X-ClaudeRU-Protocol'],'5');assert.notEqual(options.headers['X-ClaudeRU-Page-Protocol'],'5');return{ok:false,status:426,json:async()=>({error:'Обновите вкладку Claude'})};};
  vm.runInNewContext(source,{chrome,fetch,URL,AbortSignal,setTimeout:fn=>setImmediate(fn)});await done;assert.deepEqual(messages,['ready']);
});
test('existing new-chat pages are reused and navigation happens only when changing conversations',async()=>{
  const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
  for(const scenario of [
    {kind:'chat',url:null,current:'https://claude.ai/new',navigate:false},
    {kind:'options',url:null,current:'https://claude.ai/',navigate:false},
    {kind:'options',url:null,current:'https://claude.ai/new?from=sidebar',navigate:false},
    {kind:'inspect',url:null,current:'https://claude.ai/chat/first',navigate:false},
    {kind:'chat',url:'https://claude.ai/chat/first',current:'https://claude.ai/chat/first',navigate:false},
    {kind:'chat',url:null,current:'https://claude.ai/chat/first',navigate:true},
    {kind:'open',url:'https://claude.ai/chat/second',current:'https://claude.ai/chat/first',navigate:true}
  ]){
    let config={token:'a'.repeat(64),tabId:7},pollCount=0,releasePoll,completed,current=scenario.current;
    const done=new Promise(r=>completed=r),navigation=[],runs=[];
    const job={id:'test-job',kind:scenario.kind,text:'hello',url:scenario.url};
    const respond=data=>({ok:true,status:200,json:async()=>data});
    const fetch=async(url,options)=>{if(url.endsWith('/poll')){if(pollCount++===0)return respond(job);return new Promise(r=>releasePoll=()=>r(respond({idle:true})));}const event=JSON.parse(options.body);assert.equal(event.type,'done',event.error);config={};releasePoll?.();completed();return respond({ok:true});};
    const chrome={storage:{local:{get:async()=>config,set:async()=>{},setAccessLevel:async()=>{}}},tabs:{get:async()=>({url:current,status:'complete'}),update:async(id,{url})=>{navigation.push(url);current=url;},sendMessage:async(id,message)=>{if(message.type==='ready')return{ready:true,version:5};runs.push(message);return{done:true};}},alarms:{create(){},onAlarm:{addListener(){}}},runtime:{id:'test-extension',getManifest:()=>({version:'0.4.3'}),onMessage:{addListener(){}},onStartup:{addListener(){}}}};
    vm.runInNewContext(source,{chrome,fetch,URL,AbortSignal,setTimeout:fn=>setImmediate(fn)});await done;
    assert.equal(navigation.length,scenario.navigate?1:0,JSON.stringify(scenario));assert.equal(runs.length,1);
  }
});
test('extension rejection before submission preserves the notSent flag through background transport',async()=>{
  const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');let config={token:'a'.repeat(64),tabId:7},pollCount=0,release,complete;
  const done=new Promise(r=>complete=r),events=[];const reply=data=>({ok:true,status:200,json:async()=>data});
  const fetch=async(url,options)=>{if(url.endsWith('/poll')){if(!pollCount++)return reply({id:'job',kind:'chat',url:'https://claude.ai/chat/test',text:'file'});return new Promise(r=>release=()=>r(reply({idle:true})));}events.push(JSON.parse(options.body));config={};release?.();complete();return reply({ok:true});};
  const chrome={storage:{local:{get:async()=>config,set:async()=>{},setAccessLevel:async()=>{}}},tabs:{get:async()=>({url:'https://claude.ai/chat/test',status:'complete'}),sendMessage:async(id,message)=>message.type==='ready'?{ready:true,version:5}:{error:'Не удалось обработать файл',notSent:true}},alarms:{create(){},onAlarm:{addListener(){}}},runtime:{id:'test-extension',getManifest:()=>({version:'0.4.3'}),onMessage:{addListener(){}},onStartup:{addListener(){}}}};
  vm.runInNewContext(source,{chrome,fetch,URL,AbortSignal,setTimeout:fn=>setImmediate(fn)});await done;assert.equal(events[0].type,'error');assert.equal(events[0].notSent,true);
});
