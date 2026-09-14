const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

// Single source of truth for CLI options. Both the executable entry (index.js)
// and the orchestration layer (src/cli/index.js) use this parser so the flags
// that are documented, parsed, and actually honored never drift apart.
function buildParser(argv) {
  return yargs(argv)
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
    .option("episode", {
      alias: "e",
      type: "string",
      default: "1",
      describe: "Número del episodio, un rango como 3-6, una lista 1,3,5 o 'all'",
    })
    .option("range", {
      alias: "r",
      type: "string",
      default: "",
      describe: "Rango o lista de episodios, por ejemplo 3-6 o 1,3,5",
    })
    .option("folder", {
      alias: "f",
      type: "string",
      describe: "Carpeta destino. Si no se indica, usa ./animes/<slug>",
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
      describe: "Re-descarga archivos aunque ya existan",
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
    .help()
    .alias("help", "h")
    .version(false);
}

// Returns the raw yargs parse result. Used by the orchestration layer, which
// needs access to argv._ and the hyphenated keys (e.g. args["skip-existing"]).
function parseArgv(argv = process.argv) {
  return buildParser(hideBin(argv)).parse();
}

// Returns a normalized, flat options object. Used by tests and any caller that
// wants the resolved values without yargs bookkeeping.
function parseArgs(rawArgv = hideBin(process.argv)) {
  const parsed = buildParser(rawArgv).parse();

  return {
    anime: parsed.anime || parsed._[0] || "",
    episode: parsed.episode || "1",
    range: parsed.range || "",
    folder: parsed.folder || null,
    verbose: Boolean(parsed.verbose),
    overwrite: Boolean(parsed.overwrite),
    skipExisting: parsed["skip-existing"] !== undefined ? Boolean(parsed["skip-existing"]) : !parsed.overwrite,
    concurrency: Math.max(1, Number(parsed.concurrency) || 5),
    search: parsed.search || "",
  };
}

module.exports = { buildParser, parseArgv, parseArgs };
