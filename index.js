"use strict";

const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const speakeasy = require("speakeasy");
const QRCode = require("qrcode");
const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 51300;
const ADDON_ID = "org.hubbio.addon";
const tmdbImageBase = "https://image.tmdb.org/t/p/w342";
const tmdbProviders = {
  netflix: 8,
  disney: 337,
  hulu: 15,
  prime: 9,
  apple: 350,
  max: 1899,
  trakt: null // handled separately via Trakt API
};

const isPublicPath = (req) => {
  const p = req.path || "";
  return (
    p === "/manifest.json" ||
    p.startsWith("/auth") ||
    p === "/login" ||
    p.startsWith("/manifest") ||
    p.startsWith("/manifest.json")
  );
};

const requireSession = (req, res, next) => {
  if (isPublicPath(req)) return next();
  if (!authData) {
    // allow setup only
    return res.redirect("/login");
  }
  if (req.session && req.session.authenticated) return next();
  return res.redirect("/login");
};

const requireWebAuth = requireSession;

const demoStreams = {
  "hubbio:sample-movie": [
    {
      title: "Hubbio Sample (MP4)",
      url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4"
    }
  ],
  "hubbio:sample-hls": [
    {
      title: "Hubbio Sample (HLS)",
      url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"
    }
  ]
};

const providerDefs = [
  { slug: "global", name: "Global" },
  { slug: "netflix", name: "Netflix" },
  { slug: "disney", name: "Disney+" },
  { slug: "hulu", name: "Hulu" },
  { slug: "prime", name: "Prime Video" },
  { slug: "apple", name: "Apple TV+" },
  { slug: "max", name: "Max" },
  { slug: "trakt", name: "Trakt", requiresTrakt: true }
];

const categoryDefs = [
  { key: "trending", name: "Trending" },
  { key: "popular", name: "Popular" },
  { key: "recent", name: "Recently Added" },
  { key: "random", name: "Random" }
];

const typeDefs = [
  { key: "movie", label: "Movies" },
  { key: "series", label: "Series" }
];

const builtinCatalogs = [];
providerDefs.forEach((provider) => {
  categoryDefs.forEach((category) => {
    // Only allow trending for global, popular/recent for others
    if (provider.slug !== "global" && category.key === "trending") return;
    typeDefs.forEach((t) => {
      builtinCatalogs.push({
        id: `builtin:${provider.slug}:${category.key}:${t.key}`,
        name: `${provider.name} ${category.name} ${t.label}`,
        type: t.key,
        provider: provider.slug,
        category: category.key
      });
    });
  });
});

const confidentialDir = path.join(__dirname, "Confidential");
const templateDir = path.join(__dirname, "Template");
const addonStoreFile = path.join(confidentialDir, "addons.json");
const addonTemplateFile = path.join(templateDir, "addons.json.template");
const cacheStoreFile = path.join(confidentialDir, "streams-cache.json");
const cacheTemplateFile = path.join(templateDir, "streams-cache.json.template");
const logStoreFile = path.join(confidentialDir, "logs.json");
const logTemplateFile = path.join(templateDir, "logs.json.template");
const configStoreFile = path.join(confidentialDir, "config.json");
const configTemplateFile = path.join(templateDir, "config.json.template");
const statsStoreFile = path.join(confidentialDir, "stats.json");
const statsTemplateFile = path.join(templateDir, "stats.json.template");
const authStoreFile = path.join(confidentialDir, "auth.json");
const authTemplateFile = path.join(templateDir, "auth.json.template");
const addonCategories = ["streams", "catalog", "meta", "subtitles", "other"];

const manifest = {
  id: ADDON_ID,
  version: "0.1.3",
  name: "Hubbio Streams",
  description: "Hubbio streaming addon (streams + catalogs + meta + subtitles)",
  resources: ["stream", "catalog", "meta", "subtitles"],
  catalogs: builtinCatalogs.map((c) => ({
    id: c.id,
    type: c.type,
    name: c.name,
    extra: [{ name: "skip", isRequired: false }]
  })),
  types: ["movie", "series", "tv"],
  // Support common meta IDs (imdb/tmdb)
  idPrefixes: ["tt", "tmdb", "tmdb:"],
  behaviorHints: { configurable: false }
};

const builder = new addonBuilder(manifest);

