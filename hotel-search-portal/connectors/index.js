const { searchHadafSource, healthHadafSource } = require('./hadaf-browser-v6');
const { searchWanderBedsSource, healthWanderBedsSource } = require('./wanderbeds-browser-v1');
const { searchBrowserSource } = require('./browser');
const CONNECTORS=[
  {id:'hadaf',name:'Hadaf Holidays',type:'browser'},
  {id:'wanderbeds',name:'WanderBeds',type:'browser'},
  {id:'locanda',name:'Locanda',type:'browser'}
];
function configuredConnectors(){return CONNECTORS.map(c=>({id:c.id,name:c.name,type:c.type,configured:true,status:'database'}))}
function pick(sources,pattern){return sources.find(x=>x.enabled!==false&&pattern.test(String(x.name||''))&&(x.connector_type==='browser'||x.connector_type==='playwright'))}
async function runSource(s,search){const name=String(s.name||'');if(/hadaf/i.test(name))return searchHadafSource(s,search);if(/wanderbeds/i.test(name))return searchWanderBedsSource(s,search);return searchBrowserSource(s,search)}
async function searchAll(search,sources=[]){
  const selected=[pick(sources,/hadaf/i),pick(sources,/wanderbeds/i),pick(sources,/locanda/i)].filter(Boolean);
  const responses=await Promise.all(selected.map(async s=>{const r=await runSource(s,search);return{results:r.results||[],status:{id:String(s.id),name:s.name,configured:r.configured,ok:!r.error,error:r.error||null,status:r.configured?(r.error?'offline':'live'):'offline'}};}));
  const activeIds=new Set(selected.map(s=>String(s.id)));
  const statuses=CONNECTORS.filter(c=>activeIds.has(c.id)).map(c=>responses.find(r=>r.status.id===c.id)?.status).filter(Boolean);
  return{results:responses.flatMap(r=>r.results),statuses};
}
async function healthSources(sources=[]){
  const selected=[pick(sources,/hadaf/i),pick(sources,/wanderbeds/i),pick(sources,/locanda/i)].filter(Boolean);
  return Promise.all(selected.map(async s=>{
    const name=String(s.name||'');
    if(/locanda/i.test(name)&&!(s.site_username&&s.site_password_enc))return{id:String(s.id),name:s.name,configured:false,ok:false,status:'offline',error:'Locanda requires agent code, email and encrypted password',checkedAt:new Date().toISOString()};
    const r=await(/hadaf/i.test(name)?healthHadafSource(s):/wanderbeds/i.test(name)?healthWanderBedsSource(s):searchBrowserSource(s,{destination:'Madinah - Saudi Arabia',checkin:'2026-10-02',checkout:'2026-10-03',guests:2,rooms:1,board:'ROOM_ONLY'}));
    return{id:String(s.id),name:s.name,configured:r.configured,ok:!r.error,status:r.error?'offline':'live',error:r.error||null,checkedAt:new Date().toISOString()};
  }));
}
module.exports={CONNECTORS,configuredConnectors,searchAll,healthSources};
