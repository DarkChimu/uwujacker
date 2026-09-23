#!/usr/bin/env node

const path = require("path");
const { downloadEpisode, downloadEpisodesInParallel } = require("../services/downloader");
const { resolveAnimeSlug, resolveEpisodePlan, searchAnimeByQuery, normalizeSlug } = require("../services/jkanime");
const { ensureDirectoryExists } = require("../utils/files");
const { promptSelection } = require("../utils/console");
const { parseArgv } = require("./args");

// Resolves the slug for the --search flag by letting the user pick from the
// suggestion list. Only used for --search; the -a/--anime path stays untouched.
// - 0 results  -> fall back to normalizing the query.
// - 1 result   -> auto-select it (no point in a one-item menu).
// - N results  -> prompt, unless stdin isn't a TTY (piped/CI), where we can't
//                 ask, so we keep the old behavior and take the first match.
async function resolveSlugFromSearch(query, options = {}) {
  const {
    searchFn = searchAnimeByQuery,
    promptFn = promptSelection,
    // Only prompt when we can actually read a choice: both ends must be a TTY.
    // Piped stdin/stdout (CI, `| tee`, etc.) can't answer, so we fall back to
    // the first match rather than hanging.
    isInteractive = () => Boolean(process.stdin && process.stdin.isTTY && process.stdout && process.stdout.isTTY),
  } = options;

  const results = await searchFn(query);

  if (!results.length) {
    return normalizeSlug(query || "");
  }

  if (results.length === 1) {
    return results[0].slug;
  }

  if (!isInteractive()) {
    return results[0].slug;
  }

  const chosen = await promptFn(results);
  if (!chosen) {
    throw new Error("Selección cancelada. No se descargó nada.");
  }
  return chosen.slug;
}

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

  const searchQuery = typeof args.search === "string" && args.search.trim() ? args.search.trim() : "";
  let slug;
  if (searchQuery) {
    slug = await resolveSlugFromSearch(searchQuery);
  } else {
    slug = animeQuery ? await resolveAnimeSlug(animeQuery) : animeQuery;
  }
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
  resolveSlugFromSearch,
};
