const fs = require("fs");
const path = require("path");
const os = require("node:os");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const cliProgress = require("cli-progress");
const { ensureDirectoryExists, formatBytes, validateDownloadedFile, buildEpisodeFileName } = require("../utils/files");
const { makeRequest, extractPlayerUrlFromEpisodeHtml, extractMediaUrlFromPlayerHtml } = require("./jkanime");
const { spawn } = require("child_process");

function isInteractive() {
  return Boolean(process.stdout && process.stdout.isTTY && process.env.TERM !== "dumb");
}

// Renders "MM:SS" from a number of seconds. Used for HLS, where progress is
// measured in media time rather than bytes.
function formatClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

// Formatter shared by single and multi bars. Shows a real percentage bar when
// the total is known; renders time (HLS) or bytes (direct) as the unit; and
// falls back to an indeterminate counter when there is no total at all.
function formatProgressBar(options, params, payload) {
  const name = payload.name || "";
  const unit = payload.unit;
  // How each numeric value is rendered: media clock, segment count, or bytes.
  const amount = (value) =>
    unit === "time" ? formatClock(value)
    : unit === "count" ? String(Math.round(value))
    : formatBytes(value);
  const noun = unit === "time" ? "procesados" : unit === "count" ? "segmentos" : "descargados";

  // `indeterminate` is set by the caller when the total is unknown (no
  // Content-Length, or HLS with no probed duration), so params.total (a
  // sentinel of 1) can't be trusted.
  const known = !payload.indeterminate && params.total > 0 && Number.isFinite(params.total);

  if (!known) {
    // No total: just show how much we've pulled/processed so far.
    const done = Number.isFinite(payload.rawValue) ? payload.rawValue : params.value;
    return `${name} ⏳ ${amount(done)} ${noun}`;
  }

  const width = 24;
  const filled = Math.round(params.progress * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  const pct = String(Math.round(params.progress * 100)).padStart(3);
  const suffix = unit === "count" ? ` ${noun}` : "";
  return `${name} [${bar}] ${pct}% ${amount(params.value)} / ${amount(params.total)}${suffix}`;
}

function shouldSkipExistingFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const stats = fs.statSync(filePath);
  if (stats.size <= 0) {
    fs.unlinkSync(filePath);
    return false;
  }

  try {
    validateDownloadedFile(filePath);
    return true;
  } catch (error) {
    fs.unlinkSync(filePath);
    return false;
  }
}

