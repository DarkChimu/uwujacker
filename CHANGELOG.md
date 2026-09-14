# Changelog

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
