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
      assert.equal(tabId,7);if(message.type==='ready')return {ready:true,version:9};jobs.push(message);
      await new Promise(resolve=>handler({type:'file',id:job.id,file:{name:'output.txt',data:'aGk='}},{tab:{id:7}},ack=>{assert.equal(ack.ok,true);resolve();}));
      return {done:true,result:{url:job.url,title:'Done'}};
    }},
    alarms:{create(){},onAlarm:{addListener(){}}},runtime:{id:'test-extension',getManifest:()=>({version:'0.5.3'}),onMessage:{addListener:fn=>handler=fn},onStartup:{addListener(){}},getURL:p=>'chrome-extension://test/'+p}
  };
  vm.runInNewContext(source,{chrome,fetch,URL,AbortSignal,setTimeout:fn=>setImmediate(fn)});
  await completion;
  assert.equal(navigation.length,0);assert.equal(jobs.length,1);assert.equal(jobs[0].settings.effort,'high');assert.equal(jobs[0].files[0].name,'input.txt');
  assert.equal(outgoing[0].type,'file');assert.equal(outgoing[0].file.name,'output.txt');assert.equal(outgoing[1].type,'done');assert.equal(outgoing[1].result.title,'Done');
});
test('background checks stale page readiness before requesting or running a job',async()=>{
  const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
  let config={token:'a'.repeat(64),tabId:7},completed;const done=new Promise(r=>completed=r),messages=[];
  const chrome={storage:{local:{get:async()=>config,set:async data=>{assert.match(data.lastStatus,/Обновите вкладку/);config={};completed();},setAccessLevel:async()=>{}}},tabs:{get:async()=>({url:'https://claude.ai/new'}),sendMessage:async(id,message)=>{messages.push(message.type);return{ready:true};}},alarms:{create(){},onAlarm:{addListener(){}}},runtime:{id:'test-extension',getManifest:()=>({version:'0.5.3'}),onMessage:{addListener(){}},onStartup:{addListener(){}}}};
  const fetch=async(url,options)=>{assert.ok(url.endsWith('/poll'));assert.equal(options.headers['X-ClaudeRU-Protocol'],'9');assert.notEqual(options.headers['X-ClaudeRU-Page-Protocol'],'9');return{ok:false,status:426,json:async()=>({error:'Обновите вкладку Claude'})};};
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
    const chrome={storage:{local:{get:async()=>config,set:async()=>{},setAccessLevel:async()=>{}}},tabs:{get:async()=>({url:current,status:'complete'}),update:async(id,{url})=>{navigation.push(url);current=url;},sendMessage:async(id,message)=>{if(message.type==='ready')return{ready:true,version:9};runs.push(message);return{done:true};}},alarms:{create(){},onAlarm:{addListener(){}}},runtime:{id:'test-extension',getManifest:()=>({version:'0.5.3'}),onMessage:{addListener(){}},onStartup:{addListener(){}}}};
    vm.runInNewContext(source,{chrome,fetch,URL,AbortSignal,setTimeout:fn=>setImmediate(fn)});await done;
    assert.equal(navigation.length,scenario.navigate?1:0,JSON.stringify(scenario));assert.equal(runs.length,1);
  }
});
test('extension rejection before submission preserves the notSent flag through background transport',async()=>{
  const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');let config={token:'a'.repeat(64),tabId:7},pollCount=0,release,complete;
  const done=new Promise(r=>complete=r),events=[];const reply=data=>({ok:true,status:200,json:async()=>data});
  const fetch=async(url,options)=>{if(url.endsWith('/poll')){if(!pollCount++)return reply({id:'job',kind:'chat',url:'https://claude.ai/chat/test',text:'file'});return new Promise(r=>release=()=>r(reply({idle:true})));}events.push(JSON.parse(options.body));config={};release?.();complete();return reply({ok:true});};
  const chrome={storage:{local:{get:async()=>config,set:async()=>{},setAccessLevel:async()=>{}}},tabs:{get:async()=>({url:'https://claude.ai/chat/test',status:'complete'}),sendMessage:async(id,message)=>message.type==='ready'?{ready:true,version:9}:{error:'Не удалось обработать файл',notSent:true}},alarms:{create(){},onAlarm:{addListener(){}}},runtime:{id:'test-extension',getManifest:()=>({version:'0.5.3'}),onMessage:{addListener(){}},onStartup:{addListener(){}}}};
  vm.runInNewContext(source,{chrome,fetch,URL,AbortSignal,setTimeout:fn=>setImmediate(fn)});await done;assert.equal(events[0].type,'error');assert.equal(events[0].notSent,true);
});

