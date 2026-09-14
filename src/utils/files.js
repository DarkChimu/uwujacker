const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

function sanitizeFilename(value) {
  return String(value || "anime")
    .replace(/[\\/:*?"<>|]/g, "")
    .trim();
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

async function createZipArchive(filePaths, targetZipPath) {
  if (!Array.isArray(filePaths) || !filePaths.length) {
    return null;
  }

  ensureDirectoryExists(path.dirname(targetZipPath));
  const zip = new AdmZip();

  for (const filePath of filePaths) {
    if (!filePath || !fs.existsSync(filePath)) {
      continue;
    }

    zip.addLocalFile(filePath, "", path.basename(filePath));
  }

  zip.writeZip(targetZipPath);
  return targetZipPath;
}

module.exports = {
  sanitizeFilename,
  parseJsonSafe,
  ensureDirectoryExists,
  formatBytes,
  validateDownloadedFile,
  createZipArchive,
};