async function downloadFile(url, filePath, options = {}) {
  const { downloadFn = null, verbose = false, quality = null, retries = 0, onProgress = null, ffmpegPath = "ffmpeg", spawnFn = spawn } = options;

  if (isHlsUrl(url)) {
    // A lone HLS download has no upstream progress collector, so let the HLS
    // path own a SingleBar itself (same condition as the direct-download path).
    const ownBar = !verbose && !onProgress && isInteractive();
    return downloadHlsFile(url, filePath, { ffmpegPath, spawnFn, onProgress, verbose, ownBar });
  }

  const writerFn = downloadFn || (async (targetUrl, targetPath) => {
    ensureDirectoryExists(path.dirname(targetPath));

    const response = await fetch(targetUrl, { redirect: "follow" });
    if (!response.ok || !response.body) {
      throw new Error(`La descarga de ${targetPath} falló con estado ${response.status}`);
    }

    const contentLength = Number.parseInt(response.headers.get("content-length") || "0", 10);
    const label = path.basename(targetPath);

    // Show a standalone bar only for a lone download: not verbose, interactive,
    // and when nobody upstream is collecting progress (the parallel path owns
    // its own MultiBar and passes onProgress).
    const showBar = !verbose && !onProgress && isInteractive();
    const bar = showBar
      ? new cliProgress.SingleBar(
          { format: formatProgressBar, hideCursor: true, clearOnComplete: false, stopOnComplete: true },
          cliProgress.Presets.shades_classic
        )
      : null;
    // cli-progress needs a positive total; when unknown we pass a sentinel and
    // the formatter renders an indeterminate byte counter instead of a %.
    if (bar) bar.start(contentLength > 0 ? contentLength : 1, 0, { name: label, indeterminate: contentLength <= 0, rawValue: 0 });

    if (!bar && !onProgress) {
      console.log(`Descargando ${label}${verbose ? " (verbose)" : ""}...`);
    }

    // fetch's response.body is a web ReadableStream; convert to a Node stream so
    // we can observe chunks (progress) and pipe to disk with backpressure.
    const nodeStream = Readable.fromWeb(response.body);
    const writer = fs.createWriteStream(targetPath, { flags: "w" });
    let downloaded = 0;

    nodeStream.on("data", (chunk) => {
      downloaded += chunk.length;
      if (bar) {
        bar.payload.rawValue = downloaded;
        if (contentLength > 0) bar.update(downloaded, { name: label });
        else bar.update(0, { name: label, indeterminate: true, rawValue: downloaded });
      }
      if (onProgress) {
        const percent = contentLength > 0 ? (downloaded / contentLength) * 100 : 0;
        onProgress({ filePath: targetPath, downloaded, total: contentLength, percent });
      }
    });

    try {
      await pipeline(nodeStream, writer);
    } finally {
      if (bar) bar.stop();
    }

    const result = validateDownloadedFile(targetPath);
    if (onProgress) {
      onProgress({ filePath: targetPath, downloaded: result.size, total: result.size, percent: 100, final: true });
    }
    if (bar || !onProgress) {
      console.log(`Archivo listo: ${result.filePath} (${formatBytes(result.size)})`);
    }
    return result.filePath;
  });

  return writerFn(url, filePath, { verbose, quality, retries, onProgress, ffmpegPath, spawnFn });
}

function isHlsUrl(url) {
  return /\.m3u8(?:\?|$)/i.test(String(url || ""));
}

// Derives the ffprobe path from the ffmpeg path (they ship together), so a
// custom ffmpeg location keeps ffprobe alongside it.
function ffprobePathFrom(ffmpegPath) {
  return ffmpegPath.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
}

// Asks ffprobe for the total duration (seconds) of the stream. Resolves 0 when
// ffprobe is missing or can't determine it, so the caller falls back to an
// indeterminate progress display instead of failing.
function probeHlsDuration(url, { ffmpegPath = "ffmpeg", spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    const args = [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      url,
    ];

    let child;
    try {
      child = spawnFn(ffprobePathFrom(ffmpegPath), args, { stdio: ["ignore", "pipe", "ignore"] });
    } catch (error) {
      resolve(0);
      return;
    }

    let out = "";
    child.stdout.on("data", (chunk) => { out += String(chunk); });
    child.on("error", () => resolve(0));
    child.on("close", () => {
      const seconds = Number.parseFloat(out.trim());
      resolve(Number.isFinite(seconds) && seconds > 0 ? seconds : 0);
    });
  });
}

// Parses a media (non-master) m3u8 playlist. Returns the ordered segment URLs
// (resolved to absolute) and whether the playlist is encrypted or a master
// playlist — either of which means we must defer to FFmpeg instead of our
// parallel path. ponytail: only handles the common VOD case; master-playlist
// variant selection and AES-128 decryption are left to FFmpeg (fallback).
function parseM3u8(body, baseUrl) {
  const text = String(body || "");
  const encrypted = /#EXT-X-KEY(?![^\n]*METHOD=NONE)/i.test(text);
  const master = /#EXT-X-STREAM-INF/i.test(text);

  const base = new URL(baseUrl);
  const segments = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    try {
      segments.push(new URL(trimmed, base).href);
    } catch {
      // Ignore malformed entries; if enough are bad, download will fail loudly.
    }
  }

  return { segments, encrypted, master };
}

