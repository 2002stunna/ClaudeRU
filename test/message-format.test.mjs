import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeFormat} from '../public/message-format.js';

test('semantic documents retain structure while dropping HTML, executable URLs and excessive nesting',()=>{
  const value=normalizeFormat({version:1,children:[{tag:'h2',children:['Title'],style:'display:none',onclick:'bad()'},{tag:'ol',start:3,children:[{tag:'li',children:[{tag:'strong',children:['bold']}]}]},{tag:'script',children:['bad()']},{tag:'a',href:'javascript:bad()',children:['link']},{tag:'a',href:'https://example.com',children:['safe']} ]});
  assert.deepEqual(value.children[0],{tag:'h2',children:['Title']});assert.equal(value.children[1].start,3);assert.equal(value.children.length,4);assert.equal(value.children[2].href,undefined);assert.equal(value.children[3].href,'https://example.com/');
  let nested='text';for(let i=0;i<45;i++)nested={tag:'strong',children:[nested]};assert.equal(normalizeFormat({version:1,children:[nested]}),null);
  assert.equal(normalizeFormat({version:1,children:['x'.repeat(500001)]}),null);
});
