const axios = require("axios");
const fs = require("fs");
const path = require("path");
const ProgressBar = require("progress");
const { ensureDirectoryExists, formatBytes, validateDownloadedFile } = require("../utils/files");
const { makeRequest, extractPlayerUrlFromEpisodeHtml, extractMediaUrlFromPlayerHtml } = require("./jkanime");

function canUseAnsiProgress() {
  if (!process.stdout || !process.stdout.isTTY || process.env.TERM === "dumb") {
    return false;
  }

  return true;
}

function moveCursorUp(lines) {
  return lines > 0 ? `\x1b[${lines}A` : "";
}

function clearLine() {
  return "\x1b[2K\r";
}

function renderProgressBlock(lines) {
  if (!process.stdout || !process.stdout.isTTY) {
    return;
  }

  if (renderParallelStatus.lastLines > 0) {
    process.stdout.write(moveCursorUp(renderParallelStatus.lastLines));
  }

  process.stdout.write(lines.map((line) => `${clearLine()}${line}\n`).join(""));
  renderParallelStatus.lastLines = lines.length;
}

function renderParallelStatus({ anime, statusMap, total, completed }) {
  const entries = [...statusMap.values()]
    .filter((entry) => entry.status === "downloading" || entry.status === "done" || entry.status === "error")
    .sort((left, right) => Number(left.episode) - Number(right.episode));

  const episodeNameWidth = 18;
  const barWidth = 24;

  const lines = [
    `${anime} • ${completed}/${total} completados`,
    ...entries.map((entry) => {
      const label = entry.status === "done"
        ? "OK"
        : entry.status === "error"
          ? "ERR"
          : "DL";

      const percent = Number.isFinite(entry.percent) ? Math.max(0, Math.min(100, entry.percent)) : 0;
      const filled = Math.round((percent / 100) * barWidth);
      const bar = `[${"=".repeat(filled)}${" ".repeat(barWidth - filled)}]`;

      const sizeText = entry.total > 0
        ? `${formatBytes(entry.downloaded)} / ${formatBytes(entry.total)}`
        : entry.status === "done"
          ? "Completado"
          : entry.status === "error"
            ? "Error"
            : "Descargando";

      const statusText = entry.total > 0
        ? `${Math.round(percent)}% • ${sizeText}`
        : sizeText;

      const episodeText = `  ${String(entry.episode).padStart(2, "0")}. ${String(entry.name).padEnd(episodeNameWidth)} ${String(label).padEnd(3)} ${bar.padEnd(barWidth + 2)} ${statusText}`;
      return episodeText;
    }),
  ];

  const output = lines.join("\n");

  if (!process.stdout || !process.stdout.isTTY) {
    return;
  }

  if (renderParallelStatus.lastOutput === output) {
    return;
  }

  if (!canUseAnsiProgress()) {
    renderParallelStatus.lastOutput = output;
    renderParallelStatus.lastLines = 0;
    renderParallelStatus.lastRenderedAt = Date.now();
    return;
  }

  const now = Date.now();
  const throttleMs = 120;
  if (renderParallelStatus.lastRenderedAt && now - renderParallelStatus.lastRenderedAt < throttleMs) {
    return;
  }

  renderParallelStatus.lastRenderedAt = now;
  renderParallelStatus.lastOutput = output;
  renderProgressBlock(lines);
}

