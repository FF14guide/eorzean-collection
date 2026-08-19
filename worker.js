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
const AUTO_CATALOG_TTL = 15 * 60;
const AUTO_UPDATE_MIN_INTERVAL = 4 * 60 * 60 * 1000;
const AUTO_CONFIRMATION_INTERVAL = 4 * 60 * 60 * 1000;
const AUTO_MAX_PROMOTIONS_PER_RUN = 4;
const AUTO_SNAPSHOT_LIMIT = 12;
const AUTO_SOURCE_TIMEOUT = 12000;
const AUTO_PATCH_TOPIC_URL = "https://jp.finalfantasyxiv.com/lodestone/topics/?page=1";
const AUTO_ACHIEVEMENTS_URL = "https://ffxivcollect.com/api/achievements?language=ja";
const AUTO_ACHIEVEMENTS_EN_URL = "https://ffxivcollect.com/api/achievements?language=en";
const AUTO_BASELINE_ACHIEVEMENT_IDS = new Set([1993, 2107, 2444, 3038, 3074, 3111, 3156, 3162, 3251, 3340, 3350, 3428, 3575, 3617, 3630, 3819, 3868, 4069]);
const FFLOGS_TOKEN_URL = "https://www.fflogs.com/oauth/token";
const FFLOGS_GRAPHQL_URL = "https://www.fflogs.com/api/v2/client";
const FFLOGS_DC_REGION = {
  elemental: "JP",
  gaia: "JP",
  mana: "JP",
  meteor: "JP",
  aether: "US",
  crystal: "US",
  dynamis: "US",
  primal: "US",
  chaos: "EU",
  light: "EU",
  materia: "OC",
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
    if (url.pathname === "/api/high-end-catalog")
      return handleHighEndCatalog(env);
    if (url.pathname === "/api/admin/auto-update/run" || url.pathname === "/api/admin/auto-update/rollback")
      return handleAutoUpdateAdmin(request, env, url.pathname.endsWith("/rollback") ? "rollback" : "run");
    if (url.pathname === "/api/lodestone-icon") return handleIcon(request, ctx);
    if (url.pathname === "/api/lodestone")
      return json({ error: "deprecated_endpoint" }, 410, "no-store");
    return env.ASSETS.fetch(request);
  },
  async scheduled(_controller, env, ctx) {
    if (!env.HIGH_END_CATALOG) return;
    const store = env.HIGH_END_CATALOG.getByName("global");
    ctx.waitUntil(store.fetch(new Request("https://auto-catalog.internal/run", { method: "POST" })));
  },
};

async function handleHighEndCatalog(env) {
  if (!env.HIGH_END_CATALOG)
    return json({ groups: [], status: { state: "unconfigured" } }, 200, "no-store");
  const store = env.HIGH_END_CATALOG.getByName("global");
  const response = await store.fetch(new Request("https://auto-catalog.internal/catalog"));
  const payload = await response.json();
  return json(payload, 200, `public, max-age=${AUTO_CATALOG_TTL}`);
}

