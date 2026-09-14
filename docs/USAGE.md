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

Esto resuelve el slug correcto antes de descargar.

## Episodios HLS y FFmpeg

Cuando un episodio se sirve como stream HLS (`.m3u8`), uwujacker usa FFmpeg para
generar el `.mp4` final. FFmpeg debe estar instalado y en el `PATH`; si falta, el
programa lo avisa con un mensaje claro. Descárgalo desde
[ffmpeg.org](https://ffmpeg.org/download.html). Los episodios en `mp4`/`mkv`/`webm`
directos no lo necesitan.

## Descargas en lote tolerantes a fallos

En descargas de rango o `all`, si un episodio falla el resto continúa. Al terminar
se muestra un resumen con el total completado, los OK, los errores y la lista de
episodios que fallaron.
