export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const routeId = url.searchParams.get("route") || "seattle-bainbridge";

    // 1-min edge cache bucket
    const bucket = Math.floor(Date.now() / 60000);
    const cache = caches.default;
    const cacheKey = new Request(`https://cache/wsf/${routeId}/${bucket}`);
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    // Map your app's keys -> WSF route IDs (expand later)
    const MAP = {
      "seattle-bainbridge": { wsfId: "7" },   // example ID
      // "seattle-bremerton": { wsfId: "3" },
      // "edmonds-kingston":  { wsfId: "13" },
    };

    const m = MAP[routeId];
    if (!m) return respond({ ok:false, source:"fallback", error:"unknown route" });

    try {
      // Requires WSDOT key later; for now it’ll gracefully fall back
      const key = env.WSDOT_KEY; // add this in Cloudflare > Settings > Variables
      const wsfUrl = `https://www.wsdot.wa.gov/Ferries/API/Schedule/rest/scheduletoday/${m.wsfId}/true?apiaccesscode=${key || "MISSING"}`;
      const r = await fetch(wsfUrl, { headers: { "accept": "application/json" } });
      if (!r.ok) throw new Error("wsf bad status: "+r.status);

      const json = await r.json();
      const sailings = (json?.[0]?.Sailings || []).map(s => ({
        dep: s?.DepartingTime || null,
        arr: s?.ArrivingTime || null,
        notes: s?.Notes || "",
        cancel: !!s?.IsCancelled
      })).filter(x => x.dep);

      return respond({ ok:true, source:"WSF", route:routeId, sailings }, cache, cacheKey);
    } catch (e) {
      // Clean failure -> your page will use built-in schedules
      return respond({ ok:false, source:"fallback", error:"live feed unavailable", sailings:[] }, cache, cacheKey, 30);
    }
  }
};

function respond(obj, cache, cacheKey, ttl=60) {
  const resp = new Response(JSON.stringify(obj), {
    headers: { "content-type":"application/json", "cache-control":`public, max-age=${ttl}` }
  });
  if (cache && cacheKey) cache.put(cacheKey, resp.clone());
  return resp;
}
