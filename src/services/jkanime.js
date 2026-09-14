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

  const modernPattern = /https?:\/\/[^"'\s<>]*\/jkplayer\/(?:um|umv|c1)[^"'\s<>]*/i;
  const legacyPattern = /https?:\/\/[^"'\s<>]*\/jkplayer\/jk\?u=[^"'\s<>]*/i;
  const relativePattern = /(?:\/)?jkplayer\/(?:um|umv|c1|jk)(?:\?[^"'\s<>]+|\/[^"'\s<>]+)?/i;
  const iframePattern = /<iframe[^>]+src=["']([^"']+)["'][^>]*>/i;

  const candidates = [];

  const modernMatch = html.match(modernPattern) || html.match(relativePattern);
  if (modernMatch) candidates.push(modernMatch[0]);

  const legacyMatch = html.match(legacyPattern) || html.match(/(?:\/)?jkplayer\/jk\?u=[^"'\s<>]*/i);
  if (legacyMatch) candidates.push(legacyMatch[0]);

  const iframeMatch = html.match(iframePattern);
  if (iframeMatch) candidates.push(iframeMatch[1]);

  const srcMatch = html.match(/src=["']([^"']*jkplayer[^"']+)["']/i);
  if (srcMatch) candidates.push(srcMatch[1]);

  for (const candidate of candidates) {
    const normalized = normalizeVideoCandidate(candidate);
    if (!normalized) continue;

    const resolved = resolveAbsoluteUrl(normalized, DEFAULT_BASE_URL);
    if (resolved && /jkplayer\/(?:um|umv|c1|jk)/i.test(resolved)) {
      return resolved;
    }
  }

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

  const patterns = [
    /https?:\/\/[^"'\s<>]+\.(?:m3u8|mp4|mkv|webm)(?:\?[^"'\s<>]*)?/i,
    /"(?:file|src|url)"\s*:\s*"([^"']+)"/i,
    /'(?:file|src|url)'\s*:\s*'([^']+)'/i,
    /source\s*src=["']([^"']+)["']/i,
    /video\s*:\s*\{[^}]*src\s*:\s*["']([^"']+)["']/i,
    /https?:\/\/jkplayers\.com\/stream\/[^"'\s<>]+/i,
    /https?:\/\/[^"'\s<>]+stream[^"'\s<>]+/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      const candidate = normalizeVideoCandidate(match[1] || match[0]);
      if (candidate && /\.(m3u8|mp4|mkv|webm)(\?.*)?$/i.test(candidate)) {
        return candidate;
      }
      if (candidate) return candidate;
    }
  }

  const $ = cheerio.load(html);
  const urlCandidates = [
    $('video source').first().attr("src"),
    $('video').first().attr("src"),
    $('source').first().attr("src"),
    $('meta[property="og:video"]').first().attr("content"),
  ].filter(Boolean);

  for (const candidate of urlCandidates) {
    const normalized = normalizeVideoCandidate(candidate);
    if (normalized && /\.(m3u8|mp4|mkv|webm)(\?.*)?$/i.test(normalized)) {
      return normalized;
    }
  }

  const scriptRegex = /https?:\/\/[^"'\s<>]+(?:m3u8|mp4|mkv|webm)[^"'\s<>]*/gi;
  const scriptMatches = html.match(scriptRegex);
  if (scriptMatches && scriptMatches.length) {
    return normalizeVideoCandidate(scriptMatches[0]);
  }

  return null;
}

async function searchAnimeByQuery(query, options = {}) {
  const {
    baseUrl = DEFAULT_BASE_URL,
    requestFn = makeRequest,
    homeRequestFn = null,
  } = options;

  const safeQuery = (query || "").trim();
  if (!safeQuery) {
    return [];
  }

  // Obtain the CSRF token from the home page; JKAnime requires it on ajax_search.
  // If the home page cannot be fetched we still attempt the search with an empty
  // token rather than aborting: the AJAX endpoint is the source of truth.
  const homeFn = homeRequestFn || (() => requestFn(`${baseUrl}/`));
  let homePage;
  try {
    homePage = await homeFn();
  } catch (error) {
    homePage = { body: "" };
  }

  const homeBody = homePage?.body || "";
  const tokenMatch = homeBody.match(/name=["']_token["']\s+value=["']([^"']+)["']/i) ||
    homeBody.match(/_token[^\n]*value=["']([^"']+)["']/i);
  const csrfToken = tokenMatch ? tokenMatch[1] : "";

  const payload = new URLSearchParams({ _token: csrfToken, q: safeQuery });

  const searchResponse = await requestFn(`${baseUrl}/ajax_search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json, text/plain, */*",
    },
    body: payload.toString(),
    validateStatus: (status) => status >= 200 && status < 500,
  });

  const responseData = parseJsonSafe(searchResponse?.body) ?? [];
  const list = Array.isArray(responseData)
    ? responseData
    : Array.isArray(responseData.data)
      ? responseData.data
      : [];

  return list
    .map((item) => {
      if (item && typeof item === "object") {
        const slug = item.slug || item.attributes?.slug || item.url?.replace(/^\//, "").split("/")[0] || "";
        const title = item.title || item.name || item.attributes?.title || item.attributes?.name || "";
        if (!slug) return null;
        return {
          id: item.id ?? item.attributes?.id ?? null,
          slug: normalizeSlug(slug),
          title: title || slug,
          raw: item,
        };
      }

      if (typeof item === "string") {
        return { id: null, slug: normalizeSlug(item), title: item, raw: item };
      }

      return null;
    })
    .filter(Boolean);
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

async function resolveEpisodePlan({ animeSlug, baseUrl = DEFAULT_BASE_URL, requestFn = makeRequest } = {}) {
  if (!animeSlug) {
    return [1];
  }

  const animeUrl = `${baseUrl}/${animeSlug}/`;

  try {
    const page = await requestFn(animeUrl, { retries: 1 });
    const matches = [...(page.body || "").matchAll(/(?:href|src)=["']\/?(?:[^"']+\/)?(?:[a-z0-9-]+)\/([0-9]+)\/?["']/gi)];
    const numbers = matches
      .map((match) => Number.parseInt(match[1], 10))
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((left, right) => left - right);

    if (numbers.length) {
      const maxEpisode = numbers[numbers.length - 1];
      return Array.from({ length: maxEpisode }, (_, index) => index + 1);
    }
  } catch (error) {
    // Fallback to a safe range when the site blocks or the slug is unavailable.
  }

  return [1];
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
  searchAnimeByQuery,
  resolveAnimeSlug,
  resolveEpisodePlan,
};
