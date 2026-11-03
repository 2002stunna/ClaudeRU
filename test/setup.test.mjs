import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,readdir,stat,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {scryptSync} from 'node:crypto';
import {createApp} from '../server.mjs';

async function workspace(t){const root=await mkdtemp(join(tmpdir(),'clauderu-auth-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function setup(root,password,args=[]){
  const child=spawn(process.execPath,[fileURLToPath(new URL('../setup.mjs',import.meta.url)),...args],{cwd:root,stdio:['pipe','pipe','pipe']});let output='';
  child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);child.stdin.end(password+'\n');
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});return {code,output};
}
async function serverFor(t,auth){
  const server=createApp({auth,bridge:{status:{connected:false}},secure:true});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  const base='http://127.0.0.1:'+server.address().port,origin=base.replace('http:','https:');return {base,login:password=>fetch(base+'/api/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({password})})};
}

test('four-digit PIN setup preserves leading zeroes, stores a salted hash and authenticates over the HTTPS configuration',async t=>{
  const root=await workspace(t);assert.equal((await setup(root,'0427')).code,0);const auth=JSON.parse(await readFile(join(root,'.local/auth.json'),'utf8'));
  assert.equal(auth.kind,'pin');assert.deepEqual(Object.keys(auth).sort(),['hash','kind','salt']);assert.equal(auth.hash,scryptSync('0427',auth.salt,64).toString('hex'));assert.equal((await stat(join(root,'.local/auth.json'))).mode&0o777,0o600);
  const {base,login}=await serverFor(t,auth),session=await(await fetch(base+'/api/session')).json();assert.deepEqual(session,{authenticated:false,loginMode:'pin'});
  assert.equal((await login('427')).status,401);assert.equal((await login('0428')).status,401);const accepted=await login('0427');assert.equal(accepted.status,200);assert.match(accepted.headers.get('set-cookie'),/; Secure/);
});

test('password reset validates before replacing credentials and preserves conversations and files',async t=>{
  const root=await workspace(t);assert.equal((await setup(root,'original-password')).code,0);const path=join(root,'.local/auth.json'),original=await readFile(path,'utf8');await writeFile(join(root,'.local/chats.json'),'saved history');await mkdir(join(root,'.local/files'));await writeFile(join(root,'.local/files/document.txt'),'saved document');
  assert.notEqual((await setup(root,'0427')).code,0);assert.equal(await readFile(path,'utf8'),original);
  assert.notEqual((await setup(root,'abc',['--replace'])).code,0);assert.equal(await readFile(path,'utf8'),original);
  assert.equal((await setup(root,'0427',['--replace'])).code,0);let auth=JSON.parse(await readFile(path,'utf8'));assert.equal(auth.kind,'pin');assert.notEqual(auth.salt,JSON.parse(original).salt);assert.equal(await readFile(join(root,'.local/chats.json'),'utf8'),'saved history');
  assert.deepEqual((await readdir(join(root,'.local'))).sort(),['auth.json','chats.json','files']);assert.equal(await readFile(join(root,'.local/files/document.txt'),'utf8'),'saved document');assert.equal((await stat(path)).mode&0o777,0o600);
  assert.equal((await setup(root,'new-long-password',['--replace'])).code,0);auth=JSON.parse(await readFile(path,'utf8'));assert.equal(auth.kind,'password');assert.equal(auth.hash,scryptSync('new-long-password',auth.salt,64).toString('hex'));
});

test('setup accepts exactly four ASCII digits or a long password, without creating invalid credentials',async t=>{
  const root=await workspace(t);for(const invalid of ['','123','12345','abcd','１２３４'])assert.notEqual((await setup(root,invalid)).code,0);
  await assert.rejects(readFile(join(root,'.local/auth.json')),{code:'ENOENT'});
});

let executable=process.env.CHROMIUM_EXECUTABLE||'/usr/bin/chromium';try{await access(executable);}catch{executable=null;}
test('mobile login offers a numeric PIN field and accepts the configured four digits',{skip:!executable},async t=>{
  const root=await workspace(t);assert.equal((await setup(root,'0427')).code,0);const auth=JSON.parse(await readFile(join(root,'.local/auth.json'),'utf8'));
  // This UI check uses local HTTP so the browser can retain the session cookie.
  const server=createApp({auth,bridge:{status:{connected:false}}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
  const {chromium}=await import('playwright'),browser=await chromium.launch({executablePath:executable,headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:390,height:844}});await page.goto('http://127.0.0.1:'+server.address().port);
  await page.getByText('PIN-код вашего сайта',{exact:true}).waitFor();const input=page.locator('#password');assert.equal(await input.getAttribute('inputmode'),'numeric');assert.equal(await input.getAttribute('maxlength'),'4');assert.equal(await input.getAttribute('type'),'password');
  await input.fill('042');assert.equal(await input.evaluate(n=>n.checkValidity()),false);await input.fill('0427');await page.locator('#login-form button').click();await page.locator('#app').waitFor({state:'visible'});
});
