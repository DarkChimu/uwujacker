# uwujacker

CLI para descargar episodios de anime desde JKAnime.

## Requisitos

- Node.js 18 o superior (usa `fetch` y streams web nativos)
- Yarn (se usa como gestor de dependencias por defecto)
- FFmpeg + ffprobe (opcional, solo para episodios en formato HLS `.m3u8`)

## Instalación

```bash
yarn install
```

## Uso

Si no pasas `-f`, el programa crea una carpeta automática siguiendo el slug del anime:

```bash
uwujacker -a dr-stone -e 1
```

Esto descargará en:

```bash
./animes/dr-stone/
```

Descargar un episodio concreto con carpeta manual:

```bash
uwujacker -a dr-stone -e 1 -f ./animes/drstone
```

Descargar un rango de episodios:

```bash
uwujacker -a dr-stone -e 3-6
uwujacker -a dr-stone --range 3-6
uwujacker -a dr-stone --range 1,3,5
```

Descargar todos los episodios disponibles:

```bash
uwujacker -a dr-stone -e all
```

Buscar por nombre/slug antes de descargar:

```bash
uwujacker --search "Dragon Ball" -e 1
```

Ejecutar directamente con Yarn:

```bash
yarn download -- --anime dr-stone --episode 3-6
```

## Opciones

- `-a, --anime`: nombre o slug del anime
- `-e, --episode`: episodio concreto, `all`, un rango como `3-6` o una lista `1,3,5` (por defecto: `1`)
- `-r, --range`: rango o lista específica, por ejemplo `3-6` o `1,3,5`
- `-f, --folder`: carpeta de destino. Si no se indica, se usa `./animes/<slug>`
- `-c, --concurrency`: número máximo de descargas paralelas cuando se usa `all` o un rango (por defecto: 5)
- `--search`: busca el slug correcto antes de descargar
- `--skip-existing`: omite archivos ya descargados (activo por defecto)
- `--overwrite`: fuerza re-descarga
- `-v, --verbose`: muestra más logs
- `-h, --help`: muestra ayuda

## Observaciones

- El programa crea la carpeta destino si no existe.
- Si no se indica `-f`, se usa automáticamente `animes/<slug>`.
- Si se especifica una ruta manual, esa ruta se respetará exactamente.
- Los archivos se guardan con el formato `NOMBRE_ANIME-EPISODIO.mp4`.
- Cuando un episodio ofrece MP4 directo, uwujacker lo prefiere y lo descarga sin FFmpeg.
- Al descargar un rango o `all`, un episodio que falle no detiene el resto: los fallos se listan al final en el resumen, con una barra de progreso por episodio.
- Si la web de JKAnime cambia su HTML o su API, puede requerir ajuste de selectores.
- La salida por consola está diseñada para ser compatible con CMD y PowerShell.

## FFmpeg (episodios HLS)

La mayoría de episodios se descargan como MP4 directo y **no** requieren FFmpeg. Solo hace falta para episodios que únicamente se ofrecen como stream HLS (`.m3u8`): en ese caso, uwujacker descarga los segmentos en paralelo y usa FFmpeg para unirlos en el `.mp4` final.

Para esos episodios necesitas **FFmpeg** (con `ffprobe`, que viene incluido) instalado y accesible en el `PATH`. Si falta, uwujacker lo indica con un mensaje claro. Instalación:

- macOS: `brew install ffmpeg`
- Windows / Linux: descárgalo desde [ffmpeg.org](https://ffmpeg.org/download.html)

Comprueba que quedó disponible con `ffmpeg -version`.

## Tests

```bash
yarn test
```

## Releases (builds automáticas)

Los binarios se compilan automáticamente con GitHub Actions al publicar un tag de versión. El flujo (`.github/workflows/release.yml`) compila en Windows, macOS y Linux y adjunta los binarios a un GitHub Release.

Para lanzar una versión:

```bash
# 1. Asegúrate de que package.json tiene la versión correcta y está commiteada
# 2. Crea y empuja el tag
git tag v1.1.0
git push origin v1.1.0
```

Esto genera el release con:

- `uwujacker-windows.exe` (Windows)
- `uwujacker-macos-arm64` (macOS Apple Silicon)
- `uwujacker-linux` (Linux)

Los binarios de macOS/Linux no llevan extensión; dales permiso de ejecución si hace falta (`chmod +x uwujacker-linux`).
