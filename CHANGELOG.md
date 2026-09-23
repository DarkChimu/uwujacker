# Changelog

## [1.2.0] - 2026-09-23

### Added
- Selección interactiva del anime en `--search`: cuando la búsqueda devuelve varias coincidencias (ediciones, temporadas o variantes del nombre) se muestra un menú navegable con las flechas ↑/↓ (o `k`/`j`) que resalta la opción actual; se confirma con Enter/Espacio y se cancela con Esc/`q`. Muestra solo el título del anime. Con una única coincidencia se selecciona automáticamente y en entornos no interactivos (pipe/CI) se usa una lista numerada o la primera coincidencia. No aplica a `-a/--anime`. Sin dependencias nuevas (raw-mode stdin + `readline`).

### Fixed
- Corregida la búsqueda (`ajax_search` devolvía 419 "Page Expired"): JKAnime movió el token CSRF al `<meta name="csrf-token">` y lo valida contra la cookie de sesión. Ahora el token se lee del meta (con fallbacks) y la cookie del home se reenvía en la petición, así que la búsqueda vuelve a devolver todas las coincidencias en lugar de caer al slug normalizado (p. ej. `uma musume` mostraba solo `uma-musume`).

## [1.1.1] - 2026-09-16

### Fixed
- Corregida la detección del número de episodios en `-e all`: antes contaba números no relacionados del HTML y planificaba episodios inexistentes (p. ej. 50+ para una serie de 13). Ahora se detecta el último episodio real comprobando su existencia página por página (búsqueda exponencial + binaria, O(log n) peticiones).
- Corregido el render del progreso en descargas en lote: solo se muestran las barras de las descargas activas (según la concurrencia), evitando que un bloque de decenas de barras desborde el alto del terminal. Las barras se limpian al completarse y el resumen final es el único registro de resultados, evitando líneas duplicadas ("barra congelada" + mensaje) que aparecían en Windows/PowerShell.

## [1.1.0] - 2026-09-15

### Added
- Descarga paralela de segmentos HLS: los `.ts` se bajan concurrentemente con `fetch` y FFmpeg solo hace el mux final. En pruebas reales, un episodio de ~24 min pasó de varios minutos a menos de un minuto.
- Validación de segmentos HLS: se rechazan respuestas que no son video (páginas de error HTML/JSON del CDN o datos que no empiezan con el byte de sincronización MPEG-TS `0x47`), evitando archivos corruptos.
- Progreso real durante descargas HLS: se consulta la duración con `ffprobe` y se muestra el avance por tiempo/segmentos, en lugar de saltar de 0 a 100 %.
- Barras de progreso con `cli-progress` (una barra por episodio en descargas paralelas), con modo indeterminado cuando el servidor no informa el tamaño.
- Mensaje claro cuando falta FFmpeg (con enlace de instalación) en lugar de un error críptico.

### Changed
- Se prefiere el player con MP4 directo (`jk`) sobre los servidores HLS (`um`/`umv`/`c1`), de modo que la mayoría de episodios se descargan sin FFmpeg.
- El extractor de video reconoce el MP4 declarado por el player aunque la URL no tenga extensión.
- HTTP migrado a `fetch` nativo (Node 18+); se eliminó la dependencia `axios`.
- Descargas en lote tolerantes a fallos: un episodio que falla ya no aborta el resto; se listan los fallidos en el resumen.
- Unificado el parseo de argumentos y la capa de scraping (menos código duplicado).

### Fixed
- Corregida la unión de segmentos HLS que producía un archivo diminuto e inservible: ahora se concatenan en orden mediante un único flujo y el archivo se cierra por completo antes del mux.
- Eliminado el `MaxListenersExceededWarning` que aparecía al unir muchos segmentos.

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
