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
 * /api/lodestone-achievement-dates
 *   指定した公開アチーブメント詳細ページから、達成日時（UNIX秒）を返す。
 * /api/fflogs-summary
 *   FF Logs APIのサーバー側認証を使い、キャラクターのDPS/HPSパーフ概要を返す。
 *   APIシークレットはWorker環境変数のみで扱い、ブラウザには公開しない。
 */
const REGION = { ja: "jp", en: "na", de: "de", fr: "fr" };
const USER_AGENT =
  "Mozilla/5.0 (compatible; EorzeaCollectionLedger/4.0; +https://collection.eorzeanfishing.com)";
const COLLECTION_TTL = 15 * 60;
const ICON_TTL = 7 * 24 * 60 * 60;
const ACHIEVEMENT_TTL = 60 * 60;
const ACHIEVEMENT_DATE_TTL = 24 * 60 * 60;
const FFLOGS_TTL = 6 * 60 * 60;
const ACHIEVEMENT_PAGES_PER_REQUEST = 10;
const MAX_HIGH_END_ACHIEVEMENTS = 24;
const FFLOGS_TOKEN_URL = "https://www.fflogs.com/oauth/token";
const FFLOGS_GRAPHQL_URL = "https://www.fflogs.com/api/v2/client";
const FFLOGS_DC_REGION = {
  elemental: "jp",
  gaia: "jp",
  mana: "jp",
  meteor: "jp",
  aether: "us",
  crystal: "us",
  dynamis: "us",
  primal: "us",
  chaos: "eu",
  light: "eu",
  materia: "oc",
};
const FFLOGS_SUMMARY_QUERY = `query CharacterSummary($name: String!, $serverSlug: String!, $serverRegion: String!) {
  characterData {
    character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
      id
      name
      dps: zoneRankings(metric: rdps)
      hps: zoneRankings(metric: hps)
    }
  }
}`;

// FF LogsのゾーンID。各ゾーン内のエンカウントID・名称はWorldDataから取得し、
// 4層の前半／後半を固定のボスIDへ依存せずに表示する。
const FFLOGS_RAID_TIER_CATALOG = [
  { key: "asphodelos", label: "万魔殿パンデモニウム零式：辺獄編", zoneId: 44 },
  { key: "abyssos", label: "万魔殿パンデモニウム零式：煉獄編", zoneId: 49 },
  { key: "anabaseios", label: "万魔殿パンデモニウム零式：天獄編", zoneId: 54 },
  { key: "light-heavyweight", label: "至天の座アルカディア零式：ライトヘビー級", zoneId: 62 },
  { key: "cruiserweight", label: "至天の座アルカディア零式：クルーザー級", zoneId: 68 },
  { key: "heavyweight", label: "至天の座アルカディア零式：ヘビー級", zoneId: 73 },
];
const FFLOGS_ZONE_METADATA_QUERY = `query RaidTierMetadata {
  worldData {
    ${FFLOGS_RAID_TIER_CATALOG.map((tier) => `z${tier.zoneId}: zone(id: ${tier.zoneId}) { id name encounters { id name } }`).join("\n    ")}
  }
}`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/lodestone-collections")
      return handleCollections(request, ctx);
    if (url.pathname === "/api/lodestone-achievements")
      return handleAchievements(request, ctx);
    if (url.pathname === "/api/lodestone-achievement-dates")
      return handleAchievementDates(request, ctx);
    if (url.pathname === "/api/fflogs-summary")
      return handleFFLogsSummary(request, env, ctx);
    if (url.pathname === "/api/fflogs-content-performance")
      return handleFFLogsContentPerformance(request, env, ctx);
    if (url.pathname === "/api/lodestone-icon") return handleIcon(request, ctx);
    if (url.pathname === "/api/lodestone")
      return json({ error: "deprecated_endpoint" }, 410, "no-store");
    return env.ASSETS.fetch(request);
  },
};

