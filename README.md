# Scraper de la Consulta Pública del PJe (TRF5)

Scraper en **TypeScript** para <https://pjett.trf5.jus.br/pjeconsulta/ConsultaPublica/listView.seam>, hecho solo con peticiones HTTP (`axios`) y lectura de HTML (`cheerio`). **No usa automatización de navegador** (ni Puppeteer, ni Playwright, ni Selenium).

Para cada proceso extrae los datos de la página de detalle (datos generales, partes del polo activo y pasivo, movimientos y lista de documentos) y descarga los PDFs asociados.

## Requisitos

- Node.js 18 o superior
- npm

## Instalación

```bash
npm install
```

## Uso

```bash
npm start
```

Sin opciones, consulta el día `2024-03-15`. Se puede ajustar con:

| Opción | Descripción |
| --- | --- |
| `--from AAAA-MM-DD` | Primer día de *autuação* a consultar |
| `--to AAAA-MM-DD` | Último día (por defecto, el mismo que `--from`) |
| `--max-processes N` | Extraer como máximo N procesos |
| `--max-docs N` | Descargar como máximo N PDFs por proceso |
| `--no-pdfs` | Extraer los datos pero no descargar PDFs |
| `--search-only` | Solo cuenta los procesos de cada día (no abre detalles ni descarga) y anota los días recortados |
| `--delay MS` | Pausa entre peticiones, en milisegundos (por defecto 800) |
| `--help` | Mostrar la ayuda |

Ejemplos (con `npm`, las opciones van después de `--`):

```bash
# Prueba rápida: 2 procesos, 3 PDFs por proceso
npm start -- --max-processes 2 --max-docs 3

# Una semana completa
npm start -- --from 2024-03-11 --to 2024-03-15

# Solo datos, sin PDFs
npm start -- --no-pdfs
```

Otros comandos: `npm run typecheck` (revisa los tipos) y `npm run build` (compila a `dist/`).

## Qué genera

```
output/
  procesos/<numero>.json     datos completos de cada proceso
  completed.txt              procesos terminados (con todos sus PDFs)
  failed-downloads.json      PDFs que no se pudieron descargar
  failed-processes.json      procesos que fallaron
  truncated-days.json        días en que el sitio recortó los resultados
downloads/
  <numero>/<fecha>_<tipo>_<id>.pdf
```

Ambas carpetas están en `.gitignore`: los datos son de procesos judiciales reales y no se suben al repositorio.

### Cómo se reintentan los fallos

Al volver a ejecutar el scraper, retoma donde quedó: omite los procesos de `completed.txt` y los PDFs que ya están en disco. Un proceso con descargas fallidas no se marca como completo, así que la siguiente ejecución lo vuelve a procesar y reintenta solo los PDFs que faltan. Los PDFs que se bajan bien salen de `failed-downloads.json`.

## Cómo funciona

El sitio está hecho con JavaServer Faces (RichFaces): no tiene una API, y cada botón envía un formulario con un valor oculto llamado `ViewState`. El scraper imita esas peticiones.

1. **Sesión.** Un `GET` a la página inicial entrega las cookies (`JSESSIONID`...) y el `ViewState`. `src/http.ts` las guarda y las reenvía.
2. **Búsqueda.** El sitio exige al menos un filtro y muestra como máximo 30 resultados por búsqueda. Por eso el scraper recorre el sitio **día por día** usando la fecha de autuação (`src/search.ts`). Si un día supera el tope, el sitio avisa y el día queda registrado en `truncated-days.json`.
3. **Detalle de cada proceso** (`src/detail.ts`). La dirección del detalle sale del `onclick` del título de cada fila. Dentro del detalle hay cuatro bloques paginados:
   - *Polo activo* y *Polo pasivo*: paginador de números.
   - *Movimentações* y *Documentos juntados*: control deslizante.

   Los identificadores de cada paginador (`j_id561`, `j_id474`...) se leen del propio HTML, no están escritos a mano. Después de leer todas las páginas, se compara con el total que declara el sitio ("65 resultados encontrados") y se avisa si no coinciden.