renderParallelStatus.lastLines = 0;
renderParallelStatus.lastRenderedAt = 0;
renderParallelStatus.lastOutput = "";

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
  const { downloadFn = null, verbose = false, quality = null, retries = 0, onProgress = null } = options;

  const writerFn = downloadFn || ((targetUrl, targetPath, runtimeOptions = {}) => {
    return new Promise(async (resolve, reject) => {
      try {
        ensureDirectoryExists(path.dirname(targetPath));

        const response = await axios({
          url: targetUrl,
          method: "GET",
          responseType: "stream",
          validateStatus: (status) => status >= 200 && status < 400,
        });

        const contentLength = Number.parseInt(response.headers["content-length"] || "0", 10);

        const showProgress = !verbose && Number.isFinite(contentLength) && contentLength > 0 && !onProgress;
        const progressBar = showProgress
          ? new ProgressBar(`Downloading ${path.basename(targetPath)} [:bar] :percent :etas`, {
              width: 40,
              complete: "=",
              incomplete: " ",
              renderThrottle: 1,
              total: contentLength,
            })
          : null;

        if (!showProgress && !onProgress) {
          console.log(`Descargando ${path.basename(targetPath)}${verbose ? " (verbose)" : ""}...`);
        }

        const writer = fs.createWriteStream(targetPath, { flags: "w" });
        let downloaded = 0;

        response.data.on("data", (chunk) => {
          downloaded += chunk.length;
          if (progressBar) {
            progressBar.tick(chunk.length);
          }
          if (onProgress) {
            const percent = contentLength > 0 ? (downloaded / contentLength) * 100 : 0;
            onProgress({
              filePath: targetPath,
              downloaded,
              total: contentLength,
              percent,
            });
          }
        });

        response.data.on("error", (error) => {
          writer.destroy();
          reject(error);
        });

        response.data.pipe(writer);

        writer.on("finish", () => {
          try {
            const result = validateDownloadedFile(targetPath);
            if (onProgress) {
              onProgress({
                filePath: targetPath,
                downloaded: result.size,
                total: result.size,
                percent: 100,
                final: true,
              });
            }
            if (showProgress) {
              console.log(`Archivo listo: ${result.filePath} (${formatBytes(result.size)})`);
            }
            resolve(result.filePath);
          } catch (error) {
            reject(error);
          }
        });

        writer.on("error", reject);
      } catch (error) {
        reject(error);
      }
    });
  });

  return writerFn(url, filePath, { verbose, quality, retries, onProgress });
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

  const fileName = `${anime}-${episode}.mp4`;
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
  const statusMap = new Map();
  const results = [];
  let nextIndex = 0;
  let completed = 0;
  let successCount = 0;
  let errorCount = 0;

  for (const episode of queue) {
    const filePath = path.resolve(folder, `${anime}-${episode}.mp4`);
    if (skipExisting && !overwrite && shouldSkipExistingFile(filePath)) {
      statusMap.set(String(episode), {
        episode: String(episode),
        name: `Episodio ${episode}`,
        status: "done",
        percent: 100,
        downloaded: 0,
        total: 0,
      });
      completed += 1;
      successCount += 1;
      continue;
    }

    statusMap.set(String(episode), {
      episode: String(episode),
      name: `Episodio ${episode}`,
      status: "queued",
      percent: 0,
      downloaded: 0,
      total: 0,
    });
  }

  const pendingEpisodes = queue.filter((episode) => {
    const key = String(episode);
    const entry = statusMap.get(key);
    return !(entry && entry.status === "done" && entry.percent === 100);
  });

  const total = queue.length;
  const renderStatus = () => renderParallelStatus({ anime, statusMap, total, completed });

  const worker = async () => {
    while (nextIndex < pendingEpisodes.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      const episode = pendingEpisodes[currentIndex];
      const episodeKey = String(episode);

      statusMap.set(episodeKey, {
        episode: episodeKey,
        name: `Episodio ${episode}`,
        status: "downloading",
        percent: 0,
        downloaded: 0,
        total: 0,
      });
      renderStatus();

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
          onProgress: ({ downloaded, total: totalSize, percent, final = false }) => {
            const item = statusMap.get(episodeKey) || {
              episode: episodeKey,
              name: `Episodio ${episode}`,
              status: "downloading",
              percent: 0,
              downloaded: 0,
              total: 0,
            };

            item.status = final ? "done" : "downloading";
            item.downloaded = downloaded || 0;
            item.total = totalSize || item.total || 0;
            item.percent = Number.isFinite(percent) ? percent : item.percent || 0;
            statusMap.set(episodeKey, item);
            renderStatus();

            if (final) {
              completed += 1;
              successCount += 1;
            }
          },
        });

        if (!statusMap.has(episodeKey) || statusMap.get(episodeKey).status !== "done") {
          statusMap.set(episodeKey, {
            episode: episodeKey,
            name: `Episodio ${episode}`,
            status: "done",
            percent: 100,
            downloaded: 0,
            total: 0,
          });
          completed += 1;
          successCount += 1;
          renderStatus();
        }

        results.push(filePath);
      } catch (error) {
        statusMap.set(episodeKey, {
          episode: episodeKey,
          name: `Episodio ${episode}`,
          status: "error",
          percent: 0,
          downloaded: 0,
          total: 0,
        });
        errorCount += 1;
        renderStatus();
        throw error;
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, pendingEpisodes.length) || 1 }, worker);
  await Promise.all(workers);

  const summaryLines = [
    "Resumen:",
    `  ${String(completed).padStart(2, "0")}/${String(total).padStart(2, "0")} episodios completados`,
    `  OK: ${String(successCount).padStart(2, "0")}`,
    `  ERR: ${String(errorCount).padStart(2, "0")}`,
    `  Ruta: ${folder}`,
  ];

  if (process.stdout.isTTY) {
    if (renderParallelStatus.lastLines > 0) {
      process.stdout.write(moveCursorUp(renderParallelStatus.lastLines));
    }

    process.stdout.write("\x1b[2J\x1b[H");
    process.stdout.write(`${summaryLines.join("\n")}\n`);
    process.stdout.write("\x1b[?25h");

    renderParallelStatus.lastLines = 0;
    renderParallelStatus.lastRenderedAt = 0;
    renderParallelStatus.lastOutput = "";
    return results;
  }

  console.log(summaryLines.join("\n"));
  return results;
}

module.exports = {
  downloadFile,
  downloadEpisode,
  downloadEpisodesInParallel,
  renderParallelStatus,
};
