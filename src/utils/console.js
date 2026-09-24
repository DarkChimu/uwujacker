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

// Removes the last `n` printed lines from the terminal (moves the cursor up n
// lines and clears from there down). No-op when there's no TTY, since a piped or
// redirected output can't reposition the cursor. Used to drop the per-anime
// "✓ <anime>" lines just before printing the consolidated summary, which would
// otherwise repeat the same information.
function clearLines(n, { output = process.stdout } = {}) {
  if (!Number.isInteger(n) || n <= 0) return;
  if (!output || !output.isTTY) return;
  output.write(`\u001b[${n}A\u001b[0J`);
}

// Reads name+version from package.json for the menu banner. Wrapped in try/catch
// because a bundled SEA binary may not resolve the relative JSON require.
// ponytail: static fallback if the manifest can't be read (SEA build).
function projectBanner() {
  try {
    const pkg = require("../../package.json");
    return `${pkg.name} v${pkg.version}`;
  } catch (error) {
    return "uwujacker";
  }
}

// Interactive multi-selection menu. On a real TTY it draws an arrow-key list:
// ↑/↓ (or k/j) move the highlight, Space toggles the current row, Enter
// confirms the marked set (or the highlighted row if none are marked), and
// Esc/q/Ctrl-C cancel. When stdin isn't a raw-capable TTY (tests, pipes) it
// falls back to a line-based numbered prompt that returns a single item.
// `input`/`output` are injectable for testing. Returns an ARRAY of chosen
// items, or null on cancel. readline + raw-mode stdin (stdlib), no dependency.
function promptSelection(items, options = {}) {
  const {
    input = process.stdin,
    output = process.stdout,
    renderItem = (item) => (item && item.title ? item.title : String(item)),
    banner = projectBanner(),
    header = "Selecciona anime(s) — ↑/↓ mover · Espacio marcar · Enter continuar · Esc cancelar",
  } = options;

  if (!Array.isArray(items) || items.length === 0) {
    return Promise.resolve(null);
  }

  if (typeof input.setRawMode === "function" && input.isTTY) {
    return arrowKeySelection(items, { input, output, renderItem, banner, header });
  }

  return lineSelection(items, { input, output, renderItem });
}

// Arrow-key driven multi-select using raw-mode stdin and readline keypress
// events. Resolves with an array of the chosen items (or null on cancel).
function arrowKeySelection(items, { input, output, renderItem, banner, header }) {
  const readline = require("readline");
  readline.emitKeypressEvents(input);

  let selected = 0;
  const marked = new Set();
  let rendered = false;

  // Lines we draw and later erase on exit: banner + blank + header + one per item.
  const drawnLines = items.length + 3;

  const draw = () => {
    if (rendered) {
      output.write(`\u001b[${drawnLines}A`); // cursor back to the top of our block
    }
    output.write(`\u001b[36m${banner}\u001b[0m\u001b[K\n`);
    output.write(`\u001b[K\n`);
    output.write(`${header}\u001b[K\n`);
    items.forEach((item, index) => {
      const isActive = index === selected;
      const box = marked.has(index) ? "[x]" : "[ ]";
      const label = `${box} ${renderItem(item)}`;
      const line = isActive
        ? `\u001b[36m\u001b[7m ❯ ${label} \u001b[0m`
        : `   ${label}`;
      output.write(`${line}\u001b[K\n`);
    });
    rendered = true;
  };

  return new Promise((resolve) => {
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();

    output.write("\u001b[?25l"); // hide cursor
    draw();

    const finish = (result) => {
      input.removeListener("keypress", onKey);
      // Erase our drawn block so the menu doesn't linger after leaving.
      if (rendered) {
        output.write(`\u001b[${drawnLines}A`);
        for (let i = 0; i < drawnLines; i += 1) output.write("\u001b[K\n");
        output.write(`\u001b[${drawnLines}A`);
      }
      output.write("\u001b[?25h"); // show cursor
      if (!wasRaw) input.setRawMode(false);
      input.pause();
      resolve(result);
    };

    const onKey = (_str, key = {}) => {
      const name = key.name;

      if (name === "up" || name === "k") {
        selected = (selected - 1 + items.length) % items.length;
        draw();
      } else if (name === "down" || name === "j") {
        selected = (selected + 1) % items.length;
        draw();
      } else if (name === "space") {
        if (marked.has(selected)) marked.delete(selected);
        else marked.add(selected);
        draw();
      } else if (name === "return") {
        // Confirm the marked set; if nothing is marked, take the highlighted row.
        const indices = marked.size ? [...marked].sort((a, b) => a - b) : [selected];
        finish(indices.map((i) => items[i]));
      } else if (name === "escape" || name === "q" || (key.ctrl && name === "c")) {
        finish(null);
      }
    };

    input.on("keypress", onKey);
  });
}

