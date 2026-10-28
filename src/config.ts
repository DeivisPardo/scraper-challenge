/**
 * Configuración central del scraper.
 * Aquí viven las direcciones del sitio y los valores que se pueden ajustar.
 */

export const BASE_URL = "https://pjett.trf5.jus.br";
export const LIST_PATH = "/pjeconsulta/ConsultaPublica/listView.seam";
export const DETAIL_POST_PATH =
  "/pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam";

// Carpetas de salida (ambas están en .gitignore).
export const OUTPUT_DIR = "output"; // datos en JSON y registros
export const DOWNLOADS_DIR = "downloads"; // PDFs

// Pausa mínima entre peticiones, en milisegundos (se puede cambiar con --delay).
export const DEFAULT_DELAY_MS = 800;

// Reintentos ante errores 429 (y otros errores temporales).
export const RETRY = { maxAttempts: 5, baseDelayMs: 2000 };

// Día que se consulta si no se indica --from (tiene 29 procesos, menos que el tope de 30).
export const DEFAULT_DATE = "2024-03-15";
