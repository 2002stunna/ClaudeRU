// A small semantic document, never HTML from the remote page.
const mathTags=new Set('math mrow mi mn mo mtext mfrac msqrt mroot msub msup msubsup munder mover munderover mtable mtr mtd mspace menclose mpadded mstyle semantics'.split(' '));
const tags=new Set([...('p br strong em s u h1 h2 h3 h4 h5 h6 ul ol li blockquote pre code hr table thead tbody tfoot tr th td sup sub a dl dt dd'.split(' ')),...mathTags]);
export function normalizeFormat(value){
  if(value?.version!==1||!Array.isArray(value.children))return null;
  let count=0,size=0;
  function read(node,depth=0){
    if(++count>20000||depth>40)throw Error('format limit');
    if(typeof node==='string'){size+=node.length;if(size>500000)throw Error('format limit');return node;}
    if(!node||!tags.has(node.tag)||!Array.isArray(node.children))return null;
    const out={tag:node.tag,children:node.children.map(n=>read(n,depth+1)).filter(n=>n!==null)};
    if(node.tag==='a'&&typeof node.href==='string'){try{const url=new URL(node.href);if(['https:','http:','mailto:'].includes(url.protocol)&&!url.username&&!url.password)out.href=url.href;}catch{}}
    if(node.tag==='ol'&&Number.isInteger(node.start)&&node.start>=0&&node.start<=100000)out.start=node.start;
    if(node.tag==='li'&&Number.isInteger(node.value)&&Math.abs(node.value)<=100000)out.value=node.value;
    if(['td','th'].includes(node.tag))for(const key of ['colSpan','rowSpan'])if(Number.isInteger(node[key])&&node[key]>0&&node[key]<=100)out[key]=node[key];
    if(node.tag==='code'&&typeof node.language==='string'&&/^[\w+-]{1,40}$/.test(node.language))out.language=node.language;
    if(node.tag==='math')out.display=node.display==='block'?'block':'inline';
    if(mathTags.has(node.tag)&&typeof node.variant==='string'&&/^[a-z-]{1,30}$/.test(node.variant))out.variant=node.variant;
    return out;
  }
  try{const children=value.children.map(n=>read(n)).filter(n=>n!==null);return children.length?{version:1,...(['sans','serif','mono'].includes(value.font)?{font:value.font}:{}),children}:null;}catch{return null;}
}
export function renderFormat(container,value){
  const format=normalizeFormat(value);if(!format)return false;
  const doc=container.ownerDocument;
  function render(node){
    if(typeof node==='string')return doc.createTextNode(node);
    const el=mathTags.has(node.tag)?doc.createElementNS('http://www.w3.org/1998/Math/MathML',node.tag):doc.createElement(node.tag);
    if(node.href){el.href=node.href;el.target='_blank';el.rel='noopener noreferrer';}
    for(const key of ['start','value','colSpan','rowSpan'])if(node[key]!==undefined)el[key]=node[key];
    if(node.language)el.dataset.language=node.language;
    if(node.display)el.setAttribute('display',node.display);if(node.variant)el.setAttribute('mathvariant',node.variant);
    el.append(...node.children.map(render));
    if(node.tag==='table'){const scroll=doc.createElement('div');scroll.className='table-scroll';scroll.append(el);return scroll;}
    return el;
  }
  container.classList.add('formatted');if(format.font)container.dataset.typography=format.font;container.append(...format.children.map(render));return true;
}
