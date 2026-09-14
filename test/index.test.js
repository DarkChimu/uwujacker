const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
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
} = require("../index.js");
const { renderParallelStatus } = require("../src/services/downloader");

test("parseArgs lee anime, episodio y carpeta", () => {
  const parsed = parseArgs(["--anime", "dr-stone", "--episode", "5", "--folder", "./animes/drstone"]);

  assert.equal(parsed.anime, "dr-stone");
  assert.equal(parsed.episode, "5");
  assert.equal(parsed.folder, "./animes/drstone");
});

test("sanitizeFilename elimina caracteres no válidos para un nombre de archivo", () => {
  assert.equal(sanitizeFilename("Dr. Stone"), "Dr. Stone");
  assert.equal(sanitizeFilename("Dr/Stone:?*"), "DrStone");
});

test("extractAnimeIdFromHtml obtiene el id del anime", () => {
  const html = '<div id="guardar-anime" data-anime="42"></div>';
  assert.equal(extractAnimeIdFromHtml(html), "42");
});

test("extractEpisodeIdFromHtml obtiene el id del capítulo", () => {
  const html = '<div id="guardar-capitulo" data-capitulo="123"></div>';
  assert.equal(extractEpisodeIdFromHtml(html), "123");
});

test("extractPlayerUrlFromEpisodeHtml obtiene el iframe del player actual", () => {
  const html = `
    <script>var video = [];</script>
    <iframe class="player_conte" src="https://jkanime.net/jkplayer/jk?u=stream/jkmedia/demo/"></iframe>
  `;

  assert.equal(
    extractPlayerUrlFromEpisodeHtml(html),
    "https://jkanime.net/jkplayer/jk?u=stream/jkmedia/demo/"
  );
});

test("extractPlayerUrlFromEpisodeHtml prioriza el player principal de JKAnime", () => {
  const html = `
    <script>var video = [];</script>
    <iframe src="https://jkanime.net/jkplayer/um?e=foo"></iframe>
    <iframe src="https://jkanime.net/jkplayer/jk?u=stream/jkmedia/demo/"></iframe>
  `;

  assert.equal(
    extractPlayerUrlFromEpisodeHtml(html),
    "https://jkanime.net/jkplayer/jk?u=stream/jkmedia/demo/"
  );
});

test("extractMediaUrlFromPlayerHtml obtiene la URL final del video", () => {
  const html = `
    <script>
      new DPlayer({
        video: {
          url: 'https://jkplayers.com/stream/jkmedia/demo/video.mp4',
          type: 'mp4'
        }
      });
    </script>
  `;

  assert.equal(
    extractMediaUrlFromPlayerHtml(html),
    "https://jkplayers.com/stream/jkmedia/demo/video.mp4"
  );
});

test("extractLastChapterFromJson obtiene el último capítulo del JSON", () => {
  const body = JSON.stringify([{ number: "12" }]);
  assert.equal(extractLastChapterFromJson(body), 12);
});

test("extractLastChapterFromHtml obtiene el número total de episodios desde la página actual", () => {
  const html = `
    <li><span>Episodios:</span> 24</li>
  `;

  assert.equal(extractLastChapterFromHtml(html, "dr-stone"), 24);
});

test("downloadEpisode prepara la descarga desde el player actual de JKAnime", async () => {
  const requestFn = async (url) => {
    if (url === "https://jkanime.net/dr-stone/5/") {
      return {
        body: `
          <script>var video = [];</script>
          <iframe class="player_conte" src="https://jkanime.net/jkplayer/jk?u=stream/jkmedia/demo/"></iframe>
        `,
      };
    }

    if (url === "https://jkanime.net/jkplayer/jk?u=stream/jkmedia/demo/") {
      return {
        body: `
          <script>
            var player = new DPlayer({
              video: { url: 'https://example.com/video.mp4', type: 'mp4' }
            });
          </script>
        `,
      };
    }

    throw new Error(`URL inesperada: ${url}`);
  };

  let seen = null;
  const filePath = await downloadEpisode({
    anime: "dr-stone",
    episode: "5",
    folder: "./tmp",
    requestFn,
    downloadFn: async (url, targetPath) => {
      seen = { url, targetPath };
      return targetPath;
    },
  });

  assert.equal(seen.url, "https://example.com/video.mp4");
  assert.match(filePath, /dr-stone-5\.mp4$/);
});

test("ensureDirectoryExists crea el directorio destino", () => {
  const targetDir = path.resolve("./tmp/test-output/nested");
  const created = ensureDirectoryExists(targetDir);

  assert.equal(created, targetDir);
  assert.equal(fs.existsSync(targetDir), true);
});

test("validateDownloadedFile rechaza archivos vacíos", () => {
  const targetFile = path.resolve("./tmp/empty-file.bin");
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, "");

  assert.throws(() => validateDownloadedFile(targetFile), /0 bytes/);
  assert.equal(fs.existsSync(targetFile), false);
});

test("downloadEpisode omite archivos ya existentes por defecto", async () => {
  const folder = path.resolve("./tmp/existing-check");
  const filePath = path.join(folder, "dr-stone-3.mp4");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(filePath, "already-here");

  const requestFn = async () => {
    throw new Error("No debería llamar la red si el archivo ya existe");
  };

  const result = await downloadEpisode({
    anime: "dr-stone",
    episode: "3",
    folder,
    requestFn,
    downloadFn: async () => {
      throw new Error("No debería descargar si ya existe");
    },
    overwrite: false,
    skipExisting: true,
  });

  assert.equal(result, filePath);
  assert.equal(fs.readFileSync(filePath, "utf8"), "already-here");
});

