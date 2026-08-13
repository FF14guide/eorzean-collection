/**
 * エオルゼア蒐集録 — ロードストーン直読み Pages Function
 * ------------------------------------------------------------------
 * GET /api/lodestone?id=<LodestoneID>&type=<character|mounts|minions|achievements>&lang=<ja|en|de|fr>
 *
 * ブラウザは CORS でロードストーンを直接読めないため、この Function が
 * サーバー側（Cloudflare Workers）で取得・解析して JSON を返す。
 * カタログ（全体一覧）は FFXIV Collect、所持状況はここ、という役割分担。
 *
 * セレクタ出典: xivapi/lodestone-css-selectors（コミュニティ管理・最新）
 * ------------------------------------------------------------------
 */

const REGION = { ja: "jp", en: "na", de: "de", fr: "fr" };
const UA = "Mozilla/5.0 (compatible; EorzeaCollectionLedger/1.0; +https://collection.eorzeanfishing.com)";

// 取得ページ数の上限（無料プランのサブリクエスト上限=50に対する安全弁。
// 有料 Workers なら1000まで上げられるので、その場合はここを増やしてよい）
const MAX_FETCHES = 45;

// キャッシュ時間（秒）。ロードストーンに優しく、表示も速くする。
const TTL = { character: 900, mounts: 1800, minions: 1800, achievements: 21600 };

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const id = (url.searchParams.get("id") || "").replace(/\D/g, "");
  const type = url.searchParams.get("type") || "character";
  const lang = (url.searchParams.get("lang") || "ja").toLowerCase();
  const region = REGION[lang] || "na";

  if (!id) return json({ error: "missing id" }, 400);
  if (!["character", "mounts", "minions", "achievements"].includes(type))
    return json({ error: "bad type" }, 400);

  // エッジキャッシュ（同一URLの再取得を避ける）
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const base = `https://${region}.finalfantasyxiv.com/lodestone/character/${id}`;

  let body, status = 200;
  try {
    if (type === "mounts")      body = await getCollection(base, "mount", "mount__name");
    else if (type === "minions") body = await getCollection(base, "minion", "minion__name");
    else if (type === "achievements") body = await getAchievements(base);
    else                         body = await getCharacter(base);
  } catch (e) {
    return json({ error: String(e && e.message || e) }, 502);
  }
  if (body && body._status) { status = body._status; delete body._status; }

  const res = json(body, status);
  if (status === 200) {
    res.headers.set("Cache-Control", `public, max-age=${TTL[type] || 900}`);
    context.waitUntil(cache.put(cacheKey, res.clone()));
  }
  return res;
}

/* ---------- 取得ヘルパ ---------- */
async function fetchHtml(u) {
  const r = await fetch(u, {
    headers: { "User-Agent": UA, "Accept-Language": "ja,en;q=0.8", "Accept": "text/html" },
    cf: { cacheTtl: 600, cacheEverything: true },
  });
  if (r.status === 404) { const e = new Error("not found"); e.code = 404; throw e; }
  if (!r.ok) { const e = new Error("lodestone " + r.status); e.code = r.status; throw e; }
  return r.text();
}

/* ---------- キャラ概要（プロフィール＋実績サマリ） ---------- */
async function getCharacter(base) {
  const html = await fetchHtml(base + "/");
  const name = text(html, /frame__chara__name[^>]*>([^<]+)</);
  const world = html.match(/frame__chara__world[^>]*>\s*([^<\[]+?)\s*(?:\[([^\]]+)\])?<\/p>/i);
  const portrait = (html.match(/js__image_popup[^>]*>\s*<img[^>]*src="([^"]+)"/i) ||
                    html.match(/frame__chara__face[^>]*>\s*<img[^>]*src="([^"]+)"/i) || [])[1] || "";

  // 実績ランディング（公開時のみ合計/ポイントが取れる。1リクエストで安価）
  let achPublic = true, achCount = null, achPoints = null;
  try {
    const a = await fetchHtml(base + "/achievement/");
    const total = a.match(/parts__total[^>]*>\D*([\d,]+)/i);
    const pts = a.match(/achievement__point[^>]*>\D*([\d,]+)/i);
    const hasKinds = /\/achievement\/kind\/\d+\//.test(a);
    if (total) achCount = num(total[1]);
    if (pts) achPoints = num(pts[1]);
    // 実績が非公開だと一覧要素も総数も出ない
    if (achCount === null && !hasKinds && !/parts__zero/.test(a)) achPublic = false;
  } catch (e) {
    if (e.code === 403 || e.code === 401) achPublic = false; else achPublic = false;
  }

  return {
    id: base.match(/character\/(\d+)/)[1],
    name: name || "",
    server: world ? world[1].trim() : "",
    data_center: world && world[2] ? world[2].trim() : "",
    portrait,
    achievements: { public: achPublic, count: achCount, points: achPoints },
  };
}

/* ---------- マウント / ミニオン（各1ページに全所持） ---------- */
async function getCollection(base, path, nameClass) {
  const html = await fetchHtml(base + "/" + path + "/");
  const names = [];
  const re = new RegExp('class="' + nameClass + '"[^>]*>([^<]*)<', "g");
  let m;
  while ((m = re.exec(html)) !== null) {
    const nm = decode(m[1]).trim();
    if (nm) names.push(nm);
  }
  return { names, count: names.length };
}

/* ---------- アチーブメント（カテゴリ別＋ページ送りで所持IDを列挙） ---------- */
async function getAchievements(base) {
  const landing = await fetchHtml(base + "/achievement/");
  if (/parts__zero/.test(landing) && !/\/achievement\/kind\/\d+\//.test(landing))
    return { public: true, ids: [], count: 0, partial: false };

  // カテゴリ（kind）をランディングから動的に発見（ロケール非依存）
  const kinds = uniq([...landing.matchAll(/\/achievement\/kind\/(\d+)\//g)].map((x) => x[1]));
  if (!kinds.length) {
    // kindが取れない＝非公開の可能性が高い
    const idsOnLanding = uniq([...landing.matchAll(/\/achievement\/detail\/(\d+)\//g)].map((x) => x[1]));
    if (!idsOnLanding.length) return { public: false, ids: [], count: 0, partial: false };
    return { public: true, ids: idsOnLanding.map(Number), count: idsOnLanding.length, partial: false };
  }

  const owned = new Set();
  let fetches = 0, partial = false;

  for (const k of kinds) {
    if (fetches >= MAX_FETCHES) { partial = true; break; }
    const first = await fetchHtml(`${base}/achievement/kind/${k}/`); fetches++;
    collectDetailIds(first, owned);
    // ページャの ?page=N から総ページ数を得る（ロケール非依存）
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

/* ---------- 小物 ---------- */
function collectDetailIds(html, set) {
  const re = /\/achievement\/detail\/(\d+)\//g;
  let m; while ((m = re.exec(html)) !== null) set.add(Number(m[1]));
}
function maxPage(html) {
  let max = 1, m; const re = /[?&]page=(\d+)/g;
  while ((m = re.exec(html)) !== null) max = Math.max(max, parseInt(m[1], 10));
  return max;
}
function text(html, re) { const m = html.match(re); return m ? decode(m[1]).trim() : ""; }
function num(s) { const n = parseInt(String(s).replace(/[^\d]/g, ""), 10); return isNaN(n) ? null : n; }
function uniq(a) { return [...new Set(a)]; }
function decode(s) {
  return String(s)
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/gi, "'").replace(/&#0?38;/g, "&")
    .replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
