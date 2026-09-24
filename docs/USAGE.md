# Uso de uwujacker

La forma recomendada de usar uwujacker es buscar por nombre con `--search` y
elegir el anime (o varios) de una lista interactiva. No necesitas conocer el
slug exacto: escribe el nombre y el programa te muestra las coincidencias.

## Búsqueda por nombre (recomendado)

```bash
uwujacker --search "uma musume"
```

Se muestra una lista interactiva (con el nombre y versión del proyecto en la
cabecera) con todas las coincidencias: ediciones, temporadas y variantes del
nombre. En el menú:

- Navega con las flechas ↑/↓.
- Marca/desmarca con **Espacio** (puedes elegir varios animes a la vez).
- Confirma con **Enter**; cancela con **Esc**.
- Al salir del menú, la lista se limpia de la consola.

Después de confirmar, si no indicaste `-e/--episode`, se te pregunta qué
descargar. La respuesta acepta lo mismo que `-e`: un número, un rango `3-6`, una
lista `1,3,5` o `all`. Esa selección se aplica a todos los animes marcados.

También puedes pasar el episodio de una vez con `-e`:

```bash
uwujacker --search "dragon ball" -e 1
uwujacker --search "dragon ball" -e 1-12
uwujacker --search "dragon ball" -e all
```

Cada anime se guarda en `./animes/<slug>/`. Si pasas `-f/--folder`, las descargas
se anidan en `<folder>/<slug>/` para no mezclarse.

Cuando descargas varios animes a la vez, al final se imprime un único resumen
consolidado: una línea por anime con su título y un `✓`/`✗` según el resultado,
el detalle de los episodios fallidos bajo cada anime, y una línea de totales
(animes, episodios completados y fallos).

Con una única coincidencia se selecciona automáticamente. En entornos no
interactivos (salida por pipe o CI) se toma la primera coincidencia.

## Uso avanzado

Si ya conoces el slug del anime puedes ir directo con `-a/--anime`, sin pasar por
la búsqueda ni el menú.

### Descarga rápida

```bash
uwujacker -a dr-stone -e 1
```

Por defecto, si no indicas `-f`, el programa crea la carpeta:

```bash
./animes/dr-stone/
```

### Descarga por rango

```bash
uwujacker -a dr-stone -e 3-6
uwujacker -a dr-stone --range 3-6
uwujacker -a dr-stone --range 1,3,5
```

Todos los episodios del rango se muestran en paralelo usando el mismo estilo visual que `-e all`.

### Descarga completa

```bash
uwujacker -a dr-stone -e all
```

### Carpeta personalizada

```bash
uwujacker -a dr-stone -e 1 -f ./mis-descargas
```

La ruta indicada se usará tal cual.

## MP4 directo vs HLS

uwujacker prefiere el servidor que ofrece un MP4 directo, así que la mayoría de
episodios se descargan sin FFmpeg y muestran una barra de progreso normal.

Cuando un episodio solo está disponible como stream HLS (`.m3u8`), uwujacker
descarga los segmentos `.ts` en paralelo y usa FFmpeg para unirlos en el `.mp4`
final. La barra muestra el avance real (por tiempo o por segmentos), no un salto
de 0 a 100.

### FFmpeg (solo para HLS)

Los episodios HLS requieren **FFmpeg** (incluye `ffprobe`) en el `PATH`. Si falta,
el programa lo avisa con un mensaje claro.

```bash
# macOS
brew install ffmpeg
# Windows / Linux: https://ffmpeg.org/download.html
ffmpeg -version   # verificar
```

## Descargas en lote tolerantes a fallos

En descargas de rango o `all`, si un episodio falla el resto continúa. Cada
episodio muestra su propia barra de progreso y, al terminar, se muestra un
resumen con el total completado, los OK, los errores y la lista de episodios que
fallaron.