// Downloads all segments with a bounded concurrency pool. Each segment is
// retried a few times; a permanently failing segment aborts the whole download
// (a gap would corrupt the video). Returns nothing; writes files into `dir`.
async function downloadSegments(segmentUrls, dir, { concurrency = 8, onSegmentDone, fetchFn = fetch } = {}) {
  let next = 0;
  let done = 0;

  const fetchSegment = async (url, dest) => {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await fetchFn(url, { redirect: "follow" });
        if (!res.ok || !res.body) throw new Error(`estado ${res.status}`);

        // A CDN may answer 200 with a tiny HTML/JSON error page instead of the
        // .ts (expired token, rate limit). Reject by content-type so we don't
        // concatenate garbage into the final video.
        const ctype = (res.headers.get && res.headers.get("content-type")) || "";
        if (/text\/html|application\/json/i.test(ctype)) {
          throw new Error(`respuesta no es video (content-type: ${ctype})`);
        }

        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));

        const size = fs.statSync(dest).size;
        if (size <= 0) throw new Error("segmento vacío");
        // MPEG-TS packets start with the sync byte 0x47. If the first byte is
        // not 0x47 the payload isn't a TS segment (likely an error page).
        const fd = fs.openSync(dest, "r");
        const head = Buffer.alloc(1);
        fs.readSync(fd, head, 0, 1, 0);
        fs.closeSync(fd);
        if (head[0] !== 0x47) throw new Error("no es un segmento MPEG-TS válido");

        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`segmento falló (${url}): ${lastError ? lastError.message : "desconocido"}`);
  };

  const worker = async () => {
    while (next < segmentUrls.length) {
      const index = next;
      next += 1;
      // Zero-pad the index so lexical order == playback order for concatenation.
      const dest = path.join(dir, `seg-${String(index).padStart(6, "0")}.ts`);
      await fetchSegment(segmentUrls[index], dest);
      done += 1;
      if (onSegmentDone) onSegmentDone(done, segmentUrls.length);
    }
  };

  const pool = Array.from({ length: Math.min(concurrency, segmentUrls.length) || 1 }, worker);
  await Promise.all(pool);
}

