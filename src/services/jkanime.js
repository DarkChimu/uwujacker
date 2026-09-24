const cheerio = require("cheerio");
const { parseJsonSafe } = require("../utils/files");

const DEFAULT_BASE_URL = "https://jkanime.net";

function normalizeSlug(value) {
  if (!value) return "";
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function makeRequest(url, options = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    retries = 0,
    timeout = 30000,
    verbose = false,
    validateStatus = (status) => status >= 200 && status < 400,
  } = options;

  let attempt = 0;

  while (attempt <= retries) {
    try {
      // fetch has no built-in timeout: AbortSignal.timeout aborts the request
      // after `timeout` ms. It also does NOT reject on 4xx/5xx, so we honor the
      // caller's validateStatus explicitly, mirroring axios' behavior.
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeout),
      });

      if (!validateStatus(response.status)) {
        throw new Error(`Petición a ${url} devolvió estado ${response.status}`);
      }

      return {
        status: response.status,
        body: await response.text(),
        headers: Object.fromEntries(response.headers.entries()),
        // set-cookie must be read via getSetCookie(): headers.entries() folds
        // multiple Set-Cookie values into one comma-joined string, which breaks
        // cookie parsing. JKAnime's ajax_search needs the session cookie back.
        cookies: typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [],
      };
    } catch (error) {
      if (attempt >= retries) {
        throw error;
      }

      if (verbose) {
        console.warn(`Retrying request to ${url} (${attempt + 1}/${retries})`);
      }
      attempt += 1;
    }
  }

  throw new Error(`No se pudo completar la petición a ${url}`);
}

function resolveAbsoluteUrl(candidate, baseUrl = DEFAULT_BASE_URL) {
  if (!candidate) return null;
  const normalized = String(candidate).trim();

  if (/^https?:\/\//i.test(normalized)) {
    return normalized;
  }

  if (normalized.startsWith("//")) {
    return `https:${normalized}`;
  }

  if (normalized.startsWith("/") || normalized.startsWith("?")) {
    return `${baseUrl}${normalized.startsWith("/") ? "" : "/"}${normalized}`;
  }

  if (normalized.includes("jkplayer") || normalized.includes("stream") || normalized.includes("?u=")) {
    return `${baseUrl.replace(/\/$/, "")}/${normalized.replace(/^\//, "")}`;
  }

  return `${baseUrl.replace(/\/$/, "")}/${normalized.replace(/^\//, "")}`;
}

function normalizeVideoCandidate(candidate) {
  if (!candidate) return null;
  const trimmed = String(candidate).trim().replace(/[),;]+$/, "");
  return trimmed || null;
}

function extractPlayerUrlFromEpisodeHtml(html, server = "jk") {
  if (!html || typeof html !== "string") return null;

  // Gather every jkplayer URL on the page, then prefer the "jk" player: it
  // serves a direct mp4 (302 → CDN) that downloads without FFmpeg, whereas
  // um/umv/c1 return HLS (.m3u8). This is the opposite of the old order, which
  // forced HLS even when a direct file was available.
  // Note: longer alternatives first (umv before um) so the regex doesn't stop at
  // the "um" prefix of "umv" and truncate the URL.
  const all = [...html.matchAll(/(?:https?:\/\/[^"'\s<>]*)?\/?jkplayer\/(?:jk|umv|um|c1)(?:\?[^"'\s<>]*|\/[^"'\s<>]*)?/gi)]
    .map((m) => resolveAbsoluteUrl(normalizeVideoCandidate(m[0]), DEFAULT_BASE_URL))
    .filter(Boolean);

  const preferred = server && server !== "jk" ? server : "jk";
  const priority = [preferred, "jk", "umv", "um", "c1"];

  for (const key of priority) {
    const hit = all.find((url) => new RegExp(`/jkplayer/${key}(?:[?/]|$)`, "i").test(url));
    if (hit) return hit;
  }

  if (all.length) return all[0];

  const $ = cheerio.load(html);
  const iframe = $('iframe').first().attr("src");
  if (iframe) return resolveAbsoluteUrl(iframe, DEFAULT_BASE_URL);

  const scriptCandidates = [];
  $('script').each((_, element) => {
    const scriptContent = $(element).html() || "";
    if (scriptContent.includes("var video") || scriptContent.includes("jkplayer") || scriptContent.includes("stream")) {
      scriptCandidates.push(scriptContent);
    }
  });

  for (const script of scriptCandidates) {
    const match = script.match(/(?:https?:\/\/[^"'\s<>]+(?:stream|jkplayer)[^"'\s<>]*)|(?:\/jkplayer\/(?:um|umv|c1|jk)[^"'\s<>]*)/i);
    if (match) {
      const resolved = resolveAbsoluteUrl(match[0], DEFAULT_BASE_URL);
      if (resolved && resolved.includes("jkplayer")) return resolved;
    }
  }

  return null;
}

