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