const ensureFilesystemLayout = () => {
  try {
    fs.mkdirSync(templateDir, { recursive: true });
    if (!fs.existsSync(addonTemplateFile)) {
      fs.writeFileSync(addonTemplateFile, "", "utf8");
    }
    if (!fs.existsSync(cacheTemplateFile)) {
      fs.writeFileSync(cacheTemplateFile, "", "utf8");
    }
    if (!fs.existsSync(logTemplateFile)) {
      fs.writeFileSync(logTemplateFile, "", "utf8");
    }
    if (!fs.existsSync(configTemplateFile)) {
      fs.writeFileSync(configTemplateFile, "", "utf8");
    }
    if (!fs.existsSync(statsTemplateFile)) {
      fs.writeFileSync(statsTemplateFile, "", "utf8");
    }
    if (!fs.existsSync(authTemplateFile)) {
      fs.writeFileSync(authTemplateFile, "", "utf8");
    }
    fs.mkdirSync(confidentialDir, { recursive: true });
    if (!fs.existsSync(addonStoreFile)) {
      fs.writeFileSync(addonStoreFile, "[]", "utf8");
    }
    if (!fs.existsSync(cacheStoreFile)) {
      fs.writeFileSync(cacheStoreFile, "{}", "utf8");
    }
    if (!fs.existsSync(logStoreFile)) {
      fs.writeFileSync(logStoreFile, "[]", "utf8");
    }
    if (!fs.existsSync(configStoreFile)) {
      fs.writeFileSync(configStoreFile, "{}", "utf8");
    }
    if (!fs.existsSync(statsStoreFile)) {
      fs.writeFileSync(statsStoreFile, "{}", "utf8");
    }
    if (!fs.existsSync(authStoreFile)) {
      fs.writeFileSync(authStoreFile, "", "utf8");
    }
  } catch (_err) {
    // ignore failures; downstream read/write will handle errors
  }
};

