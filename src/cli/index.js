#!/usr/bin/env node

const path = require("path");
const { downloadEpisode, downloadEpisodesInParallel } = require("../services/downloader");
const { resolveAnimeSlug, resolveEpisodePlan, searchAnimeByQuery, normalizeSlug } = require("../services/jkanime");
const { ensureDirectoryExists } = require("../utils/files");
const { promptSelection, promptText, formatMultiSummary } = require("../utils/console");
const { parseArgv } = require("./args");

// Resolves the anime(s) for the --search flag by letting the user pick from the
// suggestion list (multi-select). Only used for --search; the -a/--anime path
// stays untouched. Always returns an array of { slug, title } so the final
// summary can show the real title, not just the slug.
// - 0 results  -> fall back to normalizing the query (title = slug).
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

  const pick = (item) => ({ slug: item.slug, title: item.title || item.slug });

  if (!results.length) {
    const slug = normalizeSlug(query || "");
    return [{ slug, title: slug }];
  }

  if (results.length === 1 || !isInteractive()) {
    return [pick(results[0])];
  }

  const chosen = await promptFn(results);
  if (!chosen || chosen.length === 0) {
    throw new Error("Selección cancelada. No se descargó nada.");
  }
  return chosen.map(pick);
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

// Downloads one anime according to the resolved episode selection and returns a
// per-anime result { title, slug, folder, ok, err, total, failures }.
// `episodesSpec` is "all", an array of episode numbers, or a single number.
// `printSummary` is forwarded to the batch downloader: for multi-anime we
// suppress the per-anime summary and print one consolidated summary instead.
async function downloadAnime({ slug, title, episodesSpec, args, targetFolder, printSummary }) {
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
    const res = await downloadEpisodesInParallel({
      ...common,
      episodes,
      concurrency: Math.max(1, Number(args.concurrency) || 5),
      printSummary,
    });
    return { title, slug, folder: targetFolder, ok: res.ok, err: res.err, total: res.total, failures: res.failures };
  }

  // Single episode: normalize into the same shape as the batch result.
  try {
    await downloadEpisode({ ...common, episode: episodesSpec });
    return { title, slug, folder: targetFolder, ok: 1, err: 0, total: 1, failures: [] };
  } catch (error) {
    return {
      title,
      slug,
      folder: targetFolder,
      ok: 0,
      err: 1,
      total: 1,
      failures: [{ episode: String(episodesSpec), error: error.message || String(error) }],
    };
  }
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
  let animes; // [{ slug, title }]
  if (searchQuery) {
    animes = await resolveSlugFromSearch(searchQuery);
  } else {
    const slug = animeQuery ? await resolveAnimeSlug(animeQuery) : animeQuery;
    animes = [{ slug, title: slug }];
  }

  // Episode selection: honor -e/-r if given; otherwise ask once and apply the
  // same selection to every chosen anime. The prompt only runs after a search
  // (where animes come from the menu); the -a path keeps its -e default of 1.
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

  const multiple = animes.length > 1;
  const outcomes = [];
  for (const { slug, title } of animes) {
    const targetFolder = folderForSlug(slug, { folder: args.folder, multiple });
    // For multiple animes, suppress per-anime summaries and print one
    // consolidated summary at the end; single anime keeps its own summary.
    const outcome = await downloadAnime({
      slug,
      title,
      episodesSpec,
      args,
      targetFolder,
      printSummary: !multiple,
    });
    outcomes.push(outcome);
  }

  if (multiple) {
    const rootFolder = args.folder ? path.resolve(args.folder) : path.resolve("animes");
    console.log(formatMultiSummary(outcomes, { rootFolder }));
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
