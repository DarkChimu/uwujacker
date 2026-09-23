#!/usr/bin/env node

const { cli, resolveSlugFromSearch } = require("./src/cli");
const { promptSelection } = require("./src/utils/console");
const { parseArgs } = require("./src/cli/args");
const {
  downloadEpisode,
  downloadEpisodesInParallel,
} = require("./src/services/downloader");
const {
  extractPlayerUrlFromEpisodeHtml,
  extractMediaUrlFromPlayerHtml,
  extractAnimeIdFromHtml,
  extractEpisodeIdFromHtml,
  extractLastChapterFromJson,
  extractLastChapterFromHtml,
  searchAnimeByQuery,
  resolveAnimeSlug,
} = require("./src/services/jkanime");
const {
  sanitizeFilename,
  ensureDirectoryExists,
  validateDownloadedFile,
} = require("./src/utils/files");

if (require.main === module) {
  cli(process.argv).catch((error) => {
    console.error("Error al descargar:", error.message || error);
    process.exit(1);
  });
}

// index.js is the stable public surface for the test suite; it only re-exports
// the real implementations that live under src/.
module.exports = {
  parseArgs,
  sanitizeFilename,
  ensureDirectoryExists,
  validateDownloadedFile,
  extractAnimeIdFromHtml,
  extractEpisodeIdFromHtml,
  extractPlayerUrlFromEpisodeHtml,
  extractMediaUrlFromPlayerHtml,
  extractLastChapterFromJson,
  extractLastChapterFromHtml,
  downloadEpisode,
  downloadEpisodesInParallel,
  searchAnimeByQuery,
  resolveAnimeSlug,
  resolveSlugFromSearch,
  promptSelection,
};
