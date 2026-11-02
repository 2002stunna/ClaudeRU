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