const readStoredAddons = () => {
  try {
    const raw = fs.readFileSync(addonStoreFile, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch (_err) {
    // ignore read/parse errors; fall back to empty
  }
  return [];
};

const writeStoredAddons = (addons) => {
  try {
    fs.mkdirSync(confidentialDir, { recursive: true });
    fs.writeFileSync(addonStoreFile, JSON.stringify(addons, null, 2), "utf8");
  } catch (_err) {
    // ignore persistence errors in runtime path
  }
};

ensureFilesystemLayout();
const normalizeAddon = (addon) => {
  const category = addon.category && addonCategories.includes(addon.category) ? addon.category : "streams";
  return { ...addon, category };
};

const installedAddons = readStoredAddons().map(normalizeAddon);
let streamCache = {};
try {
  const rawCache = fs.readFileSync(cacheStoreFile, "utf8");
  const parsed = JSON.parse(rawCache);
  if (parsed && typeof parsed === "object") streamCache = parsed;
} catch (_err) {
  streamCache = {};
}

let logs = [];
try {
  const rawLogs = fs.readFileSync(logStoreFile, "utf8");
  const parsed = JSON.parse(rawLogs);
  if (Array.isArray(parsed)) logs = parsed;
} catch (_err) {
  logs = [];
}

let stats = {};
try {
  const rawStats = fs.readFileSync(statsStoreFile, "utf8");
  const parsed = JSON.parse(rawStats);
  if (parsed && typeof parsed === "object") stats = parsed;
} catch (_err) {
  stats = {};
}
const getStatsStore = () => {
  const defaults = {
    items: {},
    ipCounts: {},
    totalRequests: 0,
    totalErrors: 0,
    totalResponseTime: 0,
    responseSamples: 0,
    errors: []
  };
  if (!stats || typeof stats !== "object") stats = defaults;
  stats.items = stats.items && typeof stats.items === "object" ? stats.items : {};
  stats.ipCounts = stats.ipCounts && typeof stats.ipCounts === "object" ? stats.ipCounts : {};
  stats.totalRequests = Number(stats.totalRequests) || 0;
  stats.totalErrors = Number(stats.totalErrors) || 0;
  stats.totalResponseTime = Number(stats.totalResponseTime) || 0;
  stats.responseSamples = Number(stats.responseSamples) || 0;
  stats.errors = Array.isArray(stats.errors) ? stats.errors : [];
  return stats;
};
getStatsStore();

let authData = null;
try {
  const rawAuth = fs.readFileSync(authStoreFile, "utf8");
  const parsed = rawAuth ? JSON.parse(rawAuth) : null;
  if (parsed && parsed.passwordHash && parsed.totpSecret) authData = parsed;
} catch (_err) {
  authData = null;
}

const saveAuthData = (data) => {
  authData = data;
  try {
    fs.writeFileSync(authStoreFile, JSON.stringify(authData, null, 2), "utf8");
  } catch (_err) {
    // ignore
  }
};

let pendingTotpSecret = null;

const cacheKey = (type, id) => `${type}:${id}`;
const cacheId = (type, id) => crypto.createHash("sha1").update(cacheKey(type, id)).digest("base64url");

const writeCache = () => {
  try {
    fs.mkdirSync(confidentialDir, { recursive: true });
    fs.writeFileSync(cacheStoreFile, JSON.stringify(streamCache, null, 2), "utf8");
  } catch (_err) {
    // ignore persistence errors
  }
};

const writeStats = () => {
  try {
    fs.mkdirSync(confidentialDir, { recursive: true });
    fs.writeFileSync(statsStoreFile, JSON.stringify(getStatsStore(), null, 2), "utf8");
  } catch (_err) {
    // ignore persistence errors
  }
};

let config = {};
try {
  const rawConfig = fs.readFileSync(configStoreFile, "utf8");
  const parsed = JSON.parse(rawConfig);
  if (parsed && typeof parsed === "object") config = parsed;
} catch (_err) {
  config = {};
}
const ensureConfigDefaults = () => {
  config.builtins = config.builtins && typeof config.builtins === "object" ? config.builtins : {};
  builtinCatalogs.forEach((c) => {
    if (typeof config.builtins[c.id] !== "boolean") config.builtins[c.id] = false;
  });
  config.traktClientId = config.traktClientId || "";
  config.traktClientSecret = config.traktClientSecret || "";
  config.traktAccessToken = config.traktAccessToken || "";
  config.opensubtitlesApiKey = config.opensubtitlesApiKey || "";
};
ensureConfigDefaults();

const catalogMetaCache = new Map();

const writeConfig = () => {
  try {
    fs.mkdirSync(confidentialDir, { recursive: true });
    fs.writeFileSync(configStoreFile, JSON.stringify(config, null, 2), "utf8");
  } catch (_err) {
    // ignore persistence errors
  }
};

const writeLogs = () => {
  try {
    fs.mkdirSync(confidentialDir, { recursive: true });
    fs.writeFileSync(logStoreFile, JSON.stringify(logs, null, 2), "utf8");
  } catch (_err) {
    // ignore persistence errors
  }
};

const logEvent = (type, message, meta = {}) => {
  const entry = {
    id: crypto.randomUUID(),
    type,
    message,
    meta,
    ts: new Date().toISOString()
  };
  logs.push(entry);
  if (logs.length > 500) logs = logs.slice(-500);
  writeLogs();
};

const ensureManifestPath = (path) => {
  if (!path || path === "/") return "/manifest.json";
  if (path.includes("manifest.json")) return path;
  return `${path.replace(/\/$/, "")}/manifest.json`;
};

const normalizeManifestUrl = (rawUrl) => {
  const input = String(rawUrl || "").trim();
  if (!input) throw new Error("Empty URL");

  if (input.startsWith("stremio://")) {
    const converted = input.replace(/^stremio:\/\//, "https://");
    const url = new URL(converted);
    url.pathname = ensureManifestPath(url.pathname);
    return url.toString();
  }

  const url = new URL(input);
  if (!url.protocol.startsWith("http")) throw new Error("Unsupported protocol");
  url.pathname = ensureManifestPath(url.pathname);
  return url.toString();
};

const makeAddonId = (manifestUrl) =>
  `addon-${Buffer.from(manifestUrl).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;

const getBaseFromManifest = (manifestUrl) => {
  const idx = manifestUrl.indexOf("manifest.json");
  if (idx >= 0) return manifestUrl.slice(0, idx);
  return manifestUrl.endsWith("/") ? manifestUrl : `${manifestUrl}/`;
};

const buildStreamUrl = (manifestUrl, type, id) => {
  const base = getBaseFromManifest(manifestUrl);
  return `${base}stream/${type}/${encodeURIComponent(id)}.json`;
};

const fetchJson = async (url, { timeoutMs = 8000 } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
};

const fetchAddonStreams = async (addon, type, id) => {
  const attemptUrls = [
    buildStreamUrl(addon.manifestUrl, type, id),
    // some addons omit .json
    buildStreamUrl(addon.manifestUrl, type, id).replace(/\.json$/, "")
  ];

  for (const url of attemptUrls) {
    const payload = await fetchJson(url).catch(() => null);
    if (payload && Array.isArray(payload.streams)) return payload.streams;
  }
  return [];
};

const parseMetaTokens = (metaId) => {
  if (!metaId) return { base: "", raw: "" };
  const raw = String(metaId);
  const base = raw.split(":")[0]; // handle tt123:s:e or tmdb:123
  return { base, raw };
};

const fetchTmdbMeta = async (type, metaId) => {
  if (!config.tmdbApiKey) return null;
  const { base } = parseMetaTokens(metaId);
  if (!base) return null;

  const apiKey = encodeURIComponent(config.tmdbApiKey);
  const isTv = type === "series" || type === "tv";

  // imdb id
  if (/^tt\d+$/i.test(base)) {
    const url = `https://api.themoviedb.org/3/find/${base}?api_key=${apiKey}&external_source=imdb_id`;
    const data = await fetchJson(url, { timeoutMs: 6000 }).catch(() => null);
    if (!data) return null;
    const pick =
      (isTv ? data.tv_results?.[0] : null) ||
      data.movie_results?.[0] ||
      data.tv_results?.[0];
    if (!pick) return null;
    return {
      title: pick.title || pick.name || "",
      poster: pick.poster_path ? `${tmdbImageBase}${pick.poster_path}` : ""
    };
  }

  // explicit tmdb id
  const tmdbMatch = base.match(/^tmdb:(\d+)$/i) || base.match(/^(\d+)$/);
  if (!tmdbMatch) return null;
  const tmdbId = tmdbMatch[1];
  const kind = isTv ? "tv" : "movie";
  const url = `https://api.themoviedb.org/3/${kind}/${tmdbId}?api_key=${apiKey}`;
  const data = await fetchJson(url, { timeoutMs: 6000 }).catch(() => null);
  if (!data) return null;
  return {
    title: data.title || data.name || "",
    poster: data.poster_path ? `${tmdbImageBase}${data.poster_path}` : ""
  };
};

const fetchTmdbMetaFull = async (type, metaId) => {
  if (!config.tmdbApiKey) return null;
  const { base } = parseMetaTokens(metaId);
  if (!base) return null;
  const apiKey = encodeURIComponent(config.tmdbApiKey);
  const isTv = type === "series" || type === "tv";

  let tmdbId = null;
  if (/^tt\d+$/i.test(base)) {
    const url = `https://api.themoviedb.org/3/find/${base}?api_key=${apiKey}&external_source=imdb_id`;
    const data = await fetchJson(url, { timeoutMs: 6000 }).catch(() => null);
    const pick =
      (isTv ? data?.tv_results?.[0] : null) ||
      data?.movie_results?.[0] ||
      data?.tv_results?.[0];
    if (!pick) return null;
    tmdbId = pick.id;
  } else {
    const tmdbMatch = base.match(/^tmdb:(\d+)$/i) || base.match(/^(\d+)$/);
    if (!tmdbMatch) return null;
    tmdbId = tmdbMatch[1];
  }

  const url = `https://api.themoviedb.org/3/${isTv ? "tv" : "movie"}/${tmdbId}?api_key=${apiKey}`;
  const data = await fetchJson(url, { timeoutMs: 6000 }).catch(() => null);
  if (!data) return null;
  return {
    id: metaId,
    type,
    name: data.title || data.name || "",
    poster: data.poster_path ? `${tmdbImageBase}${data.poster_path}` : null,
    background: data.backdrop_path ? `https://image.tmdb.org/t/p/original${data.backdrop_path}` : null,
    description: data.overview || "",
    releaseInfo: (data.release_date || data.first_air_date || "").slice(0, 4),
    runtime: data.runtime || (data.episode_run_time ? data.episode_run_time[0] : null),
    imdbRating: data.vote_average
  };
};

const formatCatalogItems = (results, type) =>
  (results || []).map((item) => ({
    id: `tmdb:${item.id}`,
    type,
    name: item.title || item.name,
    poster: item.poster_path ? `${tmdbImageBase}${item.poster_path}` : null,
    background: item.backdrop_path ? `https://image.tmdb.org/t/p/original${item.backdrop_path}` : null,
    year: (item.release_date || item.first_air_date || "").slice(0, 4),
    description: item.overview || ""
  }));

const fetchCatalogItems = async (catalog, page = 1) => {
  const tmdbType = catalog.type === "series" ? "tv" : "movie";
  const apiKey = encodeURIComponent(config.tmdbApiKey || "");
  const today = new Date();
  const thirtyDaysAgo = new Date(today);
  thirtyDaysAgo.setDate(today.getDate() - 30);
  const dateFrom = thirtyDaysAgo.toISOString().split("T")[0];
  const dateTo = today.toISOString().split("T")[0];

  if (catalog.provider === "trakt") {
    if (!config.traktClientId || !config.traktAccessToken) return [];
    const traktType = catalog.type === "series" ? "shows" : "movies";
    let url = "";
    switch (catalog.category) {
      case "trending":
        url = `https://api.trakt.tv/${traktType}/trending?page=${page}&limit=50`;
        break;
      case "popular":
        url = `https://api.trakt.tv/${traktType}/popular?page=${page}&limit=50`;
        break;
      case "recent":
        url = `https://api.trakt.tv/${traktType}/updates?page=${page}&limit=50`;
        break;
      case "random": {
        const randPage = Math.max(1, Math.floor(Math.random() * 10));
        url = `https://api.trakt.tv/${traktType}/popular?page=${randPage}&limit=50`;
        break;
      }
      default:
        return [];
    }
    const payload = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        "trakt-api-version": "2",
        "trakt-api-key": config.traktClientId,
        Authorization: `Bearer ${config.traktAccessToken}`
      }
    }).then((r) => r.json()).catch(() => null);
    if (!payload) return [];
    const items = Array.isArray(payload)
      ? payload.map((p) => p.show || p.movie || p)
      : [];
    return items
      .map((item) => {
        const ids = item.ids || {};
        const tmdbId = ids.tmdb;
        const imdbId = ids.imdb;
        const metaId = tmdbId ? `tmdb:${tmdbId}` : imdbId || null;
        if (!metaId) return null;
        return {
          id: metaId,
          type: catalog.type,
          name: item.title || "Unknown",
          poster: item.images?.poster || null,
          background: item.images?.fanart || null,
          description: item.overview || ""
        };
      })
      .filter(Boolean);
  }

  let url = "";
  switch (catalog.category) {
    case "trending":
      url = `https://api.themoviedb.org/3/trending/${tmdbType}/day?api_key=${apiKey}&page=${page}`;
      break;
    case "popular":
      if (catalog.provider && catalog.provider !== "global" && tmdbProviders[catalog.provider]) {
        url = `https://api.themoviedb.org/3/discover/${tmdbType}?api_key=${apiKey}&language=en-US&sort_by=popularity.desc&with_watch_providers=${tmdbProviders[catalog.provider]}&watch_region=US&page=${page}`;
      } else {
        url = `https://api.themoviedb.org/3/${tmdbType}/popular?api_key=${apiKey}&page=${page}`;
      }
      break;
    case "recent":
      url = `https://api.themoviedb.org/3/discover/${tmdbType}?api_key=${apiKey}&language=en-US&sort_by=release_date.desc&release_date.gte=${dateFrom}&release_date.lte=${dateTo}&watch_region=US&page=${page}`;
      if (catalog.provider && catalog.provider !== "global" && tmdbProviders[catalog.provider]) {
        url += `&with_watch_providers=${tmdbProviders[catalog.provider]}`;
      }
      break;
    case "random": {
      const randPage = Math.max(1, Math.floor(Math.random() * 50));
      if (catalog.provider && catalog.provider !== "global" && tmdbProviders[catalog.provider]) {
        url = `https://api.themoviedb.org/3/discover/${tmdbType}?api_key=${apiKey}&language=en-US&sort_by=popularity.desc&with_watch_providers=${tmdbProviders[catalog.provider]}&watch_region=US&page=${randPage}`;
      } else {
        url = `https://api.themoviedb.org/3/${tmdbType}/popular?api_key=${apiKey}&page=${randPage}`;
      }
      break;
    }
    default:
      return [];
  }

  const payload = await fetchJson(url).catch(() => null);
  if (!payload || !payload.results) return [];
  const metas = formatCatalogItems(payload.results, catalog.type);
  metas.forEach((m) => {
    catalogMetaCache.set(m.id, m);
  });
  return metas;
};