function extractMediaUrlFromPlayerHtml(html) {
  if (!html || typeof html !== "string") return null;

  // Collect ALL media candidates with their declared kind, then pick the best.
  // A direct file (mp4/mkv/webm) always wins over an HLS (.m3u8) playlist so we
  // avoid FFmpeg when a plain container is available. Crucially, JKAnime's "jk"
  // player exposes a DPlayer block like `video: { url: '...', type: 'mp4' }`
  // whose URL has NO file extension (it 302-redirects to a CDN), so we must
  // trust the declared `type` — matching on extension alone would miss it.
  const candidates = [];

  const add = (value, kind) => {
    const normalized = normalizeVideoCandidate(value);
    if (normalized) candidates.push({ url: normalized, kind });
  };

  // 1) DPlayer-style object: capture url + its declared type together.
  //    e.g. video: { url: 'https://.../', type: 'mp4' }
  for (const m of html.matchAll(/\burl\s*:\s*["']([^"']+)["']\s*,\s*type\s*:\s*["']([^"']+)["']/gi)) {
    const declared = /mp4|mkv|webm/i.test(m[2]) ? "direct" : /m3u8|hls/i.test(m[2]) ? "hls" : "other";
    add(m[1], declared);
  }

  // 2) URLs that carry an explicit media extension.
  for (const m of html.matchAll(/https?:\/\/[^"'\s<>]+\.(?:m3u8|mp4|mkv|webm)(?:\?[^"'\s<>]*)?/gi)) {
    add(m[0], /\.m3u8/i.test(m[0]) ? "hls" : "direct");
  }

  // 3) Generic file/src/url keys (kind inferred later from the URL).
  for (const m of html.matchAll(/["'](?:file|src|url)["']\s*:\s*["']([^"']+)["']/gi)) {
    add(m[1], null);
  }
  for (const m of html.matchAll(/<source[^>]+src=["']([^"']+)["']/gi)) {
    add(m[1], null);
  }

  const $ = cheerio.load(html);
  for (const sel of ["video source", "video", "source"]) {
    $(sel).each((_, el) => add($(el).attr("src"), null));
  }
  add($('meta[property="og:video"]').first().attr("content"), null);

  return pickBestMediaUrl(candidates);
}

// Ranks media candidates so a directly downloadable file is preferred over an
// HLS playlist. Each candidate is { url, kind } where kind is "direct", "hls",
// "other" or null (infer from the URL extension). Returns the best URL or null.
function pickBestMediaUrl(candidates) {
  const seen = new Set();
  const directExt = /\.(?:mp4|mkv|webm)(?:\?.*)?$/i;
  const hlsExt = /\.m3u8(?:\?.*)?$/i;

  let direct = null;
  let hls = null;
  let other = null;

  for (const { url, kind } of candidates) {
    if (!url || seen.has(url)) continue;
    seen.add(url);

    const resolvedKind = kind
      || (directExt.test(url) ? "direct" : hlsExt.test(url) ? "hls" : "other");

    if (resolvedKind === "direct" && !direct) direct = url;
    else if (resolvedKind === "hls" && !hls) hls = url;
    else if (!other) other = url;
  }

  // Priority: direct file > HLS playlist > anything else that looked like media.
  return direct || hls || other || null;
}

// Parses the full-results search page (/buscar/<query>/). Each result is a
// `.anime__item` whose title+slug live in the `<h5><a href=".../<slug>/">`.
// This page returns all matches (up to ~30) instead of the ~5 the ajax_search
// autocomplete endpoint caps at. Returns [{ id, slug, title, raw }].
function extractSearchResultsFromHtml(html) {
  if (!html || typeof html !== "string") return [];

  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  $(".anime__item").each((_, el) => {
    const $el = $(el);
    // Prefer the title anchor; fall back to the image anchor for the href.
    const titleLink = $el.find("h5 a[href]").first();
    const href = titleLink.attr("href") || $el.find("a[href]").first().attr("href") || "";
    const match = href.match(/jkanime\.net\/([a-z0-9-]+)\/?/i) || href.match(/\/([a-z0-9-]+)\/?$/i);
    const slug = normalizeSlug(match ? match[1] : "");
    if (!slug || seen.has(slug)) return;
    seen.add(slug);

    const title = titleLink.text().trim().replace(/\s+/g, " ") || slug;
    results.push({ id: null, slug, title, raw: { slug, title, href } });
  });

  return results;
}

async function searchAnimeByQuery(query, options = {}) {
  const { baseUrl = DEFAULT_BASE_URL, requestFn = makeRequest } = options;

  const safeQuery = (query || "").trim();
  if (!safeQuery) {
    return [];
  }

  // Use the full-results search page rather than the ajax_search autocomplete:
  // the autocomplete caps at ~5 hits (and needed a CSRF token + session cookie,
  // which broke with a 419). /buscar/<query>/ is a plain GET that returns every
  // match, and does not paginate (a fixed cap per query), so one request is all
  // we need. ponytail: no pagination logic because the site itself doesn't page.
  const url = `${baseUrl}/buscar/${encodeURIComponent(safeQuery)}/`;
  const response = await requestFn(url, {
    validateStatus: (status) => status >= 200 && status < 500,
  });

  return extractSearchResultsFromHtml(response?.body || "");
}

async function resolveAnimeSlug(query, options = {}) {
  const { searchFn = searchAnimeByQuery } = options;
  const results = await searchFn(query, options);

  if (!results.length) {
    return normalizeSlug(query || "");
  }

  return results[0].slug || normalizeSlug(query || "");
}

function extractAnimeIdFromHtml(html) {
  if (!html || typeof html !== "string") return null;
  const match = html.match(/id=["']guardar-anime["'][^>]*data-anime=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

function extractEpisodeIdFromHtml(html) {
  if (!html || typeof html !== "string") return null;
  const match = html.match(/id=["']guardar-capitulo["'][^>]*data-capitulo=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

function extractLastChapterFromJson(body) {
  const data = parseJsonSafe(body);
  if (!data) return 1;
  const list = Array.isArray(data) ? data : Array.isArray(data.data) ? data.data : [];
  const last = list
    .map((entry) => Number.parseInt(entry?.number ?? entry?.episode ?? entry?.id ?? entry?.attributes?.number ?? "0", 10))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right)
    .pop();
  return last || 1;
}

function extractLastChapterFromHtml(html) {
  if (!html || typeof html !== "string") return 1;
  const regex = /(?:episodios|episodes|capítulos|chapters|episodio)\s*[:=]?\s*(\d+)/i;
  const match = html.match(regex) || html.match(/(\d+)\s*<\/?\w+[^>]*>\s*$/i);
  const value = match ? Number.parseInt(match[1], 10) : NaN;
  return Number.isFinite(value) && value > 0 ? value : 1;
}

// True if the episode page exists. JKAnime serves a real episode (with a player)
// at /<slug>/<n>/ and a 404 page otherwise, so status + a player marker is a
// reliable existence check — far more robust than scraping episode counts from
// HTML that is full of unrelated numbers (which made a 13-ep show plan 50+).
async function episodeExists(animeSlug, episode, { baseUrl = DEFAULT_BASE_URL, requestFn = makeRequest } = {}) {
  try {
    const res = await requestFn(`${baseUrl}/${animeSlug}/${episode}/`, {
      retries: 0,
      validateStatus: (status) => status >= 200 && status < 600,
    });
    if (res.status && res.status >= 400) return false;
    return /jkplayer\//i.test(res.body || "");
  } catch (error) {
    return false;
  }
}

// Discovers how many episodes an anime has by probing for the last existing one:
// exponential search to bracket an upper bound, then binary search for the exact
// edge. This is O(log n) requests and doesn't rely on fragile HTML parsing.
async function resolveEpisodePlan({ animeSlug, baseUrl = DEFAULT_BASE_URL, requestFn = makeRequest, maxEpisodes = 2000 } = {}) {
  if (!animeSlug) {
    return [1];
  }

  const exists = (ep) => episodeExists(animeSlug, ep, { baseUrl, requestFn });

  // If episode 1 isn't reachable (site blocked, bad slug), fall back to [1].
  if (!(await exists(1))) {
    return [1];
  }

  // Exponential search: find the first non-existing episode.
  let lastKnown = 1;
  let probe = 2;
  while (probe <= maxEpisodes && (await exists(probe))) {
    lastKnown = probe;
    probe *= 2;
  }

  // Binary search between lastKnown (exists) and min(probe, maxEpisodes) (missing).
  let low = lastKnown;
  let high = Math.min(probe, maxEpisodes + 1);
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (await exists(mid)) low = mid;
    else high = mid;
  }

  return Array.from({ length: low }, (_, index) => index + 1);
}

module.exports = {
  DEFAULT_BASE_URL,
  normalizeSlug,
  makeRequest,
  extractPlayerUrlFromEpisodeHtml,
  extractMediaUrlFromPlayerHtml,
  extractAnimeIdFromHtml,
  extractEpisodeIdFromHtml,
  extractLastChapterFromJson,
  extractLastChapterFromHtml,
  extractSearchResultsFromHtml,
  searchAnimeByQuery,
  resolveAnimeSlug,
  resolveEpisodePlan,
  episodeExists,
};
