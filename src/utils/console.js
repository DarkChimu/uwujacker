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

// Shows a numbered menu and returns the chosen item, re-prompting on invalid
// input. `input`/`output` are injectable so tests can drive it without a real
// TTY. Returns null if the user cancels (empty line or "q"). readline (stdlib)
// covers the prompt, so no extra dependency is needed.
function promptSelection(items, options = {}) {
  const {
    input = process.stdin,
    output = process.stdout,
    renderItem = (item) => (item && item.title ? `${item.title}  ·  ${item.slug}` : String(item)),
    prompt = "Selecciona una opción (número), o 'q' para cancelar: ",
  } = options;

  if (!Array.isArray(items) || items.length === 0) {
    return Promise.resolve(null);
  }

  const readline = require("readline");
  const rl = readline.createInterface({ input, output });

  output.write("\nCoincidencias encontradas:\n");
  items.forEach((item, index) => {
    output.write(`  ${index + 1}) ${renderItem(item)}\n`);
  });

  const ask = () =>
    new Promise((resolve) => {
      rl.question(prompt, (answer) => {
        const trimmed = String(answer || "").trim().toLowerCase();

        if (trimmed === "" || trimmed === "q") {
          resolve(null);
          return;
        }

        const choice = Number.parseInt(trimmed, 10);
        if (Number.isInteger(choice) && choice >= 1 && choice <= items.length) {
          resolve(items[choice - 1]);
          return;
        }

        output.write(`Entrada no válida. Escribe un número entre 1 y ${items.length}.\n`);
        resolve(ask());
      });
    });

  return ask().finally(() => rl.close());
}

module.exports = {
  logInfo,
  logWarn,
  logError,
  consoleSupportsAnsi,
  colorize,
  promptSelection,
};
