# uwujacker

CLI para descargar episodios de anime desde JKAnime.

## Requisitos

- Node.js 18 o superior
- Yarn (se usa como gestor de dependencias por defecto)

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
- `-e, --episode`: episodio concreto, `all`, o un rango como `3-6`
- `-r, --range`: rango o lista específica, por ejemplo `3-6` o `1,3,5`
- `-f, --folder`: carpeta de destino. Si no se indica, se usa `./animes/<slug>`
- `-c, --concurrency`: número máximo de descargas paralelas cuando se usa `all` o un rango (por defecto: 5)
- `--search`: busca el slug correcto antes de descargar
- `--skip-existing`: omite archivos ya descargados
- `--overwrite`: fuerza re-descarga
- `-v, --verbose`: muestra más logs
- `-h, --help`: muestra ayuda

## Observaciones

- El programa crea la carpeta destino si no existe.
- Si no se indica `-f`, se usa automáticamente `animes/<slug>`.
- Si se especifica una ruta manual, esa ruta se respetará exactamente.
- Los archivos se guardan con el formato `NOMBRE_ANIME-EPISODIO.mp4`.
- Si la web de JKAnime cambia su HTML o su API, puede requerir ajuste de selectores.
- La salida por consola está diseñada para ser compatible con CMD y PowerShell.

## Tests

```bash
yarn test
```
