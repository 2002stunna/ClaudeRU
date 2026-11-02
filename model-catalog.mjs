export const MODEL_NAMES=Object.freeze(['Fable 5.1','Opus 5.5','Sonnet 5.5','Haiku 5.5','Fable 5','Opus 5']);
export const EFFORT_VALUES=Object.freeze(['low','medium','high','xhigh','max']);
export function normalizeModelCache(value){
  const byModel={};
  if(value?.version!==1)return {version:1,byModel};
  for(const name of MODEL_NAMES){
    const entry=value.byModel?.[name];
    if(typeof entry?.available!=='boolean'||!Array.isArray(entry.efforts)||entry.efforts.length>5||!entry.efforts.every(e=>EFFORT_VALUES.includes(e)))continue;
    byModel[name]={available:entry.available,efforts:[...new Set(entry.efforts)]};
  }
  return {version:1,byModel};
}
export const isModelCacheComplete=value=>MODEL_NAMES.every(name=>Object.hasOwn(normalizeModelCache(value).byModel,name));
export function catalogFor(cache,current={},warning=''){
  const {byModel}=normalizeModelCache(cache);
  return {models:[...MODEL_NAMES],byModel,efforts:byModel[current.model]?.efforts||[],current,...(warning?{warning}:{})};
}