const recordRequest = async (type, metaId, source, opts = {}) => {
  const store = getStatsStore();
  const key = cacheKey(type, metaId);
  const entry = store.items[key] || {
    id: cacheId(type, metaId),
    type,
    metaId,
    count: 0
  };
  entry.count = (entry.count || 0) + 1;
  entry.lastRequested = new Date().toISOString();
  entry.source = source || entry.source || "";
  if (config.tmdbApiKey && (!entry.meta || !entry.meta.title)) {
    const meta = await fetchTmdbMeta(type, metaId).catch(() => null);
    if (meta) entry.meta = meta;
  }
  store.items[key] = entry;
  stats = store;
  writeStats();
};

builder.defineStreamHandler(async ({ type, id }) => {
  const key = cacheKey(type, id);
  const cached = streamCache[key];
  if (cached && Array.isArray(cached.streams)) {
    logEvent("cache-hit", "Returning cached streams", { type, id, streams: cached.streams.length });
    await recordRequest(type, id, "cache");
    return { streams: cached.streams };
  }

  logEvent("stream-request", "Fetching streams from installed addons", { type, id, addons: installedAddons.length });
  const aggregated = [];
  for (const addon of installedAddons) {
    try {
      const streams = await fetchAddonStreams(addon, type, id);
      aggregated.push(...streams);
      if (streams.length) {
        logEvent("addon-streams", "Addon returned streams", {
          addon: addon.name,
          manifestUrl: addon.manifestUrl,
          count: streams.length,
          type,
          id
        });
      }
    } catch (err) {
      logEvent("addon-error", "Addon fetch failed", {
        addon: addon.name,
        manifestUrl: addon.manifestUrl,
        error: err.message,
        type,
        id
      });
    }
  }

  if (aggregated.length > 0) {
    let meta = null;
    if (config.tmdbApiKey) {
      meta = await fetchTmdbMeta(type, id).catch(() => null);
    }
    streamCache[key] = {
      id: cacheId(type, id),
      type,
      metaId: id,
      streams: aggregated,
      updatedAt: new Date().toISOString(),
      meta
    };
    writeCache();
    logEvent("cache-store", "Caching streams", { type, id, streams: aggregated.length });
    await recordRequest(type, id, "addons");
    return { streams: aggregated };
  }

  const fallback =
    demoStreams[id] ||
    [
      {
        title: "Hubbio Sample (HLS)",
        url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"
      }
    ];
  if (fallback.length === 0) {
    logEvent("streams-miss", "No streams found", { type, id });
  }
  await recordRequest(type, id, fallback.length ? "demo" : "empty");
  return { streams: fallback };
});

