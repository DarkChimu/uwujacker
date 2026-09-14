function logInfo(message) {
  console.log(message);
}

function logWarn(message) {
  console.warn(message);
}

function logError(message) {
  console.error(message);
}

function consoleSupportsAnsi() {
  return Boolean(process.stdout && process.stdout.isTTY && process.env.TERM !== "dumb" && !process.env.NO_COLOR);
}

function colorize(text, ansiCode) {
  if (!consoleSupportsAnsi()) {
    return text;
  }

  return `\u001b[${ansiCode}m${text}\u001b[0m`;
}

module.exports = {
  logInfo,
  logWarn,
  logError,
  consoleSupportsAnsi,
  colorize,
};
