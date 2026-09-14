const axios = require("axios");
const cheerio = require("cheerio");

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
      const response = await axios({
        url,
        method,
        headers,
        data: body,
        timeout,
        validateStatus,
        responseType: "text",
      });

      return {
        status: response.status,
        body: response.data,
        headers: response.headers,
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

function extractPlayerUrlFromEpisodeHtml(html, server = "jk") {
  if (!html || typeof html !== "string") return null;

  const patterns = [
    /jkplayer\/jk\?u=([^"'\s<>]+)/i,
    /src=["']([^"']*jkplayer[^"']+)["']/i,
    /var\s+video\s*=\s*\[[\s\S]*?https?:\/\/[^\]]+/i,
    /<iframe[^>]+src=["']([^"']+)["'][^>]*>/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      const raw = match[1] || match[0];
      if (pattern.source.includes("jkplayer\\/jk\\?u=")) {
        const value = match[1];
        return resolveAbsoluteUrl(`jkplayer/jk?u=${value}`, DEFAULT_BASE_URL);
      }

      const candidate = resolveAbsoluteUrl(raw, DEFAULT_BASE_URL);
      if ((candidate && candidate.includes("jkplayer")) || candidate.includes("stream")) {
        return candidate;
      }
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
    const match = script.match(/(?:https?:\/\/[^"'\s]+(?:stream|jkplayer)[^"'\s]*)|(?:\/?jkplayer\/jk\?u=[^"'\s]+)/i);
    if (match) return resolveAbsoluteUrl(match[0], DEFAULT_BASE_URL);
  }

  return null;
}

function extractMediaUrlFromPlayerHtml(html) {
  if (!html || typeof html !== "string") return null;

  const patterns = [
    /https?:\/\/[^"'\s<>]+\.(?:m3u8|mp4|mkv|webm)(?:\?[^"'\s<>]*)?/i,
    /"(?:file|src|url)"\s*:\s*"([^"']+)"/i,
    /source\s*src=["']([^"']+)["']/i,
    /video\s*:\s*\{[^}]*src\s*:\s*["']([^"']+)["']/i,
    /https?:\/\/jkplayers\.com\/stream\/[^"'\s<>]+/i,
    /https?:\/\/[^"'\s<>]+stream[^"'\s<>]+/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      const candidate = match[1] || match[0];
      if (candidate && /\.(m3u8|mp4|mkv|webm)(\?.*)?$/i.test(candidate)) {
        return candidate;
      }
      return candidate;
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
    if (/\.(m3u8|mp4|mkv|webm)/i.test(candidate)) {
      return candidate;
    }
  }

  const scriptRegex = /https?:\/\/[^"'\s<>]+(?:m3u8|mp4|mkv|webm)[^"'\s<>]*/gi;
  const scriptMatches = html.match(scriptRegex);
  if (scriptMatches && scriptMatches.length) {
    return scriptMatches[0];
  }

  return null;
}

async function searchAnimeByQuery(query, baseUrl = DEFAULT_BASE_URL) {
  const safeQuery = (query || "").trim();
  if (!safeQuery) {
    throw new Error("La búsqueda por anime requiere una consulta");
  }

  const pageUrl = `${baseUrl}/`;
  const page = await makeRequest(pageUrl);
  const tokenMatch = page.body.match(/name=["']_token["']\s+value=["']([^"']+)["']/i) ||
    page.body.match(/_token[^\n]*value=["']([^"']+)["']/i);
  const csrfToken = tokenMatch ? tokenMatch[1] : "";

  const payload = new URLSearchParams({
    _token: csrfToken,
    q: safeQuery,
  });

  const searchResponse = await makeRequest(`${baseUrl}/ajax_search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json, text/plain, */*",
    },
    body: payload.toString(),
    validateStatus: (status) => status >= 200 && status < 500,
  });

  if (!searchResponse.body) {
    return [];
  }

  let results = [];

  try {
    results = JSON.parse(searchResponse.body);
  } catch (error) {
    const cleaned = searchResponse.body.trim();
    if (cleaned) {
      try {
        results = JSON.parse(cleaned);
      } catch {
        return [];
      }
    }
  }

  if (!Array.isArray(results)) {
    return [];
  }

  return results
    .map((item) => {
      if (item && typeof item === "object") {
        const slug = item.slug || item.attributes?.slug || item.url?.replace(/^\//, "").split("/")[0] || "";
        const title = item.title || item.name || item.attributes?.title || item.attributes?.name || "";
        if (!slug) return null;
        return {
          slug: normalizeSlug(slug),
          title: title || slug,
          raw: item,
        };
      }

      if (typeof item === "string") {
        return {
          slug: normalizeSlug(item),
          title: item,
          raw: item,
        };
      }

      return null;
    })
    .filter(Boolean);
}

async function resolveAnimeSlug(query, options = {}) {
  const { baseUrl = DEFAULT_BASE_URL, searchFn = searchAnimeByQuery } = options;
  const results = await searchFn(query, baseUrl);

  if (!results.length) {
    return normalizeSlug(query);
  }

  return results[0].slug || normalizeSlug(query);
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
  searchAnimeByQuery,
  resolveAnimeSlug,
  resolveEpisodePlan,
};