// Fallback: numbered list read line by line. Used when there's no raw TTY
// (tests, piped input). Returns a single-item array or null. Re-prompts on
// invalid input; empty/"q" cancels.
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
          resolve([items[choice - 1]]);
          return;
        }

        output.write(`Entrada no válida. Escribe un número entre 1 y ${items.length}.\n`);
        resolve(ask());
      });
    });

  return ask().finally(() => rl.close());
}

// Builds a single consolidated summary for a multi-anime download. Each entry
// is { title, slug, folder, ok, err, total, failures }. Uses ✓/✗ with color
// when ANSI is available and degrades to plain OK/ERR otherwise. Returns the
// string (printing is left to the caller so it stays testable).
function formatMultiSummary(entries, { rootFolder } = {}) {
  const ansi = consoleSupportsAnsi();
  const okMark = ansi ? colorize("✓", "32") : "OK";
  const errMark = ansi ? colorize("✗", "31") : "!!";

  let totalOk = 0;
  let totalEp = 0;
  let totalErr = 0;

  const lines = ["", colorize("Resumen de la descarga", "1"), ""];

  for (const entry of entries) {
    const { title, slug, ok = 0, err = 0, total = 0, failures = [] } = entry;
    totalOk += ok;
    totalEp += total;
    totalErr += err;

    const mark = err > 0 ? errMark : okMark;
    const name = title || slug || "(desconocido)";
    const detail = err > 0 ? `${ok}/${total} OK, ${err} ERR` : `${ok}/${total} OK`;
    lines.push(`  ${mark} ${name}  ${colorize(detail, "90")}`);

    for (const failure of failures) {
      lines.push(`      ${colorize("·", "90")} ep ${failure.episode}: ${failure.error}`);
    }
  }

  lines.push("");
  const animesWord = entries.length === 1 ? "anime" : "animes";
  const failWord = totalErr === 1 ? "fallo" : "fallos";
  const totalsParts = [
    `${entries.length} ${animesWord}`,
    `${totalOk}/${totalEp} episodios`,
    ...(totalErr ? [`${totalErr} ${failWord}`] : []),
  ];
  lines.push(`  ${colorize("Total:", "1")} ${totalsParts.join("  ·  ")}`);
  if (rootFolder) {
    lines.push(`  ${colorize("Carpeta:", "1")} ${rootFolder}`);
  }

  return lines.join("\n");
}

// Prompts for a free-text line (used to ask the episode selection after picking
// animes). Returns the trimmed string, or "" on empty/cancel. Injectable I/O.
function promptText(question, options = {}) {
  const { input = process.stdin, output = process.stdout } = options;
  const readline = require("readline");
  const rl = readline.createInterface({ input, output });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || "").trim());
    });
  });
}

module.exports = {
  logInfo,
  logWarn,
  logError,
  consoleSupportsAnsi,
  colorize,
  promptSelection,
  promptText,
  formatMultiSummary,
  clearLines,
};
