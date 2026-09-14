#!/usr/bin/env node

const path = require("path");
const { hideBin } = require("yargs/helpers");
const yargs = require("yargs/yargs");
const { downloadEpisode, downloadEpisodesInParallel } = require("../services/downloader");
const { resolveAnimeSlug, resolveEpisodePlan } = require("../services/jkanime");
const { ensureDirectoryExists } = require("../utils/files");

function parseArgs(argv = process.argv) {
  const parser = yargs(hideBin(argv))
    .usage("Uso: uwujacker -a <anime> -e <episode> -f <folder>")
    .example([
      ["uwujacker -a dr-stone -e 1 -f ./animes/drstone", "Descarga un episodio concreto"],
      ["uwujacker -a dr-stone -e all -f ./animes/drstone", "Descarga todos los episodios disponibles"],
      ["uwujacker -a dr-stone -e 3-6", "Descarga un rango de episodios"],
      ["uwujacker --search \"Dragon Ball\" -e 1 -f animes", "Busca el slug correcto y descarga el episodio 1"],
    ])
    .option("anime", {
      alias: "a",
      type: "string",
      describe: "Nombre o slug del anime",
    })
    .option("range", {
      alias: "r",
      type: "string",
      default: "",
      describe: "Rango de episodios, por ejemplo 3-6 o 1,3,5",
    })
    .option("episode", {
      alias: "e",
      type: "string",
      default: "1",
      describe: "Número del episodio o 'all'",
    })
    .option("folder", {
      alias: "f",
      type: "string",
      describe: "Carpeta donde se guardarán los archivos. Si no se indica, usa ./animes/<slug>",
    })
    .option("concurrency", {
      alias: "c",
      type: "number",
      default: 5,
      describe: "Número máximo de descargas paralelas",
    })
    .option("overwrite", {
      type: "boolean",
      default: false,
      describe: "Sobrescribe archivos existentes",
    })
    .option("skip-existing", {
      type: "boolean",
      default: true,
      describe: "No vuelve a descargar archivos ya existentes",
    })
    .option("search", {
      type: "string",
      default: "",
      describe: "Busca el slug correcto en JKAnime antes de descargar",
    })
    .option("verbose", {
      alias: "v",
      type: "boolean",
      default: false,
      describe: "Muestra más información de depuración",
    })
    .help();

  return parser.parse();
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
  const args = parseArgs(argv);
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
  parseArgs,
  cli,
  parseEpisodeSelection,
};