test('a second chat uses a separate native tab while the first is generating',async()=>{
  const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
  let config={token:'a'.repeat(64),tabId:7},handler,polls=0,releasePoll,finishFirst,complete;
  const done=new Promise(r=>complete=r),firstWaiting=new Promise(r=>finishFirst=r),events=[],created=[],runs=[];
  const tabs=new Map([[7,{id:7,url:'https://claude.ai/chat/first',status:'complete'}]]);
  const jobs=[{id:'a',chatId:'first',kind:'chat',url:'https://claude.ai/chat/first'},{id:'b',chatId:'second',kind:'options',url:null,settings:{model:'Sonnet 5.5'}}];
  const reply=data=>({ok:true,status:200,json:async()=>data});
  const fetch=async(url,options)=>{
    if(url.endsWith('/poll')){if(polls<2)return reply(jobs[polls++]);return new Promise(r=>releasePoll=()=>r(reply({idle:true})));}
    const event=JSON.parse(options.body);events.push(event);
    if(event.id==='b'&&event.type==='done')finishFirst();
    if(event.id==='a'&&event.type==='done'){config={};releasePoll?.();complete();}return reply({ok:true});
  };
  const chrome={storage:{local:{get:async()=>config,set:async()=>{},setAccessLevel:async()=>{}}},tabs:{get:async id=>tabs.get(id),create:async options=>{created.push(options);const tab={id:8,url:options.url,status:'complete'};tabs.set(8,tab);return tab;},update:async()=>assert.fail('the running conversation must not be navigated'),sendMessage:async(id,message)=>{
    if(message.type==='ready')return{ready:true,version:9};runs.push([id,message.id]);
    if(message.id==='a')await firstWaiting;
    // A spoofed update from the other tab must not be forwarded.
    assert.equal(handler({id:message.id,type:'update',text:'wrong'},{tab:{id:id===7?8:7}},()=>assert.fail()),undefined);
    await new Promise(r=>handler({id:message.id,type:'update',text:message.id},{tab:{id}},ack=>{assert.equal(ack.ok,true);r();}));return {done:true,result:{title:message.id}};
  }},alarms:{create(){},onAlarm:{addListener(){}}},runtime:{id:'test-extension',getManifest:()=>({version:'0.5.3'}),onMessage:{addListener:fn=>handler=fn},onStartup:{addListener(){}}}};
  vm.runInNewContext(source,{chrome,fetch,URL,AbortSignal,setTimeout:fn=>setImmediate(fn)});await done;
  assert.equal(created.length,1);assert.equal(created[0].active,false);assert.deepEqual(runs,[[7,'a'],[8,'b']]);assert.deepEqual(events.filter(e=>e.type==='update').map(e=>e.text),['b','a']);
});

test('a newly created tab with no URL or about:blank waits for Claude before dispatch',async()=>{
  const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
  for(const initialURL of [undefined,'','about:blank'])for(const initialStatus of ['loading','complete']){
    let config={token:'a'.repeat(64),tabId:7},poll=0,unblock,finish,releasePoll,reads=0;
    const firstWaiting=new Promise(r=>unblock=r),done=new Promise(r=>finish=r),events=[],runs=[];
    const jobs=[{id:'first',chatId:'a',kind:'chat',url:'https://claude.ai/chat/a'},{id:'delete',chatId:'b',kind:'manage',action:'delete',url:'https://claude.ai/chat/b'}];
    const reply=data=>({ok:true,status:200,json:async()=>data});
    const fetch=async(url,options)=>{
      if(url.endsWith('/poll'))return poll<jobs.length?reply(jobs[poll++]):new Promise(r=>releasePoll=()=>r(reply({idle:true})));
      const event=JSON.parse(options.body);events.push(event);if(event.id==='delete')unblock();if(event.id==='first'){config={};releasePoll?.();finish();}return reply({ok:true});
    };
    const chrome={storage:{local:{get:async()=>config,set:async()=>{},setAccessLevel:async()=>{}}},tabs:{
      get:async id=>id===7?{url:jobs[0].url,status:'complete'}:++reads<3?{id:8,url:initialURL,pendingUrl:jobs[1].url,status:initialStatus}:{id:8,url:jobs[1].url,status:'complete'},
      create:async()=>({id:8,url:initialURL,status:initialStatus}),update:async()=>assert.fail('a new tab already loading the target must not be navigated again'),
      sendMessage:async(id,message)=>{if(id===8)assert.ok(reads>=3,'commands must wait for the committed Claude URL');if(message.type==='ready')return {ready:true,version:9};runs.push(message.id);if(message.id==='first')await firstWaiting;return{done:true,result:{applied:true}};}
    },alarms:{create(){},onAlarm:{addListener(){}}},runtime:{id:'test-extension',getManifest:()=>({version:'0.5.3'}),onMessage:{addListener(){}},onStartup:{addListener(){}}}};
    vm.runInNewContext(source,{chrome,fetch,URL,AbortSignal,setTimeout:fn=>setImmediate(fn)});await done;
    assert.equal(events.some(e=>e.type==='error'),false,JSON.stringify(events));assert.deepEqual(runs,['first','delete']);assert.ok(reads>=3);
  }
});

