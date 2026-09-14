#!/usr/bin/env node

const path = require("path");
const { downloadEpisode, downloadEpisodesInParallel } = require("../services/downloader");
const { resolveAnimeSlug, resolveEpisodePlan } = require("../services/jkanime");
const { ensureDirectoryExists } = require("../utils/files");
const { parseArgv } = require("./args");

function parseEpisodeSelection(value) {
  if (!value || value === "all") {
    return null;
  }

  const normalised = String(value).trim();
  if (!normalised) {
    return null;
  }

  if (normalised.includes(",")) {
    return [...new Set(normalised.split(",").flatMap((part) => parseEpisodeSelection(part) || []))];
  }

  if (normalised.includes("-")) {
    const [startRaw, endRaw] = normalised.split("-");
    const start = Number.parseInt(startRaw, 10);
    const end = Number.parseInt(endRaw, 10);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      const min = Math.min(start, end);
      const max = Math.max(start, end);
      return Array.from({ length: max - min + 1 }, (_, index) => min + index);
    }
  }

  const numericValue = Number.parseInt(normalised, 10);
  if (Number.isFinite(numericValue) && numericValue > 0) {
    return [numericValue];
  }

  return [1];
}

async function cli(argv = process.argv) {
  const args = parseArgv(argv);
  const animeQuery = args.anime || args._?.[0] || "";

  if (!animeQuery && !args.search) {
    throw new Error("Debes indicar el anime con --anime o como primer argumento");
  }

  const query = typeof args.search === "string" && args.search.trim() ? args.search.trim() : animeQuery;
  const slug = query ? await resolveAnimeSlug(query) : animeQuery;
  const targetFolder = args.folder ? path.resolve(args.folder) : path.resolve("animes", slug || animeQuery);
  ensureDirectoryExists(targetFolder);

  const rangeFromArgument = args.range ? parseEpisodeSelection(args.range) : null;
  const rangeFromEpisode = args.episode && /[-,]/.test(String(args.episode)) ? parseEpisodeSelection(args.episode) : null;
  const episodesToDownload = rangeFromArgument || rangeFromEpisode || null;

  if (args.episode === "all" || episodesToDownload) {
    const episodes = episodesToDownload || await resolveEpisodePlan({ animeSlug: slug });
    await downloadEpisodesInParallel({
      anime: slug,
      episodes,
      folder: targetFolder,
      concurrency: Math.max(1, Number(args.concurrency) || 5),
      verbose: !!args.verbose,
      overwrite: !!args.overwrite,
      skipExisting: args["skip-existing"] !== undefined ? Boolean(args["skip-existing"]) : true,
    });
    return;
  }

  const episode = Number.parseInt(args.episode, 10) || 1;
  await downloadEpisode({
    anime: slug,
    episode,
    folder: targetFolder,
    verbose: !!args.verbose,
    overwrite: !!args.overwrite,
    skipExisting: args["skip-existing"] !== undefined ? Boolean(args["skip-existing"]) : true,
  });
}

if (require.main === module) {
  cli().catch((error) => {
    console.error("Error al descargar:", error.message || error);
    process.exit(1);
  });
}

module.exports = {
  cli,
  parseEpisodeSelection,
};
