const CONNECTORS = [
  { id:'rezlive',name:'RezLive',urlEnv:'REZLIVE_API_URL',keyEnv:'REZLIVE_API_KEY' },
  { id:'b2b-bookings',name:'B2B Bookings',urlEnv:'B2B_BOOKINGS_API_URL',keyEnv:'B2B_BOOKINGS_API_KEY' },
  { id:'nowworld',name:'NowWorld',urlEnv:'NOWWORLD_API_URL',keyEnv:'NOWWORLD_API_KEY' },
  { id:'saltours',name:'SALTOUR',urlEnv:'SALTOURS_API_URL',keyEnv:'SALTOURS_API_KEY' },
  { id:'arabian-oryx',name:'Arabian Oryx',urlEnv:'ARABIAN_ORYX_API_URL',keyEnv:'ARABIAN_ORYX_API_KEY' },
  { id:'leamigo',name:'LeAmigo',urlEnv:'LEAMIGO_API_URL',keyEnv:'LEAMIGO_API_KEY' },
  { id:'locanda',name:'Locanda',urlEnv:'LOCANDA_API_URL',keyEnv:'LOCANDA_API_KEY' },
  { id:'babylon-holidays',name:'Babylon Holidays',urlEnv:'BABYLON_HOLIDAYS_API_URL',keyEnv:'BABYLON_HOLIDAYS_API_KEY' },
  { id:'peaceland-holidays',name:'Peaceland Holidays',urlEnv:'PEACELAND_HOLIDAYS_API_URL',keyEnv:'PEACELAND_HOLIDAYS_API_KEY' },
  { id:'holiday-begin',name:'Holiday Begin',urlEnv:'HOLIDAY_BEGIN_API_URL',keyEnv:'HOLIDAY_BEGIN_API_KEY' },
  { id:'ratehawk',name:'RateHawk',urlEnv:'RATEHAWK_API_URL',keyEnv:'RATEHAWK_API_KEY' },
  { id:'wanderbeds',name:'WanderBeds',urlEnv:'WANDERBEDS_API_URL',keyEnv:'WANDERBEDS_API_KEY' },
  { id:'mawasim',name:'Mawasim',urlEnv:'MAWASIM_API_URL',keyEnv:'MAWASIM_API_KEY' },
  { id:'webbeds',name:'WebBeds',urlEnv:'WEBBEDS_API_URL',keyEnv:'WEBBEDS_API_KEY' },
  { id:'tripovo',name:'Tripovo',urlEnv:'TRIPOVO_API_URL',keyEnv:'TRIPOVO_API_KEY' },
  { id:'expedia-taap',name:'Expedia TAAP',urlEnv:'EXPEDIA_TAAP_API_URL',keyEnv:'EXPEDIA_TAAP_API_KEY' },
  { id:'gatetours',name:'GateTours',urlEnv:'GATETOURS_API_URL',keyEnv:'GATETOURS_API_KEY' },
  { id:'rateloc',name:'RateLoc',urlEnv:'RATELOC_API_URL',keyEnv:'RATELOC_API_KEY' },
  { id:'anjum-hotel-makkah',name:'Anjum Hotel Makkah',urlEnv:'ANJUM_API_URL',keyEnv:'ANJUM_API_KEY' }
];

function configuredConnectors(){return CONNECTORS.map(c=>({id:c.id,name:c.name,configured:Boolean(process.env[c.urlEnv]),status:process.env[c.urlEnv]?'ready':'awaiting_api'}));}
function normalize(raw,connector,search){const items=Array.isArray(raw)?raw:(raw?.hotels||raw?.results||raw?.data||raw?.offers||[]);if(!Array.isArray(items))return[];return items.map((h,i)=>({id:String(h.id??h.hotelId??h.code??`${connector.id}-${i}`),supplier:connector.name,hotel:h.hotel??h.hotelName??h.name??'Hotel',room:h.room??h.roomName??h.roomType??h.room_type??'',board:h.board??h.boardName??h.boardType??h.board_type??search.board,price:Number(h.price??h.totalPrice??h.total_price??h.amount??NaN),currency:h.currency??h.currencyCode??h.currency_code??'',cancellation:h.cancellation??h.cancellationPolicy??h.cancelPolicy??'',image:h.image??h.imageUrl??h.photo??'',raw:h}));}
async function callGeneric(connector,search){const url=process.env[connector.urlEnv];if(!url)return{configured:false,results:[],error:null};const key=process.env[connector.keyEnv]||'';const headers={'Content-Type':'application/json',Accept:'application/json'};if(key)headers.Authorization=`Bearer ${key}`;const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),15000);try{const response=await fetch(url,{method:'POST',headers,signal:controller.signal,body:JSON.stringify(search)});const text=await response.text();let data;try{data=JSON.parse(text);}catch{throw new Error(`Invalid JSON response (${response.status})`);}if(!response.ok)throw new Error(`Supplier returned HTTP ${response.status}`);return{configured:true,results:normalize(data,connector,search),error:null};}catch(e){return{configured:true,results:[],error:e.name==='AbortError'?'Supplier timed out':e.message};}finally{clearTimeout(timer);}}
async function searchAll(search){const settled=await Promise.all(CONNECTORS.map(c=>callGeneric(c,search)));const results=[],statuses=[];settled.forEach((r,i)=>{const c=CONNECTORS[i];statuses.push({id:c.id,name:c.name,configured:r.configured,ok:!r.error,error:r.error,status:r.configured?(r.error?'error':'live'):'awaiting_api'});results.push(...r.results);});return{results,statuses};}
module.exports={CONNECTORS,configuredConnectors,searchAll};