// Parallel HLS download: fetch every .ts segment concurrently (segments are
// served across several CDNs, so this is a big win), concatenate them in order,
// then let FFmpeg remux the combined stream into a faststart mp4 (-c copy is a
// near-instant copy, no re-encode). Throws so the caller can fall back to the
// sequential FFmpeg path when the playlist is encrypted or anything fails.
async function downloadHlsParallel(url, filePath, options = {}) {
  const { ffmpegPath = "ffmpeg", spawnFn = spawn, onProgress = null, emit, concurrency = 8 } = options;

  const playlist = await makeRequest(url, { retries: 1 });
  const { segments, encrypted, master } = parseM3u8(playlist.body, url);

  if (encrypted || master || segments.length === 0) {
    throw new Error(encrypted ? "playlist cifrada" : master ? "playlist maestra" : "sin segmentos");
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "uwujacker-hls-"));
  const combined = path.join(tmpDir, "combined.ts");

  try {
    await downloadSegments(segments, tmpDir, {
      concurrency,
      onSegmentDone: (n, total) => {
        const percent = (n / total) * 100;
        if (emit) emit({ filePath, downloaded: n, total, percent, final: false, unit: "count" });
      },
    });

    // Concatenate .ts bytes in order into a single MPEG-TS. A single pipeline
    // driven by an async generator streams every segment through one writable,
    // which avoids attaching per-iteration close/finish listeners (the earlier
    // "MaxListenersExceededWarning") and guarantees the file is fully flushed
    // and closed before we mux.
    ensureDirectoryExists(path.dirname(combined));
    async function* concatSegments() {
      for (let i = 0; i < segments.length; i += 1) {
        const seg = path.join(tmpDir, `seg-${String(i).padStart(6, "0")}.ts`);
        yield* fs.createReadStream(seg);
      }
    }
    await pipeline(concatSegments(), fs.createWriteStream(combined));

    // Remux the combined TS into mp4 (fast copy, no re-encode).
    ensureDirectoryExists(path.dirname(filePath));
    await new Promise((resolve, reject) => {
      const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", combined, "-c", "copy", "-movflags", "+faststart", filePath];
      const child = spawnFn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (c) => { stderr += String(c); });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg mux falló: ${stderr.trim() || "sin detalle"}`)));
    });

    const result = validateDownloadedFile(filePath);
    if (emit) emit({ filePath, downloaded: result.size, total: result.size, percent: 100, final: true });
    return result.filePath;
  } finally {
    // Best-effort cleanup of the temp segment directory.
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function downloadHlsFile(url, filePath, options = {}) {
  const {
    ffmpegPath = "ffmpeg",
    spawnFn = spawn,
    onProgress = null,
    verbose = false,
    ownBar = false,
  } = options;

  ensureDirectoryExists(path.dirname(filePath));

  // Total duration lets us turn ffmpeg's time-based progress into a real
  // percentage. 0 means unknown → indeterminate bar.
  const durationSec = await probeHlsDuration(url, { ffmpegPath, spawnFn });

  const label = path.basename(filePath);
  const bar = ownBar
    ? new cliProgress.SingleBar(
        { format: formatProgressBar, hideCursor: true, clearOnComplete: false, stopOnComplete: true },
        cliProgress.Presets.shades_classic
      )
    : null;
  if (bar) {
    bar.start(durationSec > 0 ? Math.ceil(durationSec) : 1, 0, {
      name: label,
      unit: "time",
      indeterminate: durationSec <= 0,
      rawValue: 0,
    });
  }

  // Single sink for progress: updates our own bar (if any) and forwards to any
  // upstream collector (the parallel MultiBar). Handles both "time" (FFmpeg
  // sequential path) and "count" (parallel segment path) units.
  const emit = (payload) => {
    if (bar) {
      const unit = payload.unit || "time";
      if (payload.final) {
        bar.setTotal(bar.getTotal() || 1);
        bar.update(bar.getTotal(), { name: label, unit, indeterminate: false });
      } else if (payload.total > 0) {
        bar.setTotal(Math.ceil(payload.total));
        bar.update(Math.floor(payload.downloaded), { name: label, unit, indeterminate: false, rawValue: payload.downloaded });
      } else {
        bar.update(0, { name: label, unit, indeterminate: true, rawValue: payload.downloaded });
      }
    }
    if (onProgress) onProgress(payload);
  };

  // Fast path: download segments in parallel ourselves, then remux. Falls back
  // to the sequential FFmpeg path below if the playlist can't be handled this
  // way (encrypted, master playlist) or anything goes wrong.
  try {
    const out = await downloadHlsParallel(url, filePath, { ffmpegPath, spawnFn, emit });
    if (bar) bar.stop();
    if (!verbose) console.log(`Archivo listo: ${out} (${formatBytes(validateDownloadedFile(out).size)})`);
    return out;
  } catch (error) {
    if (verbose) {
      console.warn(`Descarga paralela no disponible (${error.message}); usando FFmpeg directo.`);
    }
    // fall through to the sequential FFmpeg path
  }

  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      // Resilience: HLS is hundreds of small segments; a flaky one shouldn't
      // abort the whole download. Reconnect on transient network errors.
      "-reconnect", "1",
      "-reconnect_streamed", "1",
      "-reconnect_delay_max", "5",
      // Speed: reuse connections and allow multiple in-flight segment requests
      // so we don't idle waiting on per-segment latency (the main HLS slowdown).
      "-http_multiple", "1",
      "-http_persistent", "1",
      "-y",
      "-i", url,
      "-c", "copy",
      "-movflags", "+faststart",
      // Structured, machine-readable progress on stdout instead of parsing the
      // human stderr. Emits key=value lines including out_time_us.
      "-progress", "pipe:1",
      "-nostats",
      filePath,
    ];

    const child = spawnFn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let progressBuf = "";

    child.stdout.on("data", (chunk) => {
      progressBuf += String(chunk);

      // ffmpeg reports microseconds of media processed so far.
      let match;
      const re = /out_time_us=(\d+)/g;
      let lastUs = null;
      while ((match = re.exec(progressBuf)) !== null) {
        lastUs = Number.parseInt(match[1], 10);
      }
      // Keep only the tail to bound memory on long downloads.
      if (progressBuf.length > 4096) progressBuf = progressBuf.slice(-4096);

      if (lastUs != null && Number.isFinite(lastUs)) {
        const seconds = lastUs / 1e6;
        if (durationSec > 0) {
          const percent = Math.max(0, Math.min(100, (seconds / durationSec) * 100));
          emit({ filePath, downloaded: seconds, total: durationSec, percent, final: false, unit: "time" });
        } else {
          // Unknown duration: report elapsed media time so the bar shows motion.
          emit({ filePath, downloaded: seconds, total: 0, percent: 0, final: false, unit: "time" });
        }
      }
    });

    child.stderr.on("data", (chunk) => { stderr += String(chunk); });

    child.on("error", (error) => {
      if (bar) bar.stop();
      // The most common failure is FFmpeg not being installed/on PATH. Turn the
      // cryptic ENOENT into an actionable message instead of leaking it raw.
      if (error && error.code === "ENOENT") {
        reject(new Error(
          `No se encontró FFmpeg ("${ffmpegPath}"). Los episodios en formato HLS (.m3u8) ` +
          "requieren FFmpeg instalado y accesible en el PATH. Instálalo desde https://ffmpeg.org/download.html"
        ));
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        if (bar) bar.stop();
        reject(new Error(`FFmpeg falló al procesar el stream HLS: ${stderr.trim() || "sin detalle"}`));
        return;
      }

      try {
        const result = validateDownloadedFile(filePath);
        emit({ filePath, downloaded: result.size, total: result.size, percent: 100, final: true });
        if (bar) bar.stop();
        if (!verbose) {
          console.log(`Archivo listo: ${result.filePath} (${formatBytes(result.size)})`);
        }
        resolve(result.filePath);
      } catch (error) {
        if (bar) bar.stop();
        reject(error);
      }
    });
  });
}

async function downloadEpisode({
  anime,
  episode,
  folder = ".",
  requestFn = makeRequest,
  downloadFn = downloadFile,
  server = "jk",
  quality = null,
  retries = 2,
  verbose = false,
  overwrite = false,
  skipExisting = true,
  onProgress = null,
}) {
  if (!anime || !episode) {
    throw new Error("Anime and episode are required");
  }

  const fileName = buildEpisodeFileName(anime, episode);
  const filePath = path.resolve(folder, fileName);

  if (skipExisting && !overwrite && shouldSkipExistingFile(filePath)) {
    if (!onProgress) {
      console.log(`[skip] ${anime} episodio ${episode} ya existe: ${filePath}`);
    }
    return filePath;
  }

  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const pageUrl = `https://jkanime.net/${anime}/${episode}/`;
      const pageResponse = await requestFn(pageUrl, { retries: 0, verbose });
      const playerUrl = extractPlayerUrlFromEpisodeHtml(pageResponse.body, server);

      if (!playerUrl) {
        throw new Error(`No se encontró la URL del reproductor para ${anime} episodio ${episode}`);
      }

      const playerResponse = await requestFn(playerUrl, { retries: 0, verbose });
      const mediaUrl = extractMediaUrlFromPlayerHtml(playerResponse.body);

      if (!mediaUrl) {
        throw new Error(`JKAnime no devolvió una URL de video válida para el episodio ${episode}.`);
      }

      ensureDirectoryExists(folder);
      await downloadFn(mediaUrl, filePath, { verbose, retries, quality, overwrite, onProgress });

      return filePath;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        if (verbose) {
          console.warn(`Falló la descarga del episodio ${episode}. Reintentando (${attempt + 1}/${retries})...`);
        }
        continue;
      }

      throw error;
    }
  }

  throw lastError || new Error(`No se pudo completar la descarga del episodio ${episode}`);
}

