const fs = require("fs");
const path = require("path");

// Turns arbitrary user input (anime name/slug, episode label) into a safe path
// segment. This is a trust boundary: the result is concatenated into a file
// path, so it must never allow traversal (`..`), path separators, or a leading
// dash that CLIs may parse as a flag.
function sanitizeFilename(value) {
  const cleaned = String(value || "anime")
    // Strip Windows-illegal chars and path separators (forward + back slash).
    .replace(/[\\/:*?"<>|]/g, "")
    // Collapse any run of dots so "..", "..." etc. cannot form traversal.
    .replace(/\.{2,}/g, ".")
    // Drop leading/trailing dots, dashes and whitespace.
    .replace(/^[.\-\s]+|[.\-\s]+$/g, "")
    .trim();

  return cleaned || "anime";
}

// Builds the on-disk file name for an episode from untrusted parts. Both the
// anime slug and the episode label are sanitized so neither can escape the
// target folder.
function buildEpisodeFileName(anime, episode) {
  return `${sanitizeFilename(anime)}-${sanitizeFilename(episode)}.mp4`;
}

function parseJsonSafe(body) {
  if (!body || typeof body !== "string") {
    return null;
  }

  try {
    return JSON.parse(body);
  } catch (error) {
    return null;
  }
}

function ensureDirectoryExists(dirPath) {
  if (!dirPath) {
    return;
  }

  const normalizedDir = path.resolve(dirPath);
  fs.mkdirSync(normalizedDir, { recursive: true });
  return normalizedDir;
}

function formatBytes(bytes, decimals = 2) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** index);
  return `${value.toFixed(decimals)} ${units[index]}`;
}

function validateDownloadedFile(filePath, minSize = 1) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`El archivo no existe: ${resolvedPath}`);
  }

  const stats = fs.statSync(resolvedPath);
  if (stats.size < minSize) {
    fs.unlinkSync(resolvedPath);
    throw new Error(`El archivo descargado está vacío o incompleto: ${resolvedPath} (${stats.size} bytes)`);
  }

  return {
    filePath: resolvedPath,
    size: stats.size,
  };
}

module.exports = {
  sanitizeFilename,
  buildEpisodeFileName,
  parseJsonSafe,
  ensureDirectoryExists,
  formatBytes,
  validateDownloadedFile,
};