test("parseArgs lee la concurrencia configurada", () => {
  const parsed = parseArgs(["--anime", "dr-stone", "--episode", "all", "--concurrency", "3"]);

  assert.equal(parsed.concurrency, 3);
});

test("downloadEpisodesInParallel respeta el límite de concurrencia", async () => {
  let active = 0;
  let maxActive = 0;

  const result = await downloadEpisodesInParallel({
    anime: "dr-stone",
    episodes: ["1", "2", "3", "4"],
    folder: "./tmp",
    concurrency: 2,
    downloadEpisodeFn: async ({ episode }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return `dr-stone-${episode}.mp4`;
    },
  });

  assert.deepEqual(result, ["dr-stone-1.mp4", "dr-stone-2.mp4", "dr-stone-3.mp4", "dr-stone-4.mp4"]);
  assert.equal(maxActive, 2);
});

test("searchAnimeByQuery realiza una búsqueda AJAX y obtiene resultados", async () => {
  const requestFn = async (url) => {
    if (url.includes("ajax_search")) {
      return {
        body: JSON.stringify({
          data: [
            { id: "1", attributes: { slug: "dr-stone", title: "Dr. Stone" } },
            { id: "2", attributes: { slug: "one-piece", title: "One Piece" } },
          ],
        }),
      };
    }

    throw new Error(`URL inesperada: ${url}`);
  };

  const results = await searchAnimeByQuery("dr stone", {
    requestFn,
  });

  assert.equal(results.length, 2);
  assert.equal(results[0].id, "1");
  assert.equal(results[0].title, "Dr. Stone");
});

test("searchAnimeByQuery devuelve resultados de la AJAX search", async () => {
  const results = await searchAnimeByQuery("Dragon", {
    homeRequestFn: async () => ({ body: '<input name="_token" value="abc123">' }),
    requestFn: async () => ({
      body: JSON.stringify([
        { slug: "dragon-ball", title: "Dragon Ball", type: "Serie", status: "Concluido" },
      ]),
    }),
  });

  assert.equal(results[0].slug, "dragon-ball");
  assert.equal(results[0].title, "Dragon Ball");
});

test("resolveAnimeSlug convierte un nombre legible en el slug correcto", async () => {
  const slug = await resolveAnimeSlug("Dragon Ball", {
    homeRequestFn: async () => ({ body: '<input name="_token" value="abc123">' }),
    requestFn: async () => ({
      body: JSON.stringify([
        { slug: "dragon-ball", title: "Dragon Ball", type: "Serie", status: "Concluido" },
      ]),
    }),
  });

  assert.equal(slug, "dragon-ball");
});

test("renderParallelStatus muestra el progreso correctamente", () => {
  const originalWrite = process.stdout.write;
  const originalIsTTY = process.stdout.isTTY;
  const writes = [];

  process.stdout.isTTY = true;
  process.stdout.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };

  try {
    renderParallelStatus({
      anime: "naruto",
      statusMap: new Map([
        ["1", { episode: "1", name: "Episodio 1", status: "downloading", percent: 35, downloaded: 15, total: 40 }],
        ["2", { episode: "2", name: "Episodio 2", status: "done", percent: 100, downloaded: 40, total: 40 }],
      ]),
      total: 2,
      completed: 1,
    });

    const joined = writes.join("");
    assert.match(joined, /naruto/);
    assert.match(joined, /1\/2 completados/);
    assert.match(joined, /Episodio 1/);
    assert.match(joined, /35%/);
  } finally {
    process.stdout.write = originalWrite;
    process.stdout.isTTY = originalIsTTY;
  }
});

test("renderParallelStatus actualiza en el mismo bloque del terminal sin acumular líneas", () => {
  const originalWrite = process.stdout.write;
  const originalIsTTY = process.stdout.isTTY;
  const writes = [];

  process.stdout.isTTY = true;
  process.stdout.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };

  try {
    renderParallelStatus({
      anime: "naruto",
      statusMap: new Map([
        ["1", { episode: "1", name: "Episodio 1", status: "downloading", percent: 25, downloaded: 10, total: 40 }],
        ["2", { episode: "2", name: "Episodio 2", status: "done", percent: 100, downloaded: 40, total: 40 }],
      ]),
      total: 2,
      completed: 1,
    });

    renderParallelStatus.lastRenderedAt = 0;
    renderParallelStatus.lastOutput = "";
    renderParallelStatus({
      anime: "naruto",
      statusMap: new Map([
        ["1", { episode: "1", name: "Episodio 1", status: "downloading", percent: 75, downloaded: 30, total: 40 }],
        ["2", { episode: "2", name: "Episodio 2", status: "done", percent: 100, downloaded: 40, total: 40 }],
      ]),
      total: 2,
      completed: 1,
    });

    assert.ok(writes.some((chunk) => /\u001b\[[0-9]+A/.test(chunk)));
    assert.ok(writes.some((chunk) => chunk.includes("\u001b[2K")));
    assert.ok(writes.every((chunk) => !chunk.includes("\u001b[2J\u001b[H")));
  } finally {
    process.stdout.write = originalWrite;
    process.stdout.isTTY = originalIsTTY;
  }
});