builder.defineCatalogHandler(async ({ id, type }) => {
  const catalog = builtinCatalogs.find((c) => c.id === id && c.type === type);
  if (!catalog) return { metas: [] };
  ensureConfigDefaults();
  const enabled = config.builtins[catalog.id];
  if (!enabled) return { metas: [] };
  if (!config.tmdbApiKey) return { metas: [] };
  const metas = await fetchCatalogItems(catalog, 1);
  return { metas };
});

builder.defineMetaHandler(async ({ id, type }) => {
  const cached = catalogMetaCache.get(id);
  if (cached) {
    return {
      meta: {
        id,
        type,
        name: cached.name || cached.title || "Unknown",
        poster: cached.poster || null,
        background: cached.background || null,
        description: cached.description || ""
      }
    };
  }
  const meta = await fetchTmdbMetaFull(type, id).catch(() => null);
  if (meta) return { meta };
  return { meta: { id, type, name: "Unknown", poster: null } };
});

builder.defineSubtitlesHandler(async ({ type, id }) => {
  if (!config.opensubtitlesApiKey) {
    return { subtitles: [] };
  }
  // Placeholder: return sample subtitle entry. Replace with real OpenSubtitles lookup if needed.
  return {
    subtitles: [
      {
        id: `os-sample-${id}`,
        lang: "eng",
        url: "https://raw.githubusercontent.com/opensubtitles/api-examples/master/subtitles/helloworld.srt",
        name: "Sample (OpenSubtitles)"
      }
    ]
  };
});

