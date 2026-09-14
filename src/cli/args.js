const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

function parseArgs(rawArgv = hideBin(process.argv)) {
  const parsed = yargs(rawArgv)
    .option("anime", {
      alias: "a",
      describe: "Name of the anime to download",
      type: "string",
    })
    .option("episode", {
      alias: "e",
      describe: "Number of the episode to download or 'all'",
      type: "string",
    })
    .option("folder", {
      alias: "f",
      describe: "Folder to save the downloaded anime",
      type: "string",
      default: ".",
    })
    .option("server", {
      alias: "s",
      describe: "Preferred player/server: jk, um, all (default: jk)",
      type: "string",
      default: "jk",
    })
    .option("quality", {
      alias: "q",
      describe: "Preferred quality label if the site exposes it",
      type: "string",
    })
    .option("zip", {
      type: "boolean",
      default: false,
      describe: "Create a ZIP archive with all downloaded episodes",
    })
    .option("retries", {
      type: "number",
      default: 2,
      describe: "How many times to retry a request/download after failure",
    })
    .option("overwrite", {
      type: "boolean",
      default: false,
      describe: "Re-descarga archivos aunque ya existan en la carpeta",
    })
    .option("verbose", {
      type: "boolean",
      default: false,
      describe: "Muestra más logs, incluyendo progreso por archivo",
    })
    .option("skip-existing", {
      type: "boolean",
      default: true,
      describe: "No vuelve a descargar episodios que ya estén en disco",
    })
    .option("concurrency", {
      alias: "c",
      describe: "Máximo de descargas simultáneas cuando se usa -e all",
      type: "number",
      default: 5,
    })
    .option("search", {
      alias: "S",
      describe: "Busca un anime por nombre y resuelve el slug correcto antes de descargar",
      type: "string",
    })
    .check((argv) => {
      if (!argv.anime && !argv._[0]) {
        throw new Error("Anime name is required");
      }
      return true;
    })
    .help()
    .alias("help", "h")
    .version(false)
    .parse();

  return {
    anime: parsed.anime || parsed._[0],
    episode: parsed.episode,
    folder: parsed.folder || ".",
    server: parsed.server || "jk",
    quality: parsed.quality || null,
    zip: Boolean(parsed.zip),
    retries: Number(parsed.retries) || 2,
    verbose: Boolean(parsed.verbose),
    overwrite: Boolean(parsed.overwrite),
    skipExisting: parsed.skipExisting !== undefined ? Boolean(parsed.skipExisting) : !Boolean(parsed.overwrite),
    concurrency: Math.max(1, Number(parsed.concurrency) || 5),
    search: parsed.search || null,
  };
}

module.exports = { parseArgs };
