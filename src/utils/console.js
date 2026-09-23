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

// Interactive selection menu. On a real TTY it draws an arrow-key list: ↑/↓
// (or k/j) move the highlight, Enter/Space confirm, Esc/q/Ctrl-C cancel. When
// stdin isn't a raw-capable TTY (tests, pipes) it falls back to a line-based
// numbered prompt so the flow still works without a terminal. `input`/`output`
// are injectable for testing. Returns the chosen item or null on cancel.
// readline + raw-mode stdin (stdlib) cover this, so no extra dependency.
function promptSelection(items, options = {}) {
  const {
    input = process.stdin,
    output = process.stdout,
    renderItem = (item) => (item && item.title ? item.title : String(item)),
    header = "Selecciona un anime (↑/↓ para mover, Enter para elegir, Esc para cancelar):",
  } = options;

  if (!Array.isArray(items) || items.length === 0) {
    return Promise.resolve(null);
  }

  if (typeof input.setRawMode === "function" && input.isTTY) {
    return arrowKeySelection(items, { input, output, renderItem, header });
  }

  return lineSelection(items, { input, output, renderItem });
}

// Arrow-key driven menu using raw-mode stdin and readline keypress events.
function arrowKeySelection(items, { input, output, renderItem, header }) {
  const readline = require("readline");
  readline.emitKeypressEvents(input);

  let selected = 0;
  let rendered = false;

  const draw = () => {
    if (rendered) {
      // Move the cursor back up over the previously drawn list to redraw in place.
      output.write(`\u001b[${items.length}A`);
    }
    items.forEach((item, index) => {
      const isActive = index === selected;
      const label = renderItem(item);
      const line = isActive
        ? `\u001b[36m\u001b[7m ❯ ${label} \u001b[0m`
        : `   ${label}`;
      // Clear the rest of each line so shorter titles don't leave residue.
      output.write(`${line}\u001b[K\n`);
    });
    rendered = true;
  };

  return new Promise((resolve) => {
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();

    output.write(`\n${header}\n`);
    output.write("\u001b[?25l"); // hide cursor
    draw();

    const cleanup = () => {
      input.removeListener("keypress", onKey);
      output.write("\u001b[?25h"); // show cursor
      if (!wasRaw) input.setRawMode(false);
      input.pause();
    };

    const onKey = (_str, key = {}) => {
      const name = key.name;

      if (name === "up" || name === "k") {
        selected = (selected - 1 + items.length) % items.length;
        draw();
      } else if (name === "down" || name === "j") {
        selected = (selected + 1) % items.length;
        draw();
      } else if (name === "return" || name === "space") {
        cleanup();
        resolve(items[selected]);
      } else if (name === "escape" || name === "q" || (key.ctrl && name === "c")) {
        cleanup();
        resolve(null);
      }
    };

    input.on("keypress", onKey);
  });
}

// Fallback: numbered list read line by line. Used when there's no raw TTY
// (tests, piped input). Re-prompts on invalid input; empty/"q" cancels.
function lineSelection(items, { input, output, renderItem }) {
  const readline = require("readline");
  const rl = readline.createInterface({ input, output });

  output.write("\nCoincidencias encontradas:\n");
  items.forEach((item, index) => {
    output.write(`  ${index + 1}) ${renderItem(item)}\n`);
  });

  const ask = () =>
    new Promise((resolve) => {
      rl.question("Selecciona una opción (número), o 'q' para cancelar: ", (answer) => {
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
