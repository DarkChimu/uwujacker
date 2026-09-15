const fs = require("fs");
const path = require("path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const cliProgress = require("cli-progress");
const { ensureDirectoryExists, formatBytes, validateDownloadedFile, buildEpisodeFileName } = require("../utils/files");
const { makeRequest, extractPlayerUrlFromEpisodeHtml, extractMediaUrlFromPlayerHtml } = require("./jkanime");
const { spawn } = require("child_process");

function isInteractive() {
  return Boolean(process.stdout && process.stdout.isTTY && process.env.TERM !== "dumb");
}

// Formatter shared by single and multi bars. Shows a real percentage bar when
// the total size is known, and falls back to a byte counter (indeterminate)
// when the server does not send Content-Length.
function formatProgressBar(options, params, payload) {
  const name = payload.name || "";
  // `indeterminate` is set by the caller when the server sent no Content-Length,
  // so we can't trust params.total (a sentinel of 1 is used to keep the bar alive).
  const known = !payload.indeterminate && params.total > 0 && Number.isFinite(params.total);

  if (!known) {
    // Indeterminate: no percentage, just how much we've pulled so far. The real
    // byte count is carried in the payload since `value` drives the (unknown) %.
    const bytes = Number.isFinite(payload.rawValue) ? payload.rawValue : params.value;
    return `${name} ⏳ ${formatBytes(bytes)} descargados`;
  }

  const width = 24;
  const done = Math.round(params.progress * width);
  const bar = "█".repeat(done) + "░".repeat(width - done);
  const pct = String(Math.round(params.progress * 100)).padStart(3);
  return `${name} [${bar}] ${pct}% ${formatBytes(params.value)} / ${formatBytes(params.total)}`;
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
    return downloadHlsFile(url, filePath, { ffmpegPath, spawnFn, onProgress, verbose });
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

function downloadHlsFile(url, filePath, options = {}) {
  const {
    ffmpegPath = "ffmpeg",
    spawnFn = spawn,
    onProgress = null,
    verbose = false,
  } = options;

  return new Promise((resolve, reject) => {
    ensureDirectoryExists(path.dirname(filePath));

    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      url,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      filePath,
    ];

    const child = spawnFn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (onProgress) {
        const match = /time=(\d+:\d+:\d+\.\d+)/.exec(stderr);
        if (match) {
          onProgress({ filePath, downloaded: 0, total: 0, percent: 0, final: false, raw: match[1] });
        }
      }
    });

    child.on("error", (error) => {
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
        reject(new Error(`FFmpeg falló al procesar el stream HLS: ${stderr.trim() || "sin detalle"}`));
        return;
      }

      try {
        const result = validateDownloadedFile(filePath);
        if (onProgress) {
          onProgress({ filePath, downloaded: result.size, total: result.size, percent: 100, final: true });
        }
        if (!verbose) {
          console.log(`Archivo listo: ${result.filePath} (${formatBytes(result.size)})`);
        }
        resolve(result.filePath);
      } catch (error) {
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
          onProgress: ({ downloaded, total: totalSize, percent, final = false }) => {
            if (!bar) return;
            bar.payload.rawValue = downloaded || 0;
            if (totalSize > 0) {
              bar.setTotal(totalSize);
              bar.update(final ? totalSize : downloaded, { name, indeterminate: false });
            } else {
              bar.update(0, { name, indeterminate: true, rawValue: downloaded || 0 });
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
  formatProgressBar,
};