const app = express();
app.use(express.json());
const sessionSecret = (authData && authData.sessionSecret) || crypto.randomBytes(32).toString("hex");
app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 6 } // 6 hours
  })
);
const router = getRouter(builder.getInterface());

// Basic request logger
app.use((req, _res, next) => {
  logEvent("request", "Incoming request", { method: req.method, url: req.originalUrl });
  next();
});

// Stats collector
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    const store = getStatsStore();
    store.totalRequests += 1;
    store.totalResponseTime += duration;
    store.responseSamples += 1;
    store.ipCounts[req.ip] = (store.ipCounts[req.ip] || 0) + 1;

    if (res.statusCode >= 400) {
      store.totalErrors += 1;
      store.errors.push({
        ts: new Date().toISOString(),
        ip: req.ip,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode
      });
      if (store.errors.length > 200) store.errors = store.errors.slice(-200);
    }

    const match = req.path.match(/\/stream\/([^/]+)\/([^/.]+)$/);
    if (match) {
      const type = match[1];
      const metaId = decodeURIComponent(match[2]);
      recordRequest(type, metaId, "incoming").catch(() => {});
    }

    stats = store;
    writeStats();
  });
  next();
});

// Auth routes
app.get("/login", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/auth/status", (_req, res) => {
  res.json({ authenticated: !!(_req.session && _req.session.authenticated), setupNeeded: !authData });
});

app.get("/auth/setup-data", async (_req, res) => {
  if (authData) return res.status(400).json({ error: "already setup" });
  if (!pendingTotpSecret) {
    const secret = speakeasy.generateSecret({ name: "Hubbio" });
    pendingTotpSecret = secret.base32;
  }
  const otpauth = `otpauth://totp/Hubbio?secret=${pendingTotpSecret}`;
  const qrData = await QRCode.toDataURL(otpauth).catch(() => null);
  res.json({ secret: pendingTotpSecret, otpauth, qr: qrData });
});

app.post("/auth/setup", async (req, res) => {
  if (authData) return res.status(400).json({ error: "already setup" });
  const { password, token } = req.body || {};
  if (!password || !token || !pendingTotpSecret) return res.status(400).json({ error: "missing fields" });
  const ok = speakeasy.totp.verify({ secret: pendingTotpSecret, encoding: "base32", token });
  if (!ok) return res.status(400).json({ error: "invalid token" });
  const passwordHash = bcrypt.hashSync(password, 10);
  const sessionSecret = crypto.randomBytes(32).toString("hex");
  saveAuthData({ passwordHash, totpSecret: pendingTotpSecret, sessionSecret });
  pendingTotpSecret = null;
  req.session.authenticated = true;
  res.json({ ok: true });
});