async function handleCollections(request, ctx) {
  const url = new URL(request.url);
  const id = (url.searchParams.get("id") || "").replace(/\D/g, "");
  const language = (url.searchParams.get("lang") || "ja").toLowerCase();
  const region = REGION[language] || "jp";
  if (!/^\d{4,}$/.test(id))
    return json({ error: "missing_id" }, 400, "no-store");

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

    const response = json(
      {
        id: Number(id),
        name: character.name,
        server: character.server,
        data_center: character.data_center,
        portrait: character.portrait,
        mounts,
        minions,
        source: "lodestone-public",
      },
      200,
      `public, max-age=${COLLECTION_TTL}`,
    );
    ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    const status = error && error.status === 404 ? 404 : 502;
    return json(
      { error: status === 404 ? "not_found" : "lodestone_unavailable" },
      status,
      "no-store",
    );
  }
}

async function handleAchievements(request, ctx) {
  const url = new URL(request.url);
  const id = (url.searchParams.get("id") || "").replace(/\D/g, "");
  const language = (url.searchParams.get("lang") || "ja").toLowerCase();
  const region = REGION[language] || "jp";
  const start = Math.max(
    1,
    Number.parseInt(url.searchParams.get("page") || "1", 10) || 1,
  );
  if (!/^\d{4,}$/.test(id))
    return json({ error: "missing_id" }, 400, "no-store");

  const cacheKey = new Request(url.toString(), request);
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  try {
    const seed = await fetchLodestone(
      region,
      id,
      start === 1 ? "achievement/" : `achievement/?page=${start}`,
    );
    const totalPages = achievementPageCount(seed);
    const through = Math.min(
      totalPages,
      start + ACHIEVEMENT_PAGES_PER_REQUEST - 1,
    );
    const pages = [];
    for (let page = start; page <= through; page += 1) pages.push(page);
    const requests = pages.map((page) =>
      page === start
        ? Promise.resolve(seed)
        : fetchLodestone(region, id, `achievement/?page=${page}`),
    );
    if (start === 1) requests.push(fetchLodestone(region, id, ""));
    const result = await Promise.all(requests);
    const html = result.slice(0, pages.length);
    const character =
      start === 1 ? extractCharacter(result[result.length - 1], id) : null;
    const ids = new Set();
    html.forEach((body) =>
      extractAchievementIds(body).forEach((achievementId) =>
        ids.add(achievementId),
      ),
    );

    if (start === 1 && !character.name)
      return json({ error: "not_found" }, 404, "no-store");
    if (!ids.size && isAchievementPrivate(seed))
      return json({ error: "private_or_unavailable" }, 403, "no-store");
    const response = json(
      {
        id: Number(id),
        ids: [...ids],
        page: start,
        through,
        total_pages: totalPages,
        complete: through >= totalPages,
        character,
        source: "lodestone-public",
      },
      200,
      `public, max-age=${ACHIEVEMENT_TTL}`,
    );
    ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    const status = error && error.status === 404 ? 404 : 502;
    return json(
      { error: status === 404 ? "not_found" : "lodestone_unavailable" },
      status,
      "no-store",
    );
  }
}