async function downloadEpisodesInParallel({
  anime,
  episodes,
  folder,
  concurrency = 5,
  server = "jk",
  quality = null,
  retries = 2,
  verbose = false,
  overwrite = false,
  skipExisting = true,
  downloadEpisodeFn = downloadEpisode,
}) {
  const queue = [...episodes];
  const results = [];
  const failures = [];
  let nextIndex = 0;
  let completed = 0;
  let successCount = 0;
  let errorCount = 0;

  // Episodes already on disk are counted up front and never get a bar.
  const pendingEpisodes = [];
  for (const episode of queue) {
    const filePath = path.resolve(folder, buildEpisodeFileName(anime, episode));
    if (skipExisting && !overwrite && shouldSkipExistingFile(filePath)) {
      completed += 1;
      successCount += 1;
      continue;
    }
    pendingEpisodes.push(episode);
  }

  const total = queue.length;

  // One MultiBar with a line per pending episode. Only in an interactive,
  // non-verbose terminal — verbose mode logs interleave and would corrupt bars,
  // and a non-TTY (piped/redirected) gets a plain summary at the end.
  const useBars = isInteractive() && !verbose && pendingEpisodes.length > 0;
  const multibar = useBars
    ? new cliProgress.MultiBar(
        { format: formatProgressBar, hideCursor: true, clearOnComplete: false, autopadding: true, forceRedraw: true },
        cliProgress.Presets.shades_classic
      )
    : null;
  const bars = new Map();

  const worker = async () => {
    while (nextIndex < pendingEpisodes.length) {
      const episode = pendingEpisodes[nextIndex];
      nextIndex += 1;
      const episodeKey = String(episode);
      const name = `Ep ${String(episode).padStart(2, "0")}`;

      const bar = multibar ? multibar.create(1, 0, { name, indeterminate: true, rawValue: 0 }) : null;
      if (bar) bars.set(episodeKey, bar);

      try {
        const filePath = await downloadEpisodeFn({
          anime,
          episode,
          folder,
          requestFn: makeRequest,
          downloadFn: downloadFile,
          server,
          quality,
          retries,
          verbose,
          overwrite,
          skipExisting,
          // onProgress drives only the visual bar. Counting happens once, below,
          // when the episode promise settles, so totals stay deterministic even
          // if onProgress never fires (e.g. HLS via FFmpeg reports no bytes).
          onProgress: ({ downloaded, total: totalSize, percent, final = false, unit }) => {
            if (!bar) return;
            const isTime = unit === "time";
            bar.payload.rawValue = downloaded || 0;
            // For HLS (unit "time") the final event carries bytes as total, which
            // would corrupt a time-based bar; ignore total on the final tick and
            // just close the bar out in the success branch below.
            if (totalSize > 0 && !(isTime && final)) {
              bar.setTotal(Math.ceil(totalSize));
              bar.update(Math.floor(final ? totalSize : downloaded), { name, unit, indeterminate: false });
            } else if (!final) {
              bar.update(0, { name, unit, indeterminate: true, rawValue: downloaded || 0 });
            }
          },
        });

        if (bar) {
          const finalTotal = bar.getTotal() || 1;
          bar.setTotal(finalTotal);
          bar.update(finalTotal, { name: `${name} ✓`, indeterminate: false });
        }
        completed += 1;
        successCount += 1;
        results.push(filePath);
      } catch (error) {
        // A single failing episode must not abort the rest of the batch.
        completed += 1;
        errorCount += 1;
        failures.push({ episode: episodeKey, error: error.message || String(error) });
        if (bar) bar.update(0, { name: `${name} ✗` });
        if (verbose) {
          console.warn(`Episodio ${episode} falló: ${error.message || error}`);
        }
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, pendingEpisodes.length) || 1 }, worker);
  await Promise.all(workers);

  if (multibar) multibar.stop();

  const summaryLines = [
    "Resumen:",
    `  ${String(completed).padStart(2, "0")}/${String(total).padStart(2, "0")} episodios completados`,
    `  OK: ${String(successCount).padStart(2, "0")}`,
    `  ERR: ${String(errorCount).padStart(2, "0")}`,
    `  Ruta: ${folder}`,
    ...(failures.length
      ? ["  Episodios fallidos:", ...failures.map((f) => `    ${f.episode}: ${f.error}`)]
      : []),
  ];

  console.log(summaryLines.join("\n"));
  return results;
}

module.exports = {
  downloadFile,
  downloadEpisode,
  downloadEpisodesInParallel,
  downloadSegments,
  parseM3u8,
  formatProgressBar,
};
