/**
 * エオルゼア蒐集録 — Static Assets Worker
 *
 * /api/lodestone-collections
 *   登録不要で公開ロードストーンのマウント／ミニオン itemicon URL を返す。
 * /api/lodestone-achievements
 *   公開ロードストーンのアチーブメント一覧から達成IDをページ範囲ごとに返す。
 * /api/lodestone-icon
 *   上記 itemicon URL 専用の同一オリジン画像プロキシ。Canvas照合用であり、
 *   任意URLの取得は許可しない。
 */
const REGION = { ja: "jp", en: "na", de: "de", fr: "fr" };
const USER_AGENT = "Mozilla/5.0 (compatible; EorzeaCollectionLedger/4.0; +https://collection.eorzeanfishing.com)";
const COLLECTION_TTL = 15 * 60;
const ICON_TTL = 7 * 24 * 60 * 60;
const ACHIEVEMENT_TTL = 60 * 60;
const ACHIEVEMENT_PAGES_PER_REQUEST = 10;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/lodestone-collections") return handleCollections(request, ctx);
    if (url.pathname === "/api/lodestone-achievements") return handleAchievements(request, ctx);
    if (url.pathname === "/api/lodestone-icon") return handleIcon(request, ctx);
    if (url.pathname === "/api/lodestone") return json({ error: "deprecated_endpoint" }, 410, "no-store");
    return env.ASSETS.fetch(request);
  },
};

async function handleCollections(request, ctx) {
  const url = new URL(request.url);
  const id = (url.searchParams.get("id") || "").replace(/\D/g, "");
  const language = (url.searchParams.get("lang") || "ja").toLowerCase();
  const region = REGION[language] || "jp";
  if (!/^\d{4,}$/.test(id)) return json({ error: "missing_id" }, 400, "no-store");

  const cacheKey = new Request(url.toString(), request);
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  try {
    const [mountHtml, minionHtml, characterHtml] = await Promise.all([
      fetchLodestone(region, id, "mount/"),
      fetchLodestone(region, id, "minion/"),
      fetchLodestone(region, id, ""),
    ]);
    const mounts = extractItemIcons(mountHtml);
    const minions = extractItemIcons(minionHtml);
    const character = extractCharacter(characterHtml, id);

    if (!character.name) return json({ error: "not_found" }, 404, "no-store");
    if (!mounts.length && !minions.length && isPrivate(characterHtml)) {
      return json({ error: "private_or_unavailable" }, 403, "no-store");
    }

    const response = json({
      id: Number(id),
      name: character.name,
      server: character.server,
      data_center: character.data_center,
      portrait: character.portrait,
      mounts,
      minions,
      source: "lodestone-public",
    }, 200, `public, max-age=${COLLECTION_TTL}`);
    ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    const status = error && error.status === 404 ? 404 : 502;
    return json({ error: status === 404 ? "not_found" : "lodestone_unavailable" }, status, "no-store");
  }
}

async function handleAchievements(request, ctx) {
  const url = new URL(request.url);
  const id = (url.searchParams.get("id") || "").replace(/\D/g, "");
  const language = (url.searchParams.get("lang") || "ja").toLowerCase();
  const region = REGION[language] || "jp";
  const start = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
  if (!/^\d{4,}$/.test(id)) return json({ error: "missing_id" }, 400, "no-store");

  const cacheKey = new Request(url.toString(), request);
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  try {
    const seed = await fetchLodestone(region, id, start === 1 ? "achievement/" : `achievement/?page=${start}`);
    const totalPages = achievementPageCount(seed);
    const through = Math.min(totalPages, start + ACHIEVEMENT_PAGES_PER_REQUEST - 1);
    const pages = [];
    for (let page = start; page <= through; page += 1) pages.push(page);
    const requests = pages.map((page) => page === start ? Promise.resolve(seed) : fetchLodestone(region, id, `achievement/?page=${page}`));
    if (start === 1) requests.push(fetchLodestone(region, id, ""));
    const result = await Promise.all(requests);
    const html = result.slice(0, pages.length);
    const character = start === 1 ? extractCharacter(result[result.length - 1], id) : null;
    const ids = new Set();
    html.forEach((body) => extractAchievementIds(body).forEach((achievementId) => ids.add(achievementId)));

    if (start === 1 && !character.name) return json({ error: "not_found" }, 404, "no-store");
    if (!ids.size && isAchievementPrivate(seed)) return json({ error: "private_or_unavailable" }, 403, "no-store");
    const response = json({ id: Number(id), ids: [...ids], page: start, through, total_pages: totalPages, complete: through >= totalPages, character, source: "lodestone-public" }, 200, `public, max-age=${ACHIEVEMENT_TTL}`);
    ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    const status = error && error.status === 404 ? 404 : 502;
    return json({ error: status === 404 ? "not_found" : "lodestone_unavailable" }, status, "no-store");
  }
}

