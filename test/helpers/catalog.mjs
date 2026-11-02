import {MODEL_NAMES} from '../../model-catalog.mjs';
export function mockCatalog({models=MODEL_NAMES,efforts=[],current={},...rest}={}){
  return {...rest,models,efforts,current,byModel:Object.fromEntries(MODEL_NAMES.map(model=>[model,{available:models.includes(model),efforts:models.includes(model)?[...efforts]:[]}]))};
}