async function handleAchievementDates(request, ctx) {
  const url = new URL(request.url);
  const id = (url.searchParams.get("id") || "").replace(/\D/g, "");
  const language = (url.searchParams.get("lang") || "ja").toLowerCase();
  const region = REGION[language] || "jp";
  const ids = [
    ...new Set(
      (url.searchParams.get("ids") || "")
        .split(",")
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  ].slice(0, MAX_HIGH_END_ACHIEVEMENTS);
  if (!/^\d{4,}$/.test(id))
    return json({ error: "missing_id" }, 400, "no-store");
  if (!ids.length)
    return json({ error: "missing_achievement_ids" }, 400, "no-store");

  const cacheKey = new Request(url.toString(), request);
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  try {
    const rows = await mapWithConcurrency(ids, 6, async (achievementId) => {
      const html = await fetchLodestone(
        region,
        id,
        `achievement/detail/${achievementId}/`,
      );
      return [achievementId, extractAchievementTimestamp(html)];
    });
    const dates = Object.fromEntries(
      rows.filter(([, timestamp]) => Number.isFinite(timestamp)),
    );
    const response = json(
      {
        id: Number(id),
        dates,
        source: "lodestone-public",
        checked: ids.length,
      },
      200,
      `public, max-age=${ACHIEVEMENT_DATE_TTL}`,
    );
    ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    const status = error && error.status === 404 ? 404 : 502;
    return json(
      { error: status === 404 ? "not_found" : "lodestone_unavailable" },
      status,
      "no-store",
    );
  }
}

async function handleFFLogsSummary(request, env, ctx) {
  const url = new URL(request.url);
  const name = (url.searchParams.get("name") || "").trim().slice(0, 80);
  const world = (url.searchParams.get("world") || "").trim().slice(0, 80);
  const dataCenter = (url.searchParams.get("dc") || "").trim().toLowerCase();
  if (!name || !world)
    return json({ error: "missing_character" }, 400, "no-store");

  const profileUrl = fflogsProfileUrl(name, world);
  if (!env.FFLOGS_CLIENT_ID || !env.FFLOGS_CLIENT_SECRET) {
    return json(
      { configured: false, profile_url: profileUrl },
      200,
      "no-store",
    );
  }

  const cacheKey = new Request(url.toString(), request);
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  try {
    const token = await fflogsClientToken(
      env.FFLOGS_CLIENT_ID,
      env.FFLOGS_CLIENT_SECRET,
    );
    const upstream = await fetch(FFLOGS_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: FFLOGS_SUMMARY_QUERY,
        variables: {
          name,
          serverSlug: fflogsServerSlug(world),
          serverRegion: FFLOGS_DC_REGION[dataCenter] || "jp",
        },
      }),
    });
    if (!upstream.ok) throw new Error(`fflogs_${upstream.status}`);
    const payload = await upstream.json();
    if (payload.errors?.length) throw new Error("fflogs_graphql_error");
    const character = payload.data?.characterData?.character || null;
    const response = json(
      {
        configured: true,
        found: !!character,
        profile_url: profileUrl,
        dps: fflogsMetricSummary(character?.dps),
        hps: fflogsMetricSummary(character?.hps),
        fetched_at: new Date().toISOString(),
      },
      200,
      `public, max-age=${FFLOGS_TTL}`,
    );
    ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
    return response;
  } catch {
    return json(
      {
        configured: true,
        found: false,
        profile_url: profileUrl,
        error: "fflogs_unavailable",
      },
      200,
      "no-store",
    );
  }
}

async function handleFFLogsContentPerformance(request, env, ctx) {
  const url = new URL(request.url);
  const name = (url.searchParams.get("name") || "").trim().slice(0, 80);
  const world = (url.searchParams.get("world") || "").trim().slice(0, 80);
  const dataCenter = (url.searchParams.get("dc") || "").trim().toLowerCase();
  if (!name || !world)
    return json({ error: "missing_character" }, 400, "no-store");

  const profileUrl = fflogsProfileUrl(name, world);
  if (!env.FFLOGS_CLIENT_ID || !env.FFLOGS_CLIENT_SECRET) {
    return json(
      { configured: false, profile_url: profileUrl, tiers: [] },
      200,
      "no-store",
    );
  }

  const cacheKey = new Request(url.toString(), request);
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  try {
    const token = await fflogsClientToken(
      env.FFLOGS_CLIENT_ID,
      env.FFLOGS_CLIENT_SECRET,
    );
    const metadataPayload = await fflogsGraphQL(token, FFLOGS_ZONE_METADATA_QUERY);
    const tiers = fflogsRaidTiersFromMetadata(metadataPayload.data?.worldData);
    const performancePayload = await fflogsGraphQL(
      token,
      fflogsContentPerformanceQuery(tiers),
      {
        name,
        serverSlug: fflogsServerSlug(world),
        serverRegion: FFLOGS_DC_REGION[dataCenter] || "jp",
      },
    );
    const character = performancePayload.data?.characterData?.character || null;
    const response = json(
      {
        configured: true,
        found: !!character,
        profile_url: profileUrl,
        tiers: fflogsTierPerformanceRows(tiers, character),
        fetched_at: new Date().toISOString(),
      },
      200,
      `public, max-age=${FFLOGS_TTL}`,
    );
    ctx.waitUntil(caches.default.put(cacheKey, response.clone()));
    return response;
  } catch {
    return json(
      {
        configured: true,
        found: false,
        profile_url: profileUrl,
        tiers: [],
        error: "fflogs_unavailable",
      },
      200,
      "no-store",
    );
  }
}

