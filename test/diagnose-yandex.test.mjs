import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {decodeReasons,summarizePreferences,diagnose} from '../scripts/diagnose-yandex.mjs';
const id='a'.repeat(32);
function prefs(reasons){return {extensions:{ui:{developer_mode:false},settings:{[id]:{manifest:{name:'ClaudeRU — домашний мост',version:'0.2.0'},state:0,location:4,disable_reasons:reasons,path:'/private/should-not-print',token:'secret-token'},['b'.repeat(32)]:{manifest:{name:'Other extension'},token:'secret-other'}}},cookies:'secret-cookies',history:['private-site']};}
test('diagnosis interprets old bitmask and new array without guessing unknown codes',()=>{
  assert.deepEqual(decodeReasons(16777216+2),decodeReasons([2,16777216]));
  assert.match(decodeReasons([1073741824])[0].description,/неизвестный/);
  assert.deepEqual(decodeReasons(0),[]);assert.equal(decodeReasons('invalid'),null);
});
test('diagnosis only returns ClaudeRU install metadata and never arbitrary profile contents',()=>{
  const report=summarizePreferences(prefs([16777216]));
  assert.equal(report.length,1);assert.equal(report[0].developerMode,false);
  assert.equal(report[0].reasons[0].code,16777216);
  assert.doesNotMatch(JSON.stringify(report),/secret|private|Other extension/);
});
test('diagnosis reads profile files without changing them and handles missing roots',async t=>{
  const root=await mkdtemp(join(tmpdir(),'clauderu-diagnosis-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'Default'));
  const data=JSON.stringify(prefs(256));await writeFile(join(root,'Default','Preferences'),data);
  const report=await diagnose(root);
  assert.equal(report.records.length,1);assert.equal(report.records[0].profile,'Default');
  assert.equal(report.records[0].reasons[0].code,256);
  const {readFile}=await import('node:fs/promises');assert.equal(await readFile(join(root,'Default','Preferences'),'utf8'),data);
  assert.equal((await diagnose(join(root,'missing'))).foundRoot,false);
});

test('diagnosis finds an unpacked extension through its manifest when prefs omit the name',async t=>{
  const root=await mkdtemp(join(tmpdir(),'clauderu-unpacked-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const profile=join(root,'Default'),extension=join(root,'local extension');
  await mkdir(profile);await mkdir(extension);
  const data=prefs([16777216]);
  delete data.extensions.settings[id].manifest;
  data.extensions.settings[id].path=extension;
  const serialized=JSON.stringify(data);
  await writeFile(join(profile,'Preferences'),serialized);
  await writeFile(join(extension,'manifest.json'),JSON.stringify({name:'ClaudeRU — домашний мост',version:'0.2.0',private_field:'do-not-print'}));
  const report=await diagnose(root);
  assert.equal(report.records.length,1);
  assert.equal(report.records[0].version,'0.2.0');
  assert.equal(report.records[0].identification,'manifest.json установленной папки');
  assert.equal(report.records[0].reasons[0].code,16777216);
  assert.equal(report.counters.registrations,2);
  assert.doesNotMatch(JSON.stringify(report),/secret|private_field|do-not-print|local extension/);
  const {readFile}=await import('node:fs/promises');
  assert.equal(await readFile(join(profile,'Preferences'),'utf8'),serialized);
});
test('diagnosis resolves installed relative extension paths and reports unreadable manifests',async t=>{
  const root=await mkdtemp(join(tmpdir(),'clauderu-relative-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const profile=join(root,'Profile 1'),relative=join(id,'0.2.0_0');
  await mkdir(join(profile,'Extensions',relative),{recursive:true});
  const data=prefs([256]);delete data.extensions.settings[id].manifest;
  data.extensions.settings[id].path=relative;
  delete data.extensions.settings['b'.repeat(32)].manifest;
  data.extensions.settings['b'.repeat(32)].path=join('missing','0.2.0');
  await writeFile(join(profile,'Secure Preferences'),JSON.stringify(data));
  await writeFile(join(profile,'Extensions',relative,'manifest.json'),JSON.stringify({name:'ClaudeRU — домашний мост',version:'0.2.0'}));
  const report=await diagnose(root);
  assert.equal(report.records.length,1);assert.equal(report.records[0].profile,'Profile 1');
  assert.equal(report.records[0].reasons[0].code,256);
  assert.equal(report.counters.unreadableManifests,1);
});
