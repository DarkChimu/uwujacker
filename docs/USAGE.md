# Uso de uwujacker

## Descarga rápida

```bash
uwujacker -a dr-stone -e 1
```

Por defecto, si no indicas `-f`, el programa crea la carpeta:

```bash
./animes/dr-stone/
```

## Descarga por rango

```bash
uwujacker -a dr-stone -e 3-6
uwujacker -a dr-stone --range 3-6
uwujacker -a dr-stone --range 1,3,5
```

Todos los episodios del rango se muestran en paralelo usando el mismo estilo visual que `-e all`.

## Descarga completa

```bash
uwujacker -a dr-stone -e all
```

## Carpeta personalizada

```bash
uwujacker -a dr-stone -e 1 -f ./mis-descargas
```

La ruta indicada se usará tal cual.

## Búsqueda por nombre

```bash
uwujacker --search "Dragon Ball" -e 1
```

Cuando hay varias coincidencias (ediciones, temporadas o variantes del nombre),
uwujacker muestra una lista interactiva para que elijas el anime: navega con las
flechas ↑/↓, confirma con Enter (o Espacio) y cancela con Esc. Tras elegir, se
inicia la descarga. Con una única coincidencia se selecciona automáticamente. En
entornos no interactivos (salida por pipe o CI) se muestra una lista numerada y,
si no puede leerse una respuesta, se toma la primera coincidencia. Esto solo
aplica a `--search`; con `-a/--anime` se usa el nombre/slug tal cual.

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