async function handleAutoUpdateAdmin(request, env, action) {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, "no-store");
  if (!env.AUTO_UPDATE_ADMIN_TOKEN || request.headers.get("Authorization") !== `Bearer ${env.AUTO_UPDATE_ADMIN_TOKEN}`)
    return json({ error: "unauthorized" }, 401, "no-store");
  if (!env.HIGH_END_CATALOG) return json({ error: "unconfigured" }, 503, "no-store");
  const path = action === "rollback" ? "/rollback" : "/run";
  const response = await env.HIGH_END_CATALOG.getByName("global").fetch(new Request(`https://auto-catalog.internal${path}`, { method: "POST" }));
  return new Response(response.body, { status: response.status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

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
          serverRegion: FFLOGS_DC_REGION[dataCenter] || "JP",
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
    const tierCatalog = fflogsMergeTierCatalog(
      FFLOGS_RAID_TIER_CATALOG,
      await getAutoFFLogsTiers(env),
    );
    const metadataPayload = await fflogsGraphQL(
      token,
      fflogsZoneMetadataQuery(tierCatalog),
      {},
      "metadata",
    );
    const tiers = fflogsRaidTiersFromMetadata(
      metadataPayload.data?.worldData,
      tierCatalog,
    );
    if (!tiers.length) throw new Error("fflogs_metadata_empty");
    const performancePayload = await fflogsGraphQL(
      token,
      fflogsContentPerformanceQuery(tiers),
      {
        name,
        serverSlug: fflogsServerSlug(world),
        serverRegion: FFLOGS_DC_REGION[dataCenter] || "JP",
      },
      "rankings",
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
  } catch (error) {
    return json(
      {
        configured: true,
        found: false,
        profile_url: profileUrl,
        tiers: [],
        error: fflogsSafeErrorCode(error),
      },
      200,
      "no-store",
    );
  }
}

async function fflogsGraphQL(token, query, variables = {}, stage = "query") {
  let upstream;
  try {
    upstream = await fetch(FFLOGS_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch {
    throw new Error(`fflogs_${stage}_network`);
  }
  if (!upstream.ok) throw new Error(`fflogs_${stage}_http_${upstream.status}`);
  let payload;
  try {
    payload = await upstream.json();
  } catch {
    throw new Error(`fflogs_${stage}_invalid_json`);
  }
  if (payload.errors?.length) throw new Error(`fflogs_${stage}_graphql`);
  return payload;
}

function fflogsSafeErrorCode(error) {
  const message = String(error?.message || "");
  if (/^fflogs_token_(400|401|403|missing)/.test(message))
    return "fflogs_auth_failed";
  if (/^fflogs_token_/.test(message)) return "fflogs_auth_unavailable";
  if (/^fflogs_metadata_/.test(message)) return "fflogs_metadata_failed";
  if (/^fflogs_rankings_/.test(message)) return "fflogs_rankings_failed";
  return "fflogs_unavailable";
}

function fflogsZoneMetadataQuery(catalog = FFLOGS_RAID_TIER_CATALOG) {
  return `query RaidTierMetadata {\n  worldData {\n    ${catalog.map((tier) => `z${tier.zoneId}: zone(id: ${tier.zoneId}) { id name encounters { id name } }`).join("\n    ")}\n  }\n}`;
}

function fflogsMergeTierCatalog(baseCatalog, autoCatalog) {
  const map = new Map((baseCatalog || []).map((tier) => [Number(tier.zoneId), tier]));
  for (const tier of autoCatalog || []) {
    const zoneId = Number(tier?.zoneId);
    if (!Number.isInteger(zoneId) || zoneId <= 0 || map.has(zoneId)) continue;
    map.set(zoneId, { key: String(tier.key), label: String(tier.label), zoneId });
  }
  return [...map.values()];
}

function fflogsRaidTiersFromMetadata(worldData, catalog = FFLOGS_RAID_TIER_CATALOG) {
  return catalog.map((tier) => {
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

function fflogsPercentileValues(value) {
  return (Array.isArray(value?.ranks) ? value.ranks : [])
    .map((rank) => Number(rank?.rankPercent))
    .filter((percentile) => Number.isFinite(percentile));
}

function fflogsEncounterPerformance(value) {
  const average = Number(value?.averagePerformance);
  if (Number.isFinite(average)) return average;
  const percentiles = fflogsPercentileValues(value);
  if (!percentiles.length) return null;
  return percentiles.reduce((total, percentile) => total + percentile, 0) / percentiles.length;
}

function fflogsEncounterBestPerformance(value) {
  const explicitBest = [
    value?.bestPerformance,
    value?.bestPerformanceAverage,
    value?.bestPercent,
  ]
    .map((candidate) => Number(candidate))
    .find((candidate) => Number.isFinite(candidate));
  if (Number.isFinite(explicitBest)) return explicitBest;
  const percentiles = fflogsPercentileValues(value);
  if (percentiles.length) return Math.max(...percentiles);
  return fflogsEncounterPerformance(value);
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
      dps_best: fflogsEncounterBestPerformance(
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
  let response;
  try {
    response = await fetch(FFLOGS_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
    });
  } catch {
    throw new Error("fflogs_token_network");
  }
  if (!response.ok) throw new Error(`fflogs_token_${response.status}`);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("fflogs_token_invalid_json");
  }
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

export class HighEndCatalogStore {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async getPublicCatalog() {
    const groups = await this.ctx.storage.get("active_groups");
    const status = await this.ctx.storage.get("status");
    return {
      groups: sanitizeAutoGroups(groups),
      status: sanitizeAutoStatus(status),
    };
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/catalog") return json(await this.getPublicCatalog());
    if (path === "/fflogs-tiers") return json(await this.getFFLogsTiers());
    if (path === "/run" && request.method === "POST") return json(await this.runAutoUpdate());
    if (path === "/rollback" && request.method === "POST") return json({ rolled_back: await this.rollbackLatest() });
    return json({ error: "not_found" }, 404);
  }

  async getFFLogsTiers() {
    const groups = sanitizeAutoGroups(await this.ctx.storage.get("active_groups"));
    return groups
      .flatMap((group) => group.items || [])
      .filter((item) => item.fflogsTier && Number.isInteger(Number(item.fflogsZoneId)))
      .map((item) => ({
        key: String(item.fflogsTier),
        label: String(item.fflogsLabel || item.name),
        zoneId: Number(item.fflogsZoneId),
      }));
  }

  async runAutoUpdate() {
    if (this.running) return { skipped: true, reason: "in_memory_lock" };
    this.running = true;
    const now = Date.now();
    const previous = sanitizeAutoStatus(await this.ctx.storage.get("status"));
    const lease = await this.ctx.storage.get("run_lease");
    if (lease?.started_at && now - Date.parse(lease.started_at) < AUTO_SOURCE_TIMEOUT * 4) {
      this.running = false;
      return { skipped: true, reason: "lease_active" };
    }
    if (previous.last_started_at && now - Date.parse(previous.last_started_at) < AUTO_UPDATE_MIN_INTERVAL) {
      this.running = false;
      return { skipped: true, reason: "minimum_interval" };
    }
    await this.ctx.storage.put("run_lease", { started_at: new Date(now).toISOString() });
    await this.ctx.storage.put("status", {
      ...previous,
      state: "checking",
      last_started_at: new Date(now).toISOString(),
    });

    try {
        const sources = await fetchAutoCatalogSources(this.env);
        const activeGroups = sanitizeAutoGroups(await this.ctx.storage.get("active_groups"));
        const activeIds = new Set(activeGroups.flatMap((group) => group.items || []).map((item) => Number(item.id)));
        const pending = (await this.ctx.storage.get("pending_candidates")) || {};
        const audit = Array.isArray(await this.ctx.storage.get("audit_log")) ? await this.ctx.storage.get("audit_log") : [];
        const promoted = [];
        const rejected = [];
        const candidates = autoHighEndCandidates(sources.patchDocument);

        for (const candidate of candidates) {
          const key = autoCandidateKey(candidate);
          const match = autoMatchAchievement(candidate, sources.achievementsEn, sources.achievementsJa);
          const date = autoPatchReleaseDate(sources.patchDocument?.publishedAt);
          if (!date || !match || AUTO_BASELINE_ACHIEVEMENT_IDS.has(Number(match.id)) || activeIds.has(Number(match.id))) {
            rejected.push({ key, reason: !date ? "release_date_unverified" : !match ? "achievement_unverified" : "already_known" });
            delete pending[key];
            continue;
          }

          let fflogs = null;
          if (candidate.kind === "savage") {
            fflogs = autoMatchFFLogsZone(candidate, sources.fflogsZones);
            if (!fflogs) {
              rejected.push({ key, reason: "fflogs_zone_unverified" });
              delete pending[key];
              continue;
            }
          }

          const fingerprint = autoCandidateFingerprint(candidate, match, date, fflogs);
          const prior = pending[key];
          const confirmedAgain = prior && prior.fingerprint === fingerprint && now - Date.parse(prior.first_seen_at) >= AUTO_CONFIRMATION_INTERVAL;
          if (!confirmedAgain) {
            pending[key] = { fingerprint, first_seen_at: prior?.fingerprint === fingerprint ? prior.first_seen_at : new Date(now).toISOString(), last_seen_at: new Date(now).toISOString(), observed: Number(prior?.observed || 0) + 1 };
            continue;
          }

          promoted.push(autoCatalogItem(candidate, match, date, fflogs, sources.patchDocument));
          delete pending[key];
        }

        if (promoted.length > AUTO_MAX_PROMOTIONS_PER_RUN) throw new Error("promotion_limit_exceeded");
        const nextGroups = mergeAutoGroups(activeGroups, promoted);
        if (promoted.length) {
          const snapshots = Array.isArray(await this.ctx.storage.get("snapshots")) ? await this.ctx.storage.get("snapshots") : [];
          snapshots.unshift({ at: new Date(now).toISOString(), groups: activeGroups });
          await this.ctx.storage.put("snapshots", snapshots.slice(0, AUTO_SNAPSHOT_LIMIT));
          await this.ctx.storage.put("active_groups", nextGroups);
        }

        const status = {
          state: rejected.length ? "verified_with_quarantine" : "verified",
          last_started_at: new Date(now).toISOString(),
          last_success_at: new Date(now).toISOString(),
          last_patch: sources.patchDocument?.patch || null,
          last_patch_url: sources.patchDocument?.url || null,
          promoted: promoted.length,
          quarantined: rejected.length,
          message: promoted.length ? `${promoted.length}件を連続検証後に自動追加しました。` : rejected.length ? "候補は検証不足のため隔離し、公開カタログは変更しませんでした。" : "追加対象は検出されませんでした。",
        };
        audit.unshift({ at: status.last_success_at, patch: status.last_patch, promoted: promoted.map((item) => ({ id: item.id, name: item.name })), quarantined: rejected.slice(0, 12) });
        await this.ctx.storage.put("pending_candidates", pending);
        await this.ctx.storage.put("status", status);
        await this.ctx.storage.put("audit_log", audit.slice(0, 48));
        return status;
    } catch (error) {
        const status = {
          ...previous,
          state: "source_error",
          last_started_at: new Date(now).toISOString(),
          last_error_at: new Date(now).toISOString(),
          message: `自動同期は安全停止しました: ${autoSafeError(error)}`,
        };
        await this.ctx.storage.put("status", status);
        return status;
    } finally {
      await this.ctx.storage.delete("run_lease");
      this.running = false;
    }
  }

  async rollbackLatest() {
    const snapshots = Array.isArray(await this.ctx.storage.get("snapshots")) ? await this.ctx.storage.get("snapshots") : [];
    const snapshot = snapshots.shift();
    if (!snapshot) return false;
    await this.ctx.storage.put("active_groups", sanitizeAutoGroups(snapshot.groups));
    await this.ctx.storage.put("snapshots", snapshots);
    await this.ctx.storage.put("status", { state: "rolled_back", last_success_at: new Date().toISOString(), message: "直前の自動追加をロールバックしました。" });
    return true;
  }
}

async function getAutoFFLogsTiers(env) {
  if (!env.HIGH_END_CATALOG) return [];
  try {
    const response = await env.HIGH_END_CATALOG.getByName("global").fetch(new Request("https://auto-catalog.internal/fflogs-tiers"));
    if (!response.ok) return [];
    const payload = await response.json();
    return Array.isArray(payload) ? payload : [];
  } catch {
    return [];
  }
}

async function fetchAutoCatalogSources(env) {
  const topicIndex = await autoFetchText(AUTO_PATCH_TOPIC_URL);
  const paths = [...new Set([...topicIndex.matchAll(/\/lodestone\/topics\/detail\/([a-f0-9]{32,})/gi)].map((match) => match[0]))].slice(0, 12);
  const pages = await Promise.all(paths.map(async (path) => {
    try {
      const html = await autoFetchText(`https://jp.finalfantasyxiv.com${path}`);
      return autoOfficialPatchDocument(html, `https://jp.finalfantasyxiv.com${path}`);
    } catch {
      return null;
    }
  }));
  const patchDocument = pages.filter(Boolean).sort((a, b) => String(b.publishedAt || "").localeCompare(String(a.publishedAt || "")))[0] || null;
  if (!patchDocument) throw new Error("official_patch_note_not_found");
  const patchQuery = `&patch_eq=${encodeURIComponent(patchDocument.patch)}`;
  const [jaPayload, enPayload] = await Promise.all([autoFetchJson(`${AUTO_ACHIEVEMENTS_URL}${patchQuery}`), autoFetchJson(`${AUTO_ACHIEVEMENTS_EN_URL}${patchQuery}`)]);
  const achievementsJa = Array.isArray(jaPayload?.results) ? jaPayload.results : [];
  const achievementsEn = Array.isArray(enPayload?.results) ? enPayload.results : [];
  if (!achievementsJa.length || !achievementsEn.length) throw new Error("ffxivcollect_achievements_unavailable");
  return { patchDocument, achievementsJa, achievementsEn, fflogsZones: await autoFetchFFLogsZones(env) };
}

function autoTimeout(promise, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}_timeout`)), AUTO_SOURCE_TIMEOUT);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function autoFetchText(url) {
  const controller = new AbortController();
  try {
    const response = await autoTimeout(fetch(url, { headers: { "User-Agent": USER_AGENT, "Accept-Language": "ja,en;q=0.8", Accept: "text/html" }, signal: controller.signal }), "html_fetch");
    if (!response.ok) throw new Error(`source_http_${response.status}`);
    return autoTimeout(response.text(), "html_body");
  } finally {
    controller.abort();
  }
}

async function autoFetchJson(url) {
  const controller = new AbortController();
  try {
    const response = await autoTimeout(fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: controller.signal }), "json_fetch");
    if (!response.ok) throw new Error(`source_http_${response.status}`);
    return autoTimeout(response.json(), "json_body");
  } finally {
    controller.abort();
  }
}

function autoOfficialPatchDocument(html, url) {
  const title = decodeHtml((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").replace(/<[^>]*>/g, " ").trim();
  const patchMatch = title.match(/(?:Patch|パッチ)\s*(\d+\.\d+)/i);
  if (!patchMatch || !/(?:patch\s*\d+\.\d+\s*notes|パッチノート)/i.test(title)) return null;
  const dates = [...html.matchAll(/\b(20\d{2})[\/.\-](\d{1,2})[\/.\-](\d{1,2})\b/g)].map((match) => `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`);
  return { patch: patchMatch[1], title, url, publishedAt: dates[0] || null, text: autoPlainText(html) };
}

function autoPlainText(html) {
  return decodeHtml(String(html || "").replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ")).trim();
}

function autoHighEndCandidates(document) {
  if (!document?.text || !document?.patch) return [];
  const found = [];
  const patterns = [
    /The high-end duty\s+(.{2,120}?)\s+has been added\./gi,
    /(?:The\s+)?(.{2,120}?\((?:Criterion\s+)?Savage\))\s+has been added\./gi,
    /高難易度コンテンツ[「\s]+(.{2,120}?)[」\s]+(?:が追加|を追加)/gi,
    /(?:新たな|新しい)\s*(.{2,120}?(?:零式|異聞零式))\s*が追加されました/gi,
  ];
  for (const pattern of patterns) for (const match of document.text.matchAll(pattern)) {
    const name = String(match[1] || "").trim();
    const kind = autoHighEndKind(name);
    if (kind) found.push({ name, kind, patch: document.patch, sourceUrl: document.url });
  }
  const unique = new Map();
  found.forEach((candidate) => unique.set(autoCandidateKey(candidate), candidate));
  return [...unique.values()];
}

function autoHighEndKind(name) {
  const value = String(name || "");
  if (/\bultimate\b|（絶）|\(絶\)|絶/.test(value.toLowerCase()) || /絶/.test(value)) return "ultimate";
  if (/criterion\s+savage|異聞零式/i.test(value)) return "criterion";
  if (/\bsavage\b|零式/i.test(value)) return "savage";
  if (/詩想|unreal/i.test(value)) return "poetic";
  return null;
}

function autoMatchAchievement(candidate, achievementsEn, achievementsJa) {
  const jaById = new Map((achievementsJa || []).map((row) => [Number(row?.id), row]));
  const patch = String(candidate?.patch || "");
  const target = autoTokenSet(candidate?.name);
  const raidRows = (achievementsEn || []).filter((row) => String(row?.patch || "") === patch && /battle/i.test(String(row?.type?.name || "")) && /raid/i.test(String(row?.category?.name || "")));
  const scored = raidRows
    .map((row) => ({ row, score: autoTokenScore(target, `${row?.name || ""} ${row?.description || ""} ${row?.reward?.title?.name || ""}`) }))
    .filter((entry) => entry.score >= 2)
    .sort((a, b) => b.score - a.score);
  let selected = !scored.length || (scored[1] && scored[0].score === scored[1].score) ? null : scored[0].row;

  // 絶・異聞零式・零式は、同パッチの「バトル/レイド」かつ称号報酬の達成が一意である場合だけ補助照合する。
  // 複数候補がある場合は必ずnullを返し、公開せず隔離する。
  if (!selected) {
    const titleRewards = raidRows.filter((row) => row?.reward?.type === "Title" && String(row?.reward?.title?.name || "").trim());
    const japaneseCandidates = titleRewards.map((row) => jaById.get(Number(row.id))).filter(Boolean).filter((row) => {
      const name = String(row?.name || "");
      if (candidate.kind === "ultimate") return /絶/.test(name);
      if (candidate.kind === "criterion") return /異聞/.test(name);
      if (candidate.kind === "savage") return !/絶|異聞/.test(name);
      return false;
    });
    if (japaneseCandidates.length === 1) selected = titleRewards.find((row) => Number(row.id) === Number(japaneseCandidates[0].id)) || null;
  }
  if (!selected) return null;
  return jaById.get(Number(selected.id)) || null;
}

function autoTokenSet(value) {
  return [...new Set(String(value || "").toLowerCase().replace(/\([^)]*\)|（[^）]*）/g, " ").replace(/[^a-z0-9ぁ-んァ-ン一-龯]+/gi, " ").split(/\s+/).filter((token) => token.length >= 3))];
}

function autoTokenScore(tokens, value) {
  const normalized = String(value || "").toLowerCase();
  return tokens.reduce((score, token) => score + (normalized.includes(token) ? 1 : 0), 0);
}

function autoPatchReleaseDate(value) {
  return /^20\d{2}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : null;
}

async function autoFetchFFLogsZones(env) {
  if (!env?.FFLOGS_CLIENT_ID || !env?.FFLOGS_CLIENT_SECRET) return [];
  try {
    const token = await fflogsClientToken(env.FFLOGS_CLIENT_ID, env.FFLOGS_CLIENT_SECRET);
    const payload = await fflogsGraphQL(token, "query AutoZoneDiscovery { worldData { zones { id name encounters { id name } } } }", {}, "zone_discovery");
    const zones = payload?.data?.worldData?.zones;
    return Array.isArray(zones) ? zones.filter((zone) => Number.isInteger(Number(zone?.id)) && Array.isArray(zone?.encounters)) : [];
  } catch {
    return [];
  }
}

function autoMatchFFLogsZone(candidate, zones) {
  const tokens = autoTokenSet(candidate?.name);
  const scored = (zones || []).map((zone) => ({ zone, score: autoTokenScore(tokens, `${zone?.name || ""} ${(zone?.encounters || []).map((encounter) => encounter?.name || "").join(" ")}`) })).filter((entry) => entry.score >= 2).sort((a, b) => b.score - a.score);
  if (!scored.length || (scored[1] && scored[0].score === scored[1].score)) return null;
  const zoneId = Number(scored[0].zone.id);
  if (!Number.isInteger(zoneId) || zoneId <= 0 || !Array.isArray(scored[0].zone.encounters) || scored[0].zone.encounters.length < 4) return null;
  return { key: `auto-zone-${zoneId}`, label: String(scored[0].zone.name || candidate.name), zoneId };
}

function autoCandidateKey(candidate) {
  return `${candidate?.patch || ""}|${candidate?.kind || ""}|${String(candidate?.name || "").toLowerCase()}`;
}

function autoCandidateFingerprint(candidate, achievement, released, fflogs) {
  return JSON.stringify({ key: autoCandidateKey(candidate), id: Number(achievement?.id), released, fflogs: fflogs ? { key: fflogs.key, zoneId: fflogs.zoneId } : null });
}

function autoCatalogItem(candidate, achievement, released, fflogs, document) {
  return {
    id: Number(achievement.id),
    name: String(achievement.name || candidate.name),
    patch: String(candidate.patch),
    released,
    title: String(achievement?.reward?.title?.name || ""),
    category: autoCatalogCategory(candidate.kind),
    fflogsTier: fflogs?.key || "",
    fflogsZoneId: Number(fflogs?.zoneId) || null,
    fflogsLabel: String(fflogs?.label || ""),
    auto: true,
    source_url: String(document?.url || candidate.sourceUrl || ""),
    verified_at: new Date().toISOString(),
  };
}

function autoCatalogCategory(kind) {
  return ({ ultimate: "自動追加：絶シリーズ", savage: "自動追加：零式", criterion: "自動追加：異聞零式", poetic: "自動追加：詩想シリーズ" })[kind] || "自動追加：高難易度";
}

function mergeAutoGroups(groups, items) {
  const map = new Map(sanitizeAutoGroups(groups).map((group) => [group.category, { ...group, items: [...group.items] }]));
  for (const item of items) {
    const category = String(item.category || "自動追加：高難易度");
    const group = map.get(category) || { category, items: [] };
    if (!group.items.some((existing) => Number(existing.id) === Number(item.id))) group.items.push(item);
    map.set(category, group);
  }
  return [...map.values()].map((group) => ({ ...group, items: group.items.sort((a, b) => Number(a.id) - Number(b.id)) }));
}

function sanitizeAutoGroups(value) {
  if (!Array.isArray(value)) return [];
  return value.map((group) => ({ category: String(group?.category || "自動追加：高難易度"), items: Array.isArray(group?.items) ? group.items.filter((item) => Number.isInteger(Number(item?.id)) && Number(item.id) > 0 && /^20\d{2}-\d{2}-\d{2}$/.test(String(item?.released || ""))).map((item) => ({ ...item, id: Number(item.id) })) : [] })).filter((group) => group.items.length);
}

function sanitizeAutoStatus(value) {
  const raw = value && typeof value === "object" ? value : {};
  return { state: String(raw.state || "not_synced"), last_started_at: raw.last_started_at || null, last_success_at: raw.last_success_at || null, last_error_at: raw.last_error_at || null, last_patch: raw.last_patch || null, last_patch_url: raw.last_patch_url || null, promoted: Number(raw.promoted || 0), quarantined: Number(raw.quarantined || 0), message: String(raw.message || "自動同期は未実行です。") };
}

function autoSafeError(error) {
  return String(error?.message || "unknown_error").replace(/[^a-z0-9_\-:.]/gi, "").slice(0, 80) || "unknown_error";
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
  fflogsEncounterBestPerformance,
  fflogsTierPerformanceRows,
  fflogsSafeErrorCode,
  fflogsZoneMetadataQuery,
  fflogsMergeTierCatalog,
  autoOfficialPatchDocument,
  autoHighEndCandidates,
  autoMatchAchievement,
  autoMatchFFLogsZone,
  mergeAutoGroups,
  sanitizeAutoGroups,
};