async function handleIcon(request, ctx) {
  const url = new URL(request.url);
  const remote = url.searchParams.get("url") || "";
  if (!isLodestoneItemIcon(remote)) return json({ error: "invalid_icon_url" }, 400, "no-store");

  const canonical = remote.split("?", 1)[0];
  const cacheKey = new Request(`${url.origin}/_icon/${encodeURIComponent(canonical)}`);
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  try {
    const upstream = await fetch(canonical, { headers: { "User-Agent": USER_AGENT } });
    if (!upstream.ok) return json({ error: "icon_unavailable" }, 502, "no-store");
    const response = new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") || "image/png",
        "Cache-Control": `public, max-age=${ICON_TTL}, immutable`,
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
    ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
    return response;
  } catch {
    return json({ error: "icon_unavailable" }, 502, "no-store");
  }
}

async function fetchLodestone(region, id, suffix) {
  const response = await fetch(`https://${region}.finalfantasyxiv.com/lodestone/character/${id}/${suffix}`, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "ja,en;q=0.8", Accept: "text/html" },
    cf: { cacheEverything: true, cacheTtl: COLLECTION_TTL },
  });
  if (response.status === 404) {
    const error = new Error("not_found");
    error.status = 404;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`lodestone_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.text();
}

function extractAchievementIds(html) {
  const ids = new Set();
  for (const match of html.matchAll(/\/achievement\/detail\/(\d+)\//g)) ids.add(Number(match[1]));
  return [...ids];
}

function achievementPageCount(html) {
  let maxPage = 1;
  for (const match of html.matchAll(/[?&]page=(\d+)/g)) maxPage = Math.max(maxPage, Number(match[1]));
  return maxPage;
}

function isAchievementPrivate(html) {
  return /achievement__private|parts__private|アチーブメント[^<]{0,80}非公開/i.test(html);
}

function extractItemIcons(html) {
  const matches = html.matchAll(/<img[^>]+class="[^"]*character__item_icon__img[^"]*"[^>]+src="([^"]*\/itemicon\/[^"?]+)(?:\?[^\"]*)?"|<img[^>]+src="([^"]*\/itemicon\/[^"?]+)(?:\?[^\"]*)?"[^>]+class="[^"]*character__item_icon__img[^"]*"/gi);
  const icons = new Set();
  for (const match of matches) {
    const icon = match[1] || match[2];
    if (isLodestoneItemIcon(icon)) icons.add(icon);
  }
  return [...icons];
}

function extractCharacter(html, id) {
  const name = decodeHtml((html.match(/frame__chara__name[^>]*>\s*([^<]+?)\s*</i) || [])[1] || "").trim();
  const worldHtml = (html.match(/frame__chara__world[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || "";
  const worldText = decodeHtml(worldHtml.replace(/<[^>]*>/g, "")).trim();
  const world = worldText.match(/^(.*?)\s*(?:\[([^\]]+)\])?$/);
  const portrait = ((html.match(/frame__chara__face[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/i) || [])[1] || "").trim();
  return { id: Number(id), name, server: world ? world[1].trim() : "", data_center: world && world[2] ? world[2].trim() : "", portrait };
}

function isPrivate(html) {
  return /private|非公開|character__private/i.test(html);
}

function isLodestoneItemIcon(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "lds-img.finalfantasyxiv.com" && /^\/itemicon\/[A-Za-z0-9/_-]+\.png$/.test(url.pathname);
  } catch { return false; }
}

function decodeHtml(value) {
  return String(value).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/gi, "'");
}

function json(value, status = 200, cacheControl = "no-store") {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cacheControl },
  });
}

export { extractAchievementIds, achievementPageCount, extractItemIcons, extractCharacter, isLodestoneItemIcon };
