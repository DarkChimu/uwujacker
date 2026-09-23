#!/usr/bin/env node

const path = require("path");
const { downloadEpisode, downloadEpisodesInParallel } = require("../services/downloader");
const { resolveAnimeSlug, resolveEpisodePlan, searchAnimeByQuery, normalizeSlug } = require("../services/jkanime");
const { ensureDirectoryExists } = require("../utils/files");
const { promptSelection, promptText } = require("../utils/console");
const { parseArgv } = require("./args");

// Resolves the slug(s) for the --search flag by letting the user pick from the
// suggestion list (multi-select). Only used for --search; the -a/--anime path
// stays untouched. Always returns an array of slugs.
// - 0 results  -> fall back to normalizing the query.
// - 1 result   -> auto-select it (no point in a menu).
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
    return [normalizeSlug(query || "")];
  }

  if (results.length === 1) {
    return [results[0].slug];
  }

  if (!isInteractive()) {
    return [results[0].slug];
  }

  const chosen = await promptFn(results);
  if (!chosen || chosen.length === 0) {
    throw new Error("Selección cancelada. No se descargó nada.");
  }
  return chosen.map((item) => item.slug);
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

// Decides the destination folder for a given slug. With --folder and a single
// anime the path is used as-is; with multiple animes we nest <folder>/<slug> so
// files from different animes don't collide (names already carry the slug, but
// nesting keeps output tidy).
function folderForSlug(slug, { folder, multiple }) {
  if (folder) {
    return multiple ? path.resolve(folder, slug) : path.resolve(folder);
  }
  return path.resolve("animes", slug);
}

// Downloads one anime according to the resolved episode selection.
// `episodesSpec` is either "all" or an array of episode numbers.
async function downloadAnime(slug, episodesSpec, args, targetFolder) {
  ensureDirectoryExists(targetFolder);
  const common = {
    anime: slug,
    folder: targetFolder,
    verbose: !!args.verbose,
    overwrite: !!args.overwrite,
    skipExisting: args["skip-existing"] !== undefined ? Boolean(args["skip-existing"]) : true,
  };

  if (episodesSpec === "all" || Array.isArray(episodesSpec)) {
    const episodes = Array.isArray(episodesSpec)
      ? episodesSpec
      : await resolveEpisodePlan({ animeSlug: slug });
    await downloadEpisodesInParallel({
      ...common,
      episodes,
      concurrency: Math.max(1, Number(args.concurrency) || 5),
    });
    return;
  }

  await downloadEpisode({ ...common, episode: episodesSpec });
}

// Turns the CLI episode flags into a normalized selection: "all", or an array
// of episode numbers, or a single number. `-e`/`-r` win; otherwise null so the
// caller knows it must ask the user.
function episodeSpecFromArgs(args) {
  const rangeFromArgument = args.range ? parseEpisodeSelection(args.range) : null;
  const rangeFromEpisode = args.episode && /[-,]/.test(String(args.episode)) ? parseEpisodeSelection(args.episode) : null;
  const list = rangeFromArgument || rangeFromEpisode || null;
  if (args.episode === "all") return "all";
  if (list) return list;
  // yargs defaults --episode to "1"; treat that default as "not provided" so we
  // prompt after a search. An explicit numeric -e is honored as a single ep.
  if (args.episode !== undefined && args.episode !== "1") {
    const n = Number.parseInt(args.episode, 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }
  return null;
}

// Interprets a free-text episode answer the same way as the -e flag.
function parseEpisodeAnswer(answer) {
  const trimmed = String(answer || "").trim().toLowerCase();
  if (!trimmed || trimmed === "all") return "all";
  const list = parseEpisodeSelection(trimmed);
  if (list) return list;
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

async function cli(argv = process.argv) {
  const args = parseArgv(argv);
  const animeQuery = args.anime || args._?.[0] || "";

  if (!animeQuery && !args.search) {
    throw new Error("Debes indicar el anime con --anime o como primer argumento");
  }

  const searchQuery = typeof args.search === "string" && args.search.trim() ? args.search.trim() : "";
  let slugs;
  if (searchQuery) {
    slugs = await resolveSlugFromSearch(searchQuery);
  } else {
    slugs = [animeQuery ? await resolveAnimeSlug(animeQuery) : animeQuery];
  }

  // Episode selection: honor -e/-r if given; otherwise ask once and apply the
  // same selection to every chosen anime. The prompt only runs after a search
  // (where slugs come from the menu); the -a path keeps its -e default of 1.
  let episodesSpec = episodeSpecFromArgs(args);
  if (episodesSpec === null) {
    if (searchQuery) {
      const answer = await promptText(
        "Episodio a descargar (número, rango 3-6, lista 1,3,5 o 'all'): "
      );
      episodesSpec = parseEpisodeAnswer(answer);
    } else {
      episodesSpec = 1;
    }
  }

  const multiple = slugs.length > 1;
  for (const slug of slugs) {
    const targetFolder = folderForSlug(slug, { folder: args.folder, multiple });
    await downloadAnime(slug, episodesSpec, args, targetFolder);
  }
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
  episodeSpecFromArgs,
  parseEpisodeAnswer,
  folderForSlug,
};
