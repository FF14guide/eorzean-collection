/**
 * エオルゼア蒐集録 — Worker エントリ（静的アセット付きWorker用）
 * ------------------------------------------------------------------
 * Pages の functions/ 方式ではなく、"Worker + Static Assets" 構成のためのエントリ。
 *   /api/lodestone?id=..&type=..&lang=..  → ロードストーン直読み（下の handleLodestone）
 *   それ以外                              → 静的アセット（index.html 等）を配信
 * ------------------------------------------------------------------
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/lodestone") {
      return handleLodestone(request, ctx);
    }
    // 静的サイトを配信（index.html など）
    return env.ASSETS.fetch(request);
  },
};

const REGION = { ja: "jp", en: "na", de: "de", fr: "fr" };
const UA = "Mozilla/5.0 (compatible; EorzeaCollectionLedger/1.0; +https://collection.eorzeanfishing.com)";
const MAX_FETCHES = 45;
const TTL = { character: 900, mounts: 1800, minions: 1800, achievements: 21600 };

async function handleLodestone(request, ctx) {
  const url = new URL(request.url);
  const id = (url.searchParams.get("id") || "").replace(/\D/g, "");
  const type = url.searchParams.get("type") || "character";
  const lang = (url.searchParams.get("lang") || "ja").toLowerCase();
  const region = REGION[lang] || "na";

  if (!id) return json({ error: "missing id" }, 400);
  if (!["character", "mounts", "minions", "achievements"].includes(type)) return json({ error: "bad type" }, 400);

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const base = `https://${region}.finalfantasyxiv.com/lodestone/character/${id}`;
  let body, status = 200;
  try {
    if (type === "mounts") body = await getCollection(base, "mount", "mount__name");
    else if (type === "minions") body = await getCollection(base, "minion", "minion__name");
    else if (type === "achievements") body = await getAchievements(base);
    else body = await getCharacter(base);
  } catch (e) {
    if (e && e.code === 404) return json({ error: "not found" }, 404);
    return json({ error: String((e && e.message) || e) }, 502);
  }

  const res = json(body, status);
  res.headers.set("Cache-Control", `public, max-age=${TTL[type] || 900}`);
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

async function fetchHtml(u) {
  const r = await fetch(u, {
    headers: { "User-Agent": UA, "Accept-Language": "ja,en;q=0.8", Accept: "text/html" },
    cf: { cacheTtl: 600, cacheEverything: true },
  });
  if (r.status === 404) { const e = new Error("not found"); e.code = 404; throw e; }
  if (!r.ok) { const e = new Error("lodestone " + r.status); e.code = r.status; throw e; }
  return r.text();
}

async function getCharacter(base) {
  const html = await fetchHtml(base + "/");
  const name = text(html, /frame__chara__name[^>]*>([^<]+)</);
  const world = html.match(/frame__chara__world[^>]*>\s*([^<\[]+?)\s*(?:\[([^\]]+)\])?<\/p>/i);
  const portrait = (html.match(/js__image_popup[^>]*>\s*<img[^>]*src="([^"]+)"/i) ||
                    html.match(/frame__chara__face[^>]*>\s*<img[^>]*src="([^"]+)"/i) || [])[1] || "";
  let achPublic = true, achCount = null, achPoints = null;
  try {
    const a = await fetchHtml(base + "/achievement/");
    const total = a.match(/parts__total[^>]*>\D*([\d,]+)/i);
    const pts = a.match(/achievement__point[^>]*>\D*([\d,]+)/i);
    const hasKinds = /\/achievement\/kind\/\d+\//.test(a);
    if (total) achCount = num(total[1]);
    if (pts) achPoints = num(pts[1]);
    if (achCount === null && !hasKinds && !/parts__zero/.test(a)) achPublic = false;
  } catch (e) { achPublic = false; }
  return {
    id: base.match(/character\/(\d+)/)[1],
    name: name || "", server: world ? world[1].trim() : "",
    data_center: world && world[2] ? world[2].trim() : "", portrait,
    achievements: { public: achPublic, count: achCount, points: achPoints },
  };
}

async function getCollection(base, path, nameClass) {
  const html = await fetchHtml(base + "/" + path + "/");
  const names = []; const re = new RegExp('class="' + nameClass + '"[^>]*>([^<]*)<', "g");
  let m; while ((m = re.exec(html)) !== null) { const nm = decode(m[1]).trim(); if (nm) names.push(nm); }
  return { names, count: names.length };
}

async function getAchievements(base) {
  const landing = await fetchHtml(base + "/achievement/");
  if (/parts__zero/.test(landing) && !/\/achievement\/kind\/\d+\//.test(landing))
    return { public: true, ids: [], count: 0, partial: false };
  const kinds = uniq([...landing.matchAll(/\/achievement\/kind\/(\d+)\//g)].map((x) => x[1]));
  if (!kinds.length) {
    const idsOnLanding = uniq([...landing.matchAll(/\/achievement\/detail\/(\d+)\//g)].map((x) => x[1]));
    if (!idsOnLanding.length) return { public: false, ids: [], count: 0, partial: false };
    return { public: true, ids: idsOnLanding.map(Number), count: idsOnLanding.length, partial: false };
  }
  const owned = new Set(); let fetches = 0, partial = false;
  for (const k of kinds) {
    if (fetches >= MAX_FETCHES) { partial = true; break; }
    const first = await fetchHtml(`${base}/achievement/kind/${k}/`); fetches++;
    collectDetailIds(first, owned);
    const pages = maxPage(first);
    for (let p = 2; p <= pages; p++) {
      if (fetches >= MAX_FETCHES) { partial = true; break; }
      const h = await fetchHtml(`${base}/achievement/kind/${k}/?page=${p}`); fetches++;
      collectDetailIds(h, owned);
    }
    if (partial) break;
  }
  return { public: true, ids: [...owned], count: owned.size, partial };
}

function collectDetailIds(html, set) { const re = /\/achievement\/detail\/(\d+)\//g; let m; while ((m = re.exec(html)) !== null) set.add(Number(m[1])); }
function maxPage(html) { let max = 1, m; const re = /[?&]page=(\d+)/g; while ((m = re.exec(html)) !== null) max = Math.max(max, parseInt(m[1], 10)); return max; }
function text(html, re) { const m = html.match(re); return m ? decode(m[1]).trim() : ""; }
function num(s) { const n = parseInt(String(s).replace(/[^\d]/g, ""), 10); return isNaN(n) ? null : n; }
function uniq(a) { return [...new Set(a)]; }
function decode(s) {
  return String(s).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/gi, "'").replace(/&#0?38;/g, "&")
    .replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" },
  });
}
