# Changelog

## [1.1.0] - 2026-09-15

### Added
- Descarga paralela de segmentos HLS: los `.ts` se bajan concurrentemente con `fetch` y FFmpeg solo hace el mux final. En pruebas reales, un episodio de ~24 min pasó de varios minutos a menos de un minuto.
- Progreso real durante descargas HLS: se consulta la duración con `ffprobe` y se muestra el avance por tiempo/segmentos, en lugar de saltar de 0 a 100 %.
- Barras de progreso con `cli-progress` (una barra por episodio en descargas paralelas), con modo indeterminado cuando el servidor no informa el tamaño.
- Mensaje claro cuando falta FFmpeg (con enlace de instalación) en lugar de un error críptico.

### Changed
- Se prefiere el player con MP4 directo (`jk`) sobre los servidores HLS (`um`/`umv`/`c1`), de modo que la mayoría de episodios se descargan sin FFmpeg.
- El extractor de video reconoce el MP4 declarado por el player aunque la URL no tenga extensión.
- HTTP migrado a `fetch` nativo (Node 18+); se eliminó la dependencia `axios`.
- Descargas en lote tolerantes a fallos: un episodio que falla ya no aborta el resto; se listan los fallidos en el resumen.
- Unificado el parseo de argumentos y la capa de scraping (menos código duplicado).

### Removed
- Dependencias sin uso: `adm-zip`, `cloudscraper`, `request`, `axios` y `progress`. El proyecto depende ahora solo de `cheerio`, `yargs` y `cli-progress`.
- Opciones de CLI que no tenían efecto real (`--server`, `--quality`, `--zip`, `--retries`).

## [1.0.2] - 2026-09-14

### Fixed
- Corregida la extracción de URLs del player de JKAnime para rutas modernas (`/jkplayer/um`, `/umv`, `/c1`).
- Corregido el caso donde el extractor devolvía un manifiesto `.m3u8` en lugar del archivo de video real.
- Añadido soporte para convertir streams HLS con FFmpeg antes de guardar el archivo final.
- Reforzada la validación de descargas para evitar archivos vacíos o demasiado pequeños.

### Changed
- Se actualizó la versión del proyecto para preparar un nuevo release en GitHub.

## [1.0.1] - 2026-09-13

### Fixed
- Corregido el render del progreso para no acumular líneas en el terminal.
- Mejorado el refresco del bloque de descargas en terminales TTY.
- Añadida validación de regresión para el render en pruebas automáticas.

### Changed
- Preparado el proyecto para un release limpio en GitHub.

## [1.0.0] - 2026-09-13

### Added
- CLI para descargar episodios de anime desde JKAnime.
- Búsqueda por slug mediante nombre del anime.
- Descargas paralelas por rango y por todos los episodios disponibles.
- Soporte para carpeta personalizada y salto de archivos ya descargados.