app.post("/auth/login", (req, res) => {
  if (!authData) return res.status(400).json({ error: "not setup" });
  const { password, token } = req.body || {};
  if (!password || !token) return res.status(400).json({ error: "missing fields" });
  const validPwd = bcrypt.compareSync(password, authData.passwordHash);
  const validTotp = speakeasy.totp.verify({ secret: authData.totpSecret, encoding: "base32", token });
  if (!validPwd || !validTotp) return res.status(401).json({ error: "invalid credentials" });
  req.session.authenticated = true;
  res.json({ ok: true });
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// Web UI (gated by auth toggle)
app.use(requireSession, express.static("public"));

// Addons API (install external scrapers/manifest URLs)
app.get("/api/addons", requireWebAuth, (_req, res) => {
  res.json({ addons: installedAddons });
});

app.post("/api/addons", requireWebAuth, (req, res) => {
  const { url, name, category } = req.body || {};
  try {
    const manifestUrl = normalizeManifestUrl(url);
    const cat = addonCategories.includes(category) ? category : "streams";
    const existing = installedAddons.find((a) => a.manifestUrl === manifestUrl);
    if (existing) {
      if (name && name !== existing.name) existing.name = name;
      existing.category = cat || existing.category || "streams";
      writeStoredAddons(installedAddons);
      logEvent("addon-exists", "Addon already present", { manifestUrl, name: existing.name, category: existing.category });
      return res.status(200).json({ addon: existing, note: "already exists" });
    }
    const addon = {
      id: makeAddonId(manifestUrl),
      name: name || manifestUrl,
      manifestUrl,
      category: cat
    };
    installedAddons.push(addon);
    writeStoredAddons(installedAddons);
    logEvent("addon-add", "Addon added", { manifestUrl, name: addon.name, category: addon.category });
    res.status(201).json({ addon });
  } catch (err) {
    logEvent("addon-error", "Failed to add addon", { error: err.message });
    res.status(400).json({ error: err.message || "invalid url" });
  }
});

app.delete("/api/addons/:id", requireWebAuth, (req, res) => {
  const { id } = req.params;
  const idx = installedAddons.findIndex((a) => a.id === id);
  if (idx === -1) return res.status(404).json({ error: "not found" });
  logEvent("addon-remove", "Addon removed", { id: installedAddons[idx].id, manifestUrl: installedAddons[idx].manifestUrl });
  installedAddons.splice(idx, 1);
  writeStoredAddons(installedAddons);
  res.status(204).end();
});

app.get("/api/cache", requireWebAuth, async (_req, res) => {
  const entries = [];
  for (const [key, value] of Object.entries(streamCache)) {
    const entry = {
      key,
      id: value.id || cacheId(value.type, value.metaId || ""),
      type: value.type,
      metaId: value.metaId,
      streamsCount: Array.isArray(value.streams) ? value.streams.length : 0,
      updatedAt: value.updatedAt,
      meta: value.meta || null
    };
    if ((!entry.meta || !entry.meta.title) && config.tmdbApiKey) {
      const meta = await fetchTmdbMeta(entry.type, entry.metaId).catch(() => null);
      if (meta) {
        entry.meta = meta;
        streamCache[key] = { ...value, meta };
      }
    }
    entries.push(entry);
  }
  writeCache();
  res.json({ cache: entries });
});

app.get("/api/cache/:id", requireWebAuth, async (req, res) => {
  const { id } = req.params;
  const matchKey = Object.keys(streamCache).find((key) => {
    const entry = streamCache[key];
    return entry && (entry.id === id || cacheId(entry.type, entry.metaId || "") === id);
  });
  if (!matchKey) return res.status(404).json({ error: "not found" });
  const entry = streamCache[matchKey];
  if (!entry.meta && config.tmdbApiKey) {
    const meta = await fetchTmdbMeta(entry.type, entry.metaId).catch(() => null);
    if (meta) {
      entry.meta = meta;
      streamCache[matchKey] = entry;
      writeCache();
    }
  }
  res.json({
    id: entry.id || cacheId(entry.type, entry.metaId || ""),
    type: entry.type,
    metaId: entry.metaId,
    meta: entry.meta || null,
    updatedAt: entry.updatedAt,
    streams: entry.streams || []
  });
});

app.delete("/api/cache/:id/streams/:idx", requireWebAuth, (req, res) => {
  const { id, idx } = req.params;
  const index = Number(idx);
  if (Number.isNaN(index) || index < 0) return res.status(400).json({ error: "invalid index" });
  const matchKey = Object.keys(streamCache).find((key) => {
    const entry = streamCache[key];
    return entry && (entry.id === id || cacheId(entry.type, entry.metaId || "") === id);
  });
  if (!matchKey) return res.status(404).json({ error: "not found" });
  const entry = streamCache[matchKey];
  if (!Array.isArray(entry.streams) || index >= entry.streams.length) {
    return res.status(404).json({ error: "stream not found" });
  }
  entry.streams.splice(index, 1);
  entry.updatedAt = new Date().toISOString();
  streamCache[matchKey] = entry;
  writeCache();
  res.status(204).end();
});

app.get("/api/recent", requireWebAuth, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 300);
  const store = getStatsStore();
  const items = Object.values(store.items)
    .filter((v) => v.metaId)
    .sort((a, b) => new Date(b.lastRequested || 0) - new Date(a.lastRequested || 0))
    .slice(0, limit);

  for (const item of items) {
    if ((!item.meta || !item.meta.title) && config.tmdbApiKey) {
      const meta = await fetchTmdbMeta(item.type, item.metaId).catch(() => null);
      if (meta) {
        item.meta = meta;
        store.items[cacheKey(item.type, item.metaId)] = item;
      }
    }
  }
  stats = store;
  writeStats();
  res.json({
    recent: items,
    summary: {
      uniqueIps: Object.keys(store.ipCounts || {}).length,
      totalRequests: store.totalRequests || 0,
      totalErrors: store.totalErrors || 0,
      avgResponseTime:
        store.responseSamples > 0 ? Math.round(store.totalResponseTime / store.responseSamples) : 0
    },
    errors: (store.errors || []).slice(-50).reverse()
  });
});

