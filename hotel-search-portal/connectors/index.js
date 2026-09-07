const { searchHadafSource, healthHadafSource } = require('./hadaf-browser-v6');
const { searchWanderBedsSource, healthWanderBedsSource } = require('./wanderbeds-browser-v1');
const CONNECTORS=[
  {id:'hadaf',name:'Hadaf Holidays',type:'browser'},
  {id:'wanderbeds',name:'WanderBeds',type:'browser'}
];
function configuredConnectors(){return CONNECTORS.map(c=>({id:c.id,name:c.name,type:c.type,configured:true,status:'database'}))}
function pick(sources,pattern){return sources.find(x=>x.enabled!==false&&pattern.test(String(x.name||''))&&(x.connector_type==='browser'||x.connector_type==='playwright'))}
async function searchAll(search,sources=[]){
  const selected=[pick(sources,/hadaf/i),pick(sources,/wanderbeds/i)].filter(Boolean);
  if(!selected.length)return{results:[],statuses:CONNECTORS.map(c=>({id:c.id,name:c.name,configured:false,ok:false,status:'offline',error:`${c.name} supplier is not configured`}))};
  const responses=await Promise.all(selected.map(async s=>{
    const isW=/wanderbeds/i.test(String(s.name||''));
    const r=await (isW?searchWanderBedsSource(s,search):searchHadafSource(s,search));
    return {results:r.results||[],status:{id:String(s.id),name:s.name,configured:r.configured,ok:!r.error,error:r.error||null,status:r.configured?(r.error?'offline':'live'):'offline'}};
  }));
  const activeIds=new Set(selected.map(s=>String(s.id)));
  const statuses=CONNECTORS.filter(c=>activeIds.has(c.id)).map(c=>responses.find(r=>r.status.id===c.id)?.status).filter(Boolean);
  return {results:responses.flatMap(r=>r.results),statuses};
}
async function healthSources(sources=[]){
  const selected=[pick(sources,/hadaf/i),pick(sources,/wanderbeds/i)].filter(Boolean);
  return Promise.all(selected.map(async s=>{
    const isW=/wanderbeds/i.test(String(s.name||''));
    const r=await (isW?healthWanderBedsSource(s):healthHadafSource(s));
    return {id:String(s.id),name:s.name,configured:r.configured,ok:r.live,status:r.live?'live':'offline',error:r.error||null,checkedAt:new Date().toISOString()};
  }));
}
module.exports={CONNECTORS,configuredConnectors,searchAll,healthSources};
