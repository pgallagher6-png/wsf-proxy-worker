// WSF proxy (CORS + edge cache + known IDs + fallback scan + direction support)
// Secret required in Cloudflare: WSDOT_KEY

const CORS = {
  "content-type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const key = env.WSDOT_KEY;
    if (!key) return json({ ok:false, error:"missing WSDOT_KEY", sailings:[] });

    const ROUTES = {
      "seattle-bainbridge": { dep: "Seattle",             arr: "Bainbridge Island", ids: [5] },
      "seattle-bremerton":  { dep: "Seattle",             arr: "Bremerton",         ids: [3,2,6] },
      "edmonds-kingston":   { dep: "Edmonds",             arr: "Kingston",          ids: [13,12] },
      "mukilteo-clinton":   { dep: "Mukilteo",            arr: "Clinton",           ids: [7] },
      "fauntleroy-vashon":  { dep: "Fauntleroy",          arr: "Vashon Island",     ids: [1,4] },
      "fauntleroy-southworth": { dep: "Fauntleroy",       arr: "Southworth",        ids: [1,4] },
      "port-townsend-coupeville": { dep: "Port Townsend", arr: "Coupeville",        ids: [9,10,11] },
      "anacortes-friday-harbor": { dep: "Anacortes",      arr: "Friday Harbor",     ids: [14,15] },
    };

    const u = new URL(request.url);
    const routeKey = (u.searchParams.get("route") || "seattle-bainbridge").toLowerCase();
    const fromParam = (u.searchParams.get("from") || "").toLowerCase();
    const debug = u.searchParams.get("debug") === "1";
    const route = ROUTES[routeKey] || ROUTES["seattle-bainbridge"];

    // pick direction; default from = route.dep, or honor ?from=
    let from = route.dep;
    if (fromParam && [route.dep.toLowerCase(), route.arr.toLowerCase()].includes(fromParam)) {
      from = (fromParam === route.arr.toLowerCase()) ? route.arr : route.dep;
    }

    // Pacific date for dated endpoint
    const nowPST = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
    const d = new Date(nowPST);
    const yyyy = d.getFullYear(), mm = String(d.getMonth()+1).padStart(2,"0"), dd = String(d.getDate()).padStart(2,"0");
    const dateStr = `${yyyy}-${mm}-${dd}`;

    // 60s edge cache per route+from
    const cache = caches.default;
    const bucket = Math.floor(Date.now()/60000);
    const cacheKey = new Request(`wsf:${routeKey}:${from}:${bucket}`);
    const cached = await cache.match(cacheKey);
    if (cached) return new Response(await cached.text(), { headers: CORS });

    // Try known IDs first (today→dated), then small scan 1..30
    let used = null, sailings = [];
    const knownIds = Array.isArray(route.ids) ? route.ids : [];
    for (const id of knownIds) {
      sailings = await tryOneId(id, key, route, from, dateStr, 6000);
      if (sailings.length) { used = { type:"known", id }; break; }
    }
    if (!sailings.length) {
      const ids = Array.from({length:30},(_,i)=>i+1), batch=6;
      for (let i=0;i<ids.length && !sailings.length;i+=batch){
        const results = await Promise.all(ids.slice(i,i+batch).map(async id => ({ id, s: await tryOneId(id, key, route, from, dateStr, 6000) })));
        const hit = results.find(r=>r.s.length); if (hit){ used={type:"scan", id:hit.id}; sailings=hit.s; }
      }
    }

    const payload = debug
      ? { ok:true, route: routeKey, from, count: sailings.length, _debug:{ used, dateStr, knownIds }, sailings }
      : { ok:true, source:"WSF", route: routeKey, from, sailings, _debug:{ count: sailings.length } };

    const resp = new Response(JSON.stringify(payload), { headers: CORS });
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  }
};

// ---- helpers ----
async function tryOneId(id, key, route, from, dateStr, timeoutMs){
  const t1 = await tryUrl(todayUrl(id, key), route, from, timeoutMs);
  if (t1.length) return t1;
  return await tryUrl(datedUrl(id, key, dateStr), route, from, timeoutMs);
}
async function tryUrl(url, route, from, timeoutMs){
  try{
    const text = await withTimeout(getText(url), timeoutMs);
    const obj = safeJson(text);
    const combos = findTerminalCombos(obj);
    if (!combos.length) return [];
    const depWanted = norm(from);
    const arrWanted = norm(from===route.dep ? route.arr : route.dep);
    const hit = combos.find(c => norm(c.DepartingTerminalName).includes(depWanted) && norm(c.ArrivingTerminalName).includes(arrWanted));
    if (!hit || !Array.isArray(hit.Times)) return [];
    const times = hit.Times.map(x=>({
      dep: toIsoFromWsDotDate(x.DepartingTime),
      arr: toIsoFromWsDotDate(x.ArrivingTime),
      vessel: x.VesselName || null,
      notes: "",
      cancel: false
    })).filter(s=>s.dep);
    return times.sort((a,b)=>a.dep>b.dep?1:-1);
  }catch{ return []; }
}
function todayUrl(id,key){ return `http://www.wsdot.wa.gov/Ferries/API/Schedule/rest/scheduletoday/${id}/true?apiaccesscode=${key}&format=json`; }
function datedUrl(id,key,dateStr){ return `http://www.wsdot.wa.gov/Ferries/API/Schedule/rest/schedule/${dateStr}/${id}?showCancelledSailings=true&apiaccesscode=${key}&format=json`; }
async function getText(url){ const r=await fetch(url,{headers:{accept:"application/json"}}); if(!r.ok) throw new Error(`status ${r.status}`); return r.text(); }
function safeJson(t){ try{ return JSON.parse(t); }catch{ return null; } }
function findTerminalCombos(obj){
  if(!obj) return [];
  if(Array.isArray(obj)){ for(const o of obj){ const c=findTerminalCombos(o); if(c.length) return c; } return []; }
  if(obj.TerminalCombos && Array.isArray(obj.TerminalCombos)) return obj.TerminalCombos;
  const nests=[obj.Results,obj.Data,obj.Payload,obj.Schedule,obj.ScheduleData];
  for(const n of nests){ const c=findTerminalCombos(n); if(c.length) return c; }
  return [];
}
function toIsoFromWsDotDate(str){ if(!str||typeof str!=="string") return null; const m=str.match(/\/Date\((\d+)([+-]\d{4})?\)\//); if(!m) return null; return new Date(Number(m[1])).toISOString(); }
function norm(s){ return String(s||"").toLowerCase(); }
function json(obj,status=200){ return new Response(JSON.stringify(obj),{status,headers:CORS}); }
function withTimeout(promise,ms){ return new Promise((res,rej)=>{ const t=setTimeout(()=>rej(new Error("timeout")),ms); promise.then(v=>{clearTimeout(t);res(v);},e=>{clearTimeout(t);rej(e);});}); }