test('opening and deleting another chat reuse an idle tab instead of creating more tabs',async()=>{
  const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');
  let config={token:'a'.repeat(64),tabId:7},poll=0,finish,waitingPoll,current='https://claude.ai/new',allowNext;
  const done=new Promise(r=>finish=r),events=[],navigation=[],runs=[];
  const jobs=[{id:'inspect',chatId:'sync',kind:'inspect'},{id:'open',chatId:'a',kind:'open',url:'https://claude.ai/chat/a'},{id:'delete',chatId:'b',kind:'manage',action:'delete',url:'https://claude.ai/chat/b'}];
  const reply=data=>({ok:true,status:200,json:async()=>data});let previous=Promise.resolve();
  const fetch=async(url,options)=>{
    if(url.endsWith('/poll')){await previous;if(poll<jobs.length){const job=jobs[poll++];previous=new Promise(r=>allowNext=r);return reply(job);}return new Promise(r=>waitingPoll=()=>r(reply({idle:true})));}
    const event=JSON.parse(options.body);events.push(event);if(event.id==='delete'){config={};waitingPoll?.();finish();}allowNext?.();return reply({ok:true});
  };
  const chrome={storage:{local:{get:async()=>config,set:async()=>{},setAccessLevel:async()=>{}}},tabs:{get:async()=>({url:current,status:'complete'}),create:async()=>{throw Error('Unexpected extra tab');},update:async(id,{url})=>{assert.equal(id,7);navigation.push(url);current=url;},sendMessage:async(id,message)=>{assert.equal(id,7);if(message.type==='ready')return{ready:true,version:9};runs.push(message.id);return{done:true,result:{applied:true}};}},alarms:{create(){},onAlarm:{addListener(){}}},runtime:{id:'test-extension',getManifest:()=>({version:'0.5.3'}),onMessage:{addListener(){}},onStartup:{addListener(){}}}};
  vm.runInNewContext(source,{chrome,fetch,URL,AbortSignal,setTimeout:fn=>setImmediate(fn)});await done;
  assert.equal(events.some(e=>e.type==='error'),false,JSON.stringify(events));assert.deepEqual(runs,['inspect','open','delete']);assert.deepEqual(navigation,[jobs[1].url,jobs[2].url]);
});

test('short waits use the worker clock and accept only the active job and its own tab',async()=>{
  const source=await readFile(new URL('../extension/background.js',import.meta.url),'utf8');let handler,config={token:'a'.repeat(64),tabId:7},polls=0,releasePoll,finish;
  const done=new Promise(r=>finish=r),events=[];const reply=data=>({ok:true,status:200,json:async()=>data});
  const fetch=async(url,options)=>{if(url.endsWith('/poll'))return !polls++?reply({id:'job',chatId:'a',kind:'chat',url:'https://claude.ai/chat/a'}):new Promise(r=>releasePoll=()=>r(reply({idle:true})));events.push(JSON.parse(options.body));config={};releasePoll?.();finish();return reply({ok:true});};
  const chrome={storage:{local:{get:async()=>config,set:async()=>{},setAccessLevel:async()=>{}}},tabs:{get:async()=>({url:'https://claude.ai/chat/a',status:'complete'}),sendMessage:async(id,message)=>{
    if(message.type==='ready')return{ready:true,version:9};
    for(const invalid of [{id:'stale',ms:20,tabId:7},{id:'job',ms:20,tabId:8},{id:'job',ms:-1,tabId:7},{id:'job',ms:1001,tabId:7},{id:'job',ms:'20',tabId:7}]){
      let result;const keep=handler({type:'wait',id:invalid.id,ms:invalid.ms},{tab:{id:invalid.tabId}},ack=>result=ack);assert.equal(keep,undefined);assert.equal(result.ok,false);
    }
    const start=performance.now();await new Promise(resolve=>{assert.equal(handler({type:'wait',id:'job',ms:30},{tab:{id:7}},ack=>{assert.equal(ack.ok,true);resolve();}),true);});
    assert.ok(performance.now()-start>=20,'the worker must honor the requested pause');assert.ok(performance.now()-start<1000,'the wait must not use a background page timer');return{done:true};
  }},alarms:{create(){},onAlarm:{addListener(){}}},runtime:{id:'test-extension',getManifest:()=>({version:'0.5.3'}),onMessage:{addListener:fn=>handler=fn},onStartup:{addListener(){}}}};
  vm.runInNewContext(source,{chrome,fetch,URL,AbortSignal,setTimeout});await done;assert.deepEqual(events.map(e=>e.type),['done'],'clock messages must stay inside the extension');
});
