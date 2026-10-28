import { DEFAULT_DATE, DEFAULT_DELAY_MS } from "./config";
import { runScraper } from "./scraper";
import { isIsoDate } from "./utils/dates";

const args = process.argv.slice(2);

const value = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name: string): boolean => args.includes(`--${name}`);

function fail(message: string): never {
  console.error(`Error: ${message}\nUsa --help para ver las opciones.`);
  process.exit(1);
}

function readInteger(name: string): number | null {
  const raw = value(name);
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) fail(`--${name} debe ser un número entero mayor o igual a 0`);
  return n;
}

if (flag("help")) {
  console.log(`Scraper de la Consulta Pública del PJe (TRF5)

Uso:  npm start -- [opciones]

Opciones:
  --from AAAA-MM-DD      primer día de autuação a consultar (por defecto ${DEFAULT_DATE})
  --to AAAA-MM-DD        último día (por defecto, el mismo que --from)
  --max-processes N      extraer como máximo N procesos
  --max-docs N           descargar como máximo N PDFs por proceso
  --no-pdfs              extraer datos, pero no descargar PDFs
  --search-only          solo contar los procesos de cada día (no abre detalles ni descarga)
  --delay MS             pausa entre peticiones en milisegundos (por defecto ${DEFAULT_DELAY_MS})
  --help                 mostrar esta ayuda`);
  process.exit(0);
}

const from = value("from") ?? DEFAULT_DATE;
const to = value("to") ?? from;
if (!isIsoDate(from)) fail(`--from "${from}" no es una fecha válida (usa AAAA-MM-DD)`);
if (!isIsoDate(to)) fail(`--to "${to}" no es una fecha válida (usa AAAA-MM-DD)`);
if (to < from) fail("--to no puede ser anterior a --from");

runScraper({
  from,
  to,
  delayMs: readInteger("delay") ?? DEFAULT_DELAY_MS,
  maxProcesses: readInteger("max-processes"),
  maxDocs: readInteger("max-docs"),
  downloadPdfs: !flag("no-pdfs"),
  searchOnly: flag("search-only"),
}).catch((error: unknown) => {
  console.error("Error fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
