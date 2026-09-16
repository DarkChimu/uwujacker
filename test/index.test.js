const fs = require("node:fs");
const path = require("node:path");
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

// Los tests escriben artefactos en ./tmp; los limpiamos al terminar la suite.
after(() => {
  fs.rmSync(path.resolve("./tmp"), { recursive: true, force: true });
});

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
const { formatProgressBar, downloadFile, parseM3u8, downloadSegments } = require("../src/services/downloader");
const { resolveEpisodePlan } = require("../src/services/jkanime");
const { buildEpisodeFileName } = require("../src/utils/files");

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

test("sanitizeFilename neutraliza intentos de path traversal", () => {
  // Sin separadores, sin '..', sin guion inicial que un CLI trate como flag.
  assert.equal(sanitizeFilename("../../etc/passwd"), "etcpasswd");
  assert.equal(sanitizeFilename("..\\..\\windows"), "windows");
  assert.equal(sanitizeFilename("-rf"), "rf");
  assert.equal(sanitizeFilename(".."), "anime");
  assert.equal(sanitizeFilename(""), "anime");
});

test("buildEpisodeFileName produce un nombre seguro dentro de la carpeta", () => {
  assert.equal(buildEpisodeFileName("dr-stone", "5"), "dr-stone-5.mp4");
  const malicious = buildEpisodeFileName("../../evil", "1");
  assert.ok(!malicious.includes("/"), "no debe contener separadores de ruta");
  assert.ok(!malicious.includes(".."), "no debe contener '..'");
  assert.equal(malicious, "evil-1.mp4");
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

test("extractPlayerUrlFromEpisodeHtml prefiere el player jk (mp4 directo) sobre um/umv (HLS)", () => {
  // Caso real de JKAnime: varios servidores en la misma página. El player "jk"
  // entrega un mp4 directo (302 → CDN) que se descarga sin FFmpeg, mientras que
  // um/umv/c1 devuelven HLS. Debe ganar jk.
  const html = `
    <iframe src="https://jkanime.net/jkplayer/um?e=foo"></iframe>
    <iframe src="https://jkanime.net/jkplayer/umv?e=bar"></iframe>
    <iframe src="https://jkanime.net/jkplayer/jk?u=stream/jkmedia/demo/"></iframe>
    <iframe src="https://jkanime.net/jkplayer/c1?u="></iframe>
  `;

  assert.equal(
    extractPlayerUrlFromEpisodeHtml(html),
    "https://jkanime.net/jkplayer/jk?u=stream/jkmedia/demo/"
  );
});

test("extractPlayerUrlFromEpisodeHtml soporta rutas modernas del player JKAnime", () => {
  const html = `
    <script>var player = { source: "https://jkanime.net/jkplayer/umv?e=bar" };</script>
  `;

  assert.equal(
    extractPlayerUrlFromEpisodeHtml(html),
    "https://jkanime.net/jkplayer/umv?e=bar"
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

test("extractMediaUrlFromPlayerHtml prefiere mp4 directo sobre HLS aunque el m3u8 aparezca primero", () => {
  const html = `
    <script>
      var sources = [
        { file: "https://cdn.example.com/stream/master.m3u8", type: "hls" },
        { file: "https://cdn.example.com/stream/video-720.mp4", type: "mp4" }
      ];
    </script>
  `;

  assert.equal(
    extractMediaUrlFromPlayerHtml(html),
    "https://cdn.example.com/stream/video-720.mp4"
  );
});

test("extractMediaUrlFromPlayerHtml usa HLS solo si no hay archivo directo", () => {
  const html = `<script>var player = { source: "https://cdn.example.com/stream/master.m3u8" };</script>`;

  assert.equal(
    extractMediaUrlFromPlayerHtml(html),
    "https://cdn.example.com/stream/master.m3u8"
  );
});

test("extractMediaUrlFromPlayerHtml captura el mp4 de DPlayer aunque la URL no tenga extensión", () => {
  // Caso real del player "jk": DPlayer con url sin extensión + type: 'mp4'. La
  // URL redirige a un CDN. Debe reconocerse como directo por el `type`.
  const html = `
    <script>
      new DPlayer({
        video: {
          url: 'https://jkplayers.com/stream/jkmedia/abc/def/3/1.2.3.4/',
          type: 'mp4'
        }
      });
    </script>
  `;

  assert.equal(
    extractMediaUrlFromPlayerHtml(html),
    "https://jkplayers.com/stream/jkmedia/abc/def/3/1.2.3.4/"
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

test("downloadEpisodesInParallel no aborta el lote si un episodio falla", async () => {
  const attempted = [];

  const result = await downloadEpisodesInParallel({
    anime: "dr-stone",
    episodes: ["1", "2", "3", "4"],
    folder: "./tmp",
    concurrency: 1,
    downloadEpisodeFn: async ({ episode }) => {
      attempted.push(episode);
      if (episode === "2") {
        throw new Error("fallo simulado en el episodio 2");
      }
      return `dr-stone-${episode}.mp4`;
    },
  });

  // El fallo del episodio 2 no debe impedir que se intenten los 4 ni que se
  // descarguen los 3 restantes; la promesa se resuelve, no rechaza.
  assert.deepEqual(attempted, ["1", "2", "3", "4"]);
  assert.deepEqual(result, ["dr-stone-1.mp4", "dr-stone-3.mp4", "dr-stone-4.mp4"]);
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

test("resolveEpisodePlan detecta el último episodio real por existencia (13, no 50+)", async () => {
  const TOTAL = 13;
  let calls = 0;
  // Simula JKAnime: episodios <= TOTAL dan 200 con player; el resto, 404.
  const requestFn = async (url) => {
    calls += 1;
    const ep = Number(url.match(/\/(\d+)\/$/)[1]);
    if (ep <= TOTAL) return { status: 200, body: "<iframe src='https://jkanime.net/jkplayer/jk?u=x'></iframe>" };
    return { status: 404, body: "Página no encontrada" };
  };

  const plan = await resolveEpisodePlan({ animeSlug: "uma-musume-pretty-derby-tv", requestFn });

  assert.equal(plan.length, TOTAL);
  assert.equal(plan[0], 1);
  assert.equal(plan[plan.length - 1], TOTAL);
  // Búsqueda exponencial + binaria: muchas menos peticiones que probar 1..N.
  assert.ok(calls < TOTAL, `debe ser O(log n): ${calls} peticiones`);
});

test("resolveEpisodePlan devuelve [1] si el episodio 1 no existe", async () => {
  const requestFn = async () => ({ status: 404, body: "Página no encontrada" });
  const plan = await resolveEpisodePlan({ animeSlug: "no-existe", requestFn });
  assert.deepEqual(plan, [1]);
});

test("formatProgressBar muestra porcentaje y tamaños cuando se conoce el total", () => {
  const line = formatProgressBar(
    {},
    { total: 40, value: 10, progress: 0.25 },
    { name: "Ep 01" }
  );

  assert.match(line, /Ep 01/);
  assert.match(line, /25%/);
  // Debe mostrar bytes descargados y totales formateados.
  assert.match(line, /10\.00 B/);
  assert.match(line, /40\.00 B/);
});

test("formatProgressBar cae a modo indeterminado (bytes) sin total conocido", () => {
  const line = formatProgressBar(
    {},
    { total: 1, value: 0, progress: 0 },
    { name: "Ep 02", indeterminate: true, rawValue: 2048 }
  );

  assert.match(line, /Ep 02/);
  // Sin porcentaje; muestra los bytes descargados desde el payload.
  assert.doesNotMatch(line, /%/);
  assert.match(line, /2\.00 KB descargados/);
});

// Fake child process con stdout/stderr para simular ffprobe/ffmpeg sin binarios.
function fakeChild() {
  const EventEmitter = require("node:events").EventEmitter;
  const stream = new EventEmitter();
  stream.stdout = new EventEmitter();
  stream.stderr = new EventEmitter();
  return stream;
}

test("downloadFile usa ffmpeg para streams HLS y no guarda el manifiesto como video", async () => {
  const filePath = path.resolve("./tmp/hls-regression.mp4");
  const calls = [];

  const spawnFn = (command, args) => {
    calls.push({ command, args });
    const stream = fakeChild();
    if (/ffprobe/i.test(command)) {
      // Simula la duración (segundos) que ffprobe imprime en stdout.
      setImmediate(() => {
        stream.stdout.emit("data", "1417.5\n");
        stream.emit("close", 0);
      });
    } else {
      setImmediate(() => {
        stream.stdout.emit("data", "out_time_us=708750000\n");
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, "fake-video-bytes");
        stream.emit("close", 0);
      });
    }
    return stream;
  };

  const result = await downloadFile("https://example.com/video.m3u8", filePath, { spawnFn, ffmpegPath: "ffmpeg" });

  assert.equal(result, filePath);
  assert.equal(fs.readFileSync(filePath, "utf8"), "fake-video-bytes");
  // Se consultó ffprobe primero y luego ffmpeg con los argumentos correctos.
  assert.ok(calls.some((c) => /ffprobe/i.test(c.command)));
  const ff = calls.find((c) => c.command === "ffmpeg");
  assert.ok(ff, "debe invocar ffmpeg");
  assert.ok(ff.args.includes("-i"));
  assert.ok(ff.args.includes("https://example.com/video.m3u8"));
  assert.ok(ff.args.includes("-progress"), "debe pedir progreso estructurado");
});

test("downloadFile da un mensaje claro cuando falta FFmpeg (ENOENT)", async () => {
  const spawnFn = (command) => {
    const stream = fakeChild();
    if (/ffprobe/i.test(command)) {
      // ffprobe también ausente: cierra sin duración; no debe romper el flujo.
      setImmediate(() => stream.emit("close", 1));
    } else {
      setImmediate(() => {
        const err = new Error("spawn ffmpeg ENOENT");
        err.code = "ENOENT";
        stream.emit("error", err);
      });
    }
    return stream;
  };

  await assert.rejects(
    () => downloadFile("https://example.com/video.m3u8", path.resolve("./tmp/no-ffmpeg.mp4"), { spawnFn }),
    /No se encontró FFmpeg/
  );
});

test("downloadFile descarga por HTTP con fetch nativo y escribe el archivo", async () => {
  const http = require("node:http");
  const payload = Buffer.from("contenido-de-video-de-prueba");

  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": String(payload.length) });
    res.end(payload);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const target = path.resolve("./tmp/fetch-download.mp4");

  try {
    const progress = [];
    const result = await downloadFile(`http://127.0.0.1:${port}/video.mp4`, target, {
      onProgress: (p) => progress.push(p),
    });

    assert.equal(result, target);
    assert.equal(fs.readFileSync(target, "utf8"), payload.toString());
    // Debe emitir al menos el evento final con percent 100.
    assert.ok(progress.some((p) => p.final === true && p.percent === 100));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("downloadFile (HLS) reporta progreso real usando la duración de ffprobe", async () => {
  const filePath = path.resolve("./tmp/hls-progress.mp4");
  const progress = [];

  const spawnFn = (command) => {
    const stream = fakeChild();
    if (/ffprobe/i.test(command)) {
      setImmediate(() => {
        stream.stdout.emit("data", "100\n"); // 100 s de duración total
        stream.emit("close", 0);
      });
    } else {
      setImmediate(() => {
        // ffmpeg emite tiempo procesado en microsegundos: 25s y 50s de 100s.
        stream.stdout.emit("data", "out_time_us=25000000\n");
        stream.stdout.emit("data", "out_time_us=50000000\n");
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, "x".repeat(1024));
        stream.emit("close", 0);
      });
    }
    return stream;
  };

  await downloadFile("https://example.com/video.m3u8", filePath, { spawnFn, onProgress: (p) => progress.push(p) });

  // Progreso intermedio real (no salta 0→100): 25% y 50%.
  const mids = progress.filter((p) => !p.final);
  assert.ok(mids.some((p) => Math.round(p.percent) === 25), "debe reportar ~25%");
  assert.ok(mids.some((p) => Math.round(p.percent) === 50), "debe reportar ~50%");
  assert.ok(mids.every((p) => p.unit === "time"), "HLS reporta en unidad de tiempo");
  assert.ok(progress.some((p) => p.final === true && p.percent === 100));
});

test("parseM3u8 extrae segmentos en orden y resuelve URLs relativas", () => {
  const body = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXTINF:9.9,",
    "seg0.ts",
    "#EXTINF:9.9,",
    "https://cdn2.example.com/seg1.ts",
  ].join("\n");

  const { segments, encrypted, master } = parseM3u8(body, "https://cdn1.example.com/video/index.m3u8");

  assert.equal(encrypted, false);
  assert.equal(master, false);
  assert.deepEqual(segments, [
    "https://cdn1.example.com/video/seg0.ts",
    "https://cdn2.example.com/seg1.ts",
  ]);
});

test("parseM3u8 detecta playlist cifrada y maestra (defiere a FFmpeg)", () => {
  const encrypted = parseM3u8("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"k.key\"\nseg.ts", "https://x/i.m3u8");
  assert.equal(encrypted.encrypted, true);

  const master = parseM3u8("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv/index.m3u8", "https://x/i.m3u8");
  assert.equal(master.master, true);

  // METHOD=NONE no cuenta como cifrado.
  const none = parseM3u8("#EXTM3U\n#EXT-X-KEY:METHOD=NONE\nseg.ts", "https://x/i.m3u8");
  assert.equal(none.encrypted, false);
});

test("downloadSegments descarga en paralelo respetando la concurrencia y el orden", async () => {
  const dir = path.resolve("./tmp/segs");
  fs.mkdirSync(dir, { recursive: true });
  const urls = Array.from({ length: 6 }, (_, i) => `https://cdn/seg${i}.ts`);

  let active = 0;
  let maxActive = 0;
  const doneOrder = [];

  const fetchFn = async (url) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10));
    active -= 1;
    // Byte de sincronización MPEG-TS (0x47) al inicio, como un .ts real.
    const bytes = Buffer.concat([Buffer.from([0x47]), Buffer.from(`data-${url}`)]);
    return {
      ok: true,
      headers: { get: () => "video/mp2t" },
      body: require("node:stream").Readable.toWeb(require("node:stream").Readable.from([bytes])),
    };
  };

  await downloadSegments(urls, dir, {
    concurrency: 3,
    fetchFn,
    onSegmentDone: (n) => doneOrder.push(n),
  });

  assert.ok(maxActive <= 3, "no debe exceder la concurrencia");
  assert.equal(doneOrder.length, 6);
  // Los 6 archivos existen con el padding correcto.
  for (let i = 0; i < 6; i += 1) {
    const f = path.join(dir, `seg-${String(i).padStart(6, "0")}.ts`);
    assert.ok(fs.existsSync(f), `falta ${f}`);
  }
});

test("downloadSegments rechaza páginas de error del CDN (no son MPEG-TS)", async () => {
  const dir = path.resolve("./tmp/segs-bad");
  fs.mkdirSync(dir, { recursive: true });

  // El CDN responde 200 pero con HTML de error en vez del .ts.
  const fetchFn = async () => ({
    ok: true,
    headers: { get: (h) => (h === "content-type" ? "text/html" : "") },
    body: require("node:stream").Readable.toWeb(
      require("node:stream").Readable.from([Buffer.from("<html>error</html>")])
    ),
  });

  await assert.rejects(
    () => downloadSegments(["https://cdn/seg0.ts"], dir, { fetchFn }),
    /segmento falló/
  );
});