4. **PDFs** (`src/pdf.ts`). Hay dos tipos de documento y el scraper reconoce ambos:
   - *enlace-pdf*: el enlace del documento responde con una redirección (302) a `download.seam?cid=NNN`. Ese `cid` cambia en cada sesión, así que se pide y se sigue de inmediato.
   - *vista-html*: el botón abre una vista HTML del documento que trae un botón "Gerar PDF". Ese botón envía un formulario (`POST`) con unos datos escritos en su propio `onclick` (un token `ca` y un `idProcDocBin`); el scraper lee esos datos y envía el mismo formulario, y el sitio responde con el PDF.

   En ambos casos se comprueba que el contenido empiece con `%PDF`, y los archivos se escriben como `.part` y se renombran al terminar. El "comprobante de protocolo" de cada documento no se descarga.
5. **Codificación.** El sitio mezcla UTF-8 y Latin-1 en una misma página; `decodeBody` en `src/http.ts` lo resuelve para no perder acentos.

## Errores 429 y reintentos

`src/utils/retry.ts` envuelve todas las peticiones:

- Detecta el error **429** (y también errores 5xx y cortes de red).
- Reintenta hasta 5 veces con **backoff exponencial**: 2 s, 4 s, 8 s, 16 s... más hasta 1 s al azar, con tope de 60 s. Respeta la cabecera `Retry-After` si el servidor la envía.
- Si el error persiste, la descarga se marca como fallida, se registra en `failed-downloads.json` y el scraper **continúa con el siguiente documento**.
- El sitio a veces responde con su propia página de error ("Unhandled or Wrapper Exception") con código HTTP 200. El scraper la reconoce, no guarda datos vacíos, registra el proceso en `failed-processes.json` y no lo marca como completo, así que la siguiente ejecución lo vuelve a intentar.
- Además hay una pausa mínima entre peticiones (`--delay`), y el scraper se detiene si 5 procesos seguidos fallan, para no sobrecargar el sitio.

## Límites conocidos

- **Tope de 30 resultados por búsqueda.** Si en un día hay más de 30 procesos, el sitio solo muestra los primeros 30 y avisa. El scraper lo detecta y lo registra en `truncated-days.json`, pero no puede completar ese día. Se probó dividirlo con filtros parciales del número de proceso (por ejemplo, el código de origen `8300`), pero el sitio no devuelve resultados con filtros parciales; los demás filtros (nombre de la parte, abogado, OAB, CPF/CNPJ) exigen conocer de antemano un dato concreto. Para medir el efecto, `--search-only` cuenta los procesos de cada día: en marzo de 2024 se listaron 593 procesos en 31 días, y 5 de esos días (1, 8, 13, 20 y 27) quedaron recortados.
- **Detalles que el sitio no entrega.** Algunos procesos hacen que el sitio responda con su página de error al pedir el detalle (3 de 29 el 15/03/2024). El scraper los registra en `failed-processes.json` y los vuelve a intentar en la siguiente ejecución.
- Si el sitio cambia su estructura (ids, clases CSS), los selectores de `src/search.ts` y `src/detail.ts` tendrían que actualizarse.

## Estructura del proyecto

```
src/
  index.ts        entrada y opciones de línea de comandos
  scraper.ts      recorre los días, procesos y documentos; guarda resultados y registros
  search.ts       búsqueda por fecha y lectura de la lista de resultados
  detail.ts       detalle de un proceso, paginación y lista de documentos
  pdf.ts          descarga de PDFs
  http.ts         cliente HTTP con cookies, pausas y decodificación de texto
  html.ts         utilidades de lectura de HTML
  config.ts       direcciones y valores ajustables
  types.ts        tipos de datos
  utils/          sleep, reintentos con backoff y fechas
```