async function fflogsGraphQL(token, query, variables = {}) {
  const upstream = await fetch(FFLOGS_GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!upstream.ok) throw new Error(`fflogs_${upstream.status}`);
  const payload = await upstream.json();
  if (payload.errors?.length) throw new Error("fflogs_graphql_error");
  return payload;
}

function fflogsRaidTiersFromMetadata(worldData) {
  return FFLOGS_RAID_TIER_CATALOG.map((tier) => {
    const zone = worldData?.[`z${tier.zoneId}`];
    const encounters = Array.isArray(zone?.encounters) ? zone.encounters : [];
    return {
      ...tier,
      zoneName: String(zone?.name || tier.label),
      encounters: encounters
        .filter((encounter) => Number.isInteger(Number(encounter?.id)))
        .map((encounter) => ({
          id: Number(encounter.id),
          name: String(encounter.name || ""),
        })),
    };
  }).filter((tier) => tier.encounters.length > 0);
}

function fflogsContentPerformanceQuery(tiers) {
  const selections = tiers.flatMap((tier) =>
    tier.encounters.flatMap((encounter) => [
      `dps_${tier.zoneId}_${encounter.id}: encounterRankings(encounterID: ${encounter.id}, metric: rdps, partition: -1)`,
      `hps_${tier.zoneId}_${encounter.id}: encounterRankings(encounterID: ${encounter.id}, metric: hps, partition: -1)`,
    ]),
  );
  return `query CharacterContentPerformance($name: String!, $serverSlug: String!, $serverRegion: String!) {
    characterData {
      character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
        id
        ${selections.join("\n        ")}
      }
    }
  }`;
}

function fflogsEncounterLabel(index, total) {
  if (total === 5 && index === 3) return "4層 前半";
  if (total === 5 && index === 4) return "4層 後半";
  return `${index + 1}層`;
}

function fflogsEncounterPerformance(value) {
  const average = Number(value?.averagePerformance);
  if (Number.isFinite(average)) return average;
  const ranks = Array.isArray(value?.ranks) ? value.ranks : [];
  const percentiles = ranks
    .map((rank) => Number(rank?.rankPercent))
    .filter((percentile) => Number.isFinite(percentile));
  if (!percentiles.length) return null;
  return percentiles.reduce((total, percentile) => total + percentile, 0) / percentiles.length;
}

function fflogsTierPerformanceRows(tiers, character) {
  return tiers.map((tier) => ({
    key: tier.key,
    label: tier.label,
    zone_id: tier.zoneId,
    zone_name: tier.zoneName,
    encounters: tier.encounters.map((encounter, index) => ({
      id: encounter.id,
      name: encounter.name,
      label: fflogsEncounterLabel(index, tier.encounters.length),
      dps: fflogsEncounterPerformance(
        character?.[`dps_${tier.zoneId}_${encounter.id}`],
      ),
      hps: fflogsEncounterPerformance(
        character?.[`hps_${tier.zoneId}_${encounter.id}`],
      ),
    })),
  }));
}

async function mapWithConcurrency(values, limit, mapper) {
  const output = new Array(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, values.length) },
    async () => {
      for (;;) {
        const index = next++;
        if (index >= values.length) return;
        output[index] = await mapper(values[index]);
      }
    },
  );
  await Promise.all(workers);
  return output;
}

async function fflogsClientToken(clientId, clientSecret) {
  const credentials = btoa(`${clientId}:${clientSecret}`);
  const response = await fetch(FFLOGS_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });
  if (!response.ok) throw new Error(`fflogs_token_${response.status}`);
  const body = await response.json();
  if (!body.access_token) throw new Error("fflogs_token_missing");
  return body.access_token;
}