app.delete("/api/cache/:id", requireWebAuth, (req, res) => {
  const { id } = req.params;
  const matchKey = Object.keys(streamCache).find((key) => {
    const entry = streamCache[key];
    return entry && (entry.id === id || cacheId(entry.type, entry.metaId || "") === id);
  });
  if (!matchKey) return res.status(404).json({ error: "not found" });
  delete streamCache[matchKey];
  writeCache();
  logEvent("cache-remove", "Removed cache entry", { id });
  res.status(204).end();
});

app.get("/api/logs", requireWebAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  const slice = logs.slice(-limit).reverse();
  res.json({ logs: slice });
});

app.delete("/api/logs", requireWebAuth, (_req, res) => {
  logs = [];
  writeLogs();
  res.status(204).end();
});

app.get("/api/config", requireWebAuth, (_req, res) => {
  res.json({ config });
});

app.post("/api/config", requireWebAuth, (req, res) => {
  const {
    tmdbApiKey,
    traktClientId,
    traktClientSecret,
    traktAccessToken,
    opensubtitlesApiKey
  } = req.body || {};
  config.tmdbApiKey = tmdbApiKey || "";
  config.traktClientId = traktClientId || "";
  config.traktClientSecret = traktClientSecret || "";
  config.traktAccessToken = traktAccessToken || "";
  config.opensubtitlesApiKey = opensubtitlesApiKey || "";
  ensureConfigDefaults();
  writeConfig();
  logEvent("config-update", "Config saved", {
    hasTmdbKey: !!tmdbApiKey,
    hasTraktClient: !!(traktClientId && traktClientSecret),
    hasTraktToken: !!traktAccessToken,
    hasOsApiKey: !!opensubtitlesApiKey
  });
  res.status(200).json({ config });
});

app.get("/api/builtins", requireWebAuth, (_req, res) => {
  ensureConfigDefaults();
  const list = builtinCatalogs.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    provider: c.provider,
    category: c.category,
    enabled: !!config.builtins[c.id],
    requiresTrakt: !!providerDefs.find((p) => p.slug === c.provider && p.requiresTrakt),
    available: c.provider === "trakt" ? !!(config.traktClientId && config.traktAccessToken) : true
  }));
  res.json({ catalogs: list });
});

app.post("/api/builtins", requireWebAuth, (req, res) => {
  const { id, enabled } = req.body || {};
  ensureConfigDefaults();
  const exists = builtinCatalogs.find((c) => c.id === id);
  if (!exists) return res.status(404).json({ error: "not found" });
  config.builtins[id] = !!enabled;
  writeConfig();
  res.json({ id, enabled: !!enabled });
});

// Simple status endpoint
app.get("/status", requireWebAuth, (_req, res) => {
  res.json({
    status: "ok",
    manifest: "/manifest.json",
    note: "Auth is disabled by default; set ENABLE_AUTH=true to require bearer auth for non-Stremio routes."
  });
});

// Stremio addon endpoints
app.use("/", router);

app.listen(PORT, () => {
  /* eslint-disable no-console */
  console.log(`Hubbio Stremio addon listening on http://localhost:${PORT}`);
  console.log("Manifest available at /manifest.json");
  console.log("Try stream id 'hubbio:sample-movie' or 'hubbio:sample-hls'");
  /* eslint-enable no-console */
});
