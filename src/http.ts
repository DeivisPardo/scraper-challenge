import axios, { AxiosInstance } from "axios";
import { BASE_URL, RETRY } from "./config";
import { sleep } from "./utils/sleep";
import { withRetry } from "./utils/retry";

/** Guarda las cookies que entrega el servidor y las reenvía en cada petición. */
export class CookieJar {
  private cookies = new Map<string, string>();

  update(setCookieHeaders?: string[]): void {
    if (!setCookieHeaders) return;
    for (const line of setCookieHeaders) {
      const pair = line.split(";")[0]; // nos quedamos con "nombre=valor"
      const eq = pair.indexOf("=");
      if (eq > 0) {
        this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    }
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

/**
 * Convierte los bytes de una respuesta en texto.
 * Algunas partes del sitio llegan en UTF-8 y otras en Latin-1 (en el mismo HTML),
 * así que decodificamos como UTF-8 y, donde los bytes no son válidos, los
 * tratamos como Latin-1. Así los acentos (Á, õ, É...) no se pierden.
 */
export function decodeBody(data: ArrayBuffer | Buffer): string {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  try {
    return utf8.decode(buf); // caso normal: todo es UTF-8 válido
  } catch {
    // contenido mixto: seguimos byte a byte
  }

  const latin1 = new TextDecoder("windows-1252");
  let out = "";
  let i = 0;
  while (i < buf.length) {
    const byte = buf[i];
    let length = 1;
    if (byte >= 0xc2 && byte <= 0xdf) length = 2;
    else if (byte >= 0xe0 && byte <= 0xef) length = 3;
    else if (byte >= 0xf0 && byte <= 0xf4) length = 4;

    if (length > 1 && i + length <= buf.length) {
      try {
        out += utf8.decode(buf.subarray(i, i + length));
        i += length;
        continue;
      } catch {
        // no era una secuencia UTF-8 válida
      }
    }
    out += byte < 0x80 ? String.fromCharCode(byte) : latin1.decode(buf.subarray(i, i + 1));
    i += 1;
  }
  return out;
}

/**
 * Crea un cliente HTTP que:
 *  - guarda y reenvía las cookies de sesión automáticamente,
 *  - espera "delayMs" entre una petición y la siguiente,
 *  - recibe las respuestas como bytes (se decodifican con decodeBody).
 */
export function createClient(delayMs: number): AxiosInstance {
  const jar = new CookieJar();
  let lastRequestAt = 0;

  const http = axios.create({
    baseURL: BASE_URL,
    timeout: 30000,
    responseType: "arraybuffer",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "pt-BR,pt;q=0.9",
    },
  });

  // Antes de cada petición: respetar la pausa y agregar las cookies guardadas.
  http.interceptors.request.use(async (config) => {
    const wait = lastRequestAt + delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    const cookie = jar.header();
    if (cookie) config.headers.set("Cookie", cookie);
    return config;
  });

  // Después de cada respuesta: guardar las cookies nuevas.
  http.interceptors.response.use(
    (response) => {
      jar.update(response.headers["set-cookie"]);
      return response;
    },
    (error) => {
      jar.update(error.response?.headers?.["set-cookie"]);
      return Promise.reject(error);
    }
  );

  return http;
}

/**
 * El sitio a veces responde con su propia página de error ("Unhandled or Wrapper
 * Exception") con código HTTP 200. Sin esta revisión, esa página se leería como si
 * fuera un detalle vacío. Estas marcas no aparecen en las páginas normales.
 */
export class SiteErrorPage extends Error {}

export function assertNotErrorPage(html: string, what: string): string {
  if (html.includes("Unhandled or Wrapper Exception") || html.includes("errorUnexpected.seam")) {
    throw new SiteErrorPage(`El sitio devolvió su página de error al pedir ${what}`);
  }
  return html;
}

/** GET que devuelve el HTML ya decodificado. Reintenta ante errores 429. */
export async function getHtml(
  http: AxiosInstance,
  path: string,
  referer?: string
): Promise<string> {
  return withRetry(
    async () => {
      const res = await http.get<Buffer>(path, {
        headers: referer ? { Referer: referer } : {},
      });
      return assertNotErrorPage(decodeBody(res.data), path.slice(0, 70));
    },
    RETRY,
    `GET ${path.slice(0, 70)}`
  );
}

/** POST de formulario (así funcionan los botones y paginadores del sitio). */
export async function postForm(
  http: AxiosInstance,
  path: string,
  fields: Record<string, string>,
  referer: string
): Promise<string> {
  const body = new URLSearchParams(fields).toString();
  return withRetry(
    async () => {
      const res = await http.post<Buffer>(path, body, {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Origin: BASE_URL,
          Referer: referer,
        },
      });
      return assertNotErrorPage(decodeBody(res.data), path.slice(0, 70));
    },
    RETRY,
    `POST ${path.slice(0, 70)}`
  );
}