function fflogsServerSlug(world) {
  return String(world || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function fflogsProfileUrl(name, world) {
  return `https://ja.fflogs.com/character/jp/${encodeURIComponent(fflogsServerSlug(world))}/${encodeURIComponent(name)}`;
}

function fflogsMetricSummary(value) {
  if (!value) return { best: null, median: null };
  const best = Number(value.bestPerformanceAverage);
  const median = Number(value.medianPerformanceAverage);
  return {
    best: Number.isFinite(best) ? best : null,
    median: Number.isFinite(median) ? median : null,
  };
}

async function handleIcon(request, ctx) {
  const url = new URL(request.url);
  const remote = url.searchParams.get("url") || "";
  if (!isLodestoneItemIcon(remote))
    return json({ error: "invalid_icon_url" }, 400, "no-store");

  const canonical = remote.split("?", 1)[0];
  const cacheKey = new Request(
    `${url.origin}/_icon/${encodeURIComponent(canonical)}`,
  );
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  try {
    const upstream = await fetch(canonical, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!upstream.ok)
      return json({ error: "icon_unavailable" }, 502, "no-store");
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
  const response = await fetch(
    `https://${region}.finalfantasyxiv.com/lodestone/character/${id}/${suffix}`,
    {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "ja,en;q=0.8",
        Accept: "text/html",
      },
      cf: { cacheEverything: true, cacheTtl: COLLECTION_TTL },
    },
  );
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
  for (const match of html.matchAll(/\/achievement\/detail\/(\d+)\//g))
    ids.add(Number(match[1]));
  return [...ids];
}

function achievementPageCount(html) {
  let maxPage = 1;
  for (const match of html.matchAll(/[?&]page=(\d+)/g))
    maxPage = Math.max(maxPage, Number(match[1]));
  return maxPage;
}

function isAchievementPrivate(html) {
  return /achievement__private|parts__private|アチーブメント[^<]{0,80}非公開/i.test(
    html,
  );
}

function extractAchievementTimestamp(html) {
  const completeView = html.match(
    /entry__achievement__view--complete[\s\S]{0,5000}?ldst_strftime\(\s*(\d{10,13})\s*,/i,
  );
  if (!completeView) return null;
  const raw = Number(completeView[1]);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return raw > 1e11 ? Math.floor(raw / 1000) : raw;
}

function extractItemIcons(html) {
  const matches = html.matchAll(
    /<img[^>]+class="[^"]*character__item_icon__img[^"]*"[^>]+src="([^"]*\/itemicon\/[^"?]+)(?:\?[^\"]*)?"|<img[^>]+src="([^"]*\/itemicon\/[^"?]+)(?:\?[^\"]*)?"[^>]+class="[^"]*character__item_icon__img[^"]*"/gi,
  );
  const icons = new Set();
  for (const match of matches) {
    const icon = match[1] || match[2];
    if (isLodestoneItemIcon(icon)) icons.add(icon);
  }
  return [...icons];
}

function extractCharacter(html, id) {
  const name = decodeHtml(
    (html.match(/frame__chara__name[^>]*>\s*([^<]+?)\s*</i) || [])[1] || "",
  ).trim();
  const worldHtml =
    (html.match(/frame__chara__world[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || "";
  const worldText = decodeHtml(worldHtml.replace(/<[^>]*>/g, "")).trim();
  const world = worldText.match(/^(.*?)\s*(?:\[([^\]]+)\])?$/);
  const portrait = (
    (html.match(/frame__chara__face[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/i) ||
      [])[1] || ""
  ).trim();
  return {
    id: Number(id),
    name,
    server: world ? world[1].trim() : "",
    data_center: world && world[2] ? world[2].trim() : "",
    portrait,
  };
}

function isPrivate(html) {
  return /private|非公開|character__private/i.test(html);
}

function isLodestoneItemIcon(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "lds-img.finalfantasyxiv.com" &&
      /^\/itemicon\/[A-Za-z0-9/_-]+\.png$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function decodeHtml(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;/gi, "'");
}

function json(value, status = 200, cacheControl = "no-store") {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
    },
  });
}

export {
  extractAchievementIds,
  achievementPageCount,
  extractAchievementTimestamp,
  extractItemIcons,
  extractCharacter,
  isLodestoneItemIcon,
  fflogsServerSlug,
  fflogsProfileUrl,
  fflogsMetricSummary,
  fflogsRaidTiersFromMetadata,
  fflogsContentPerformanceQuery,
  fflogsEncounterLabel,
  fflogsEncounterPerformance,
  fflogsTierPerformanceRows,
};
