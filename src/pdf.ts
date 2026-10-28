import * as fs from "fs";
import * as path from "path";
import { AxiosInstance, AxiosResponse } from "axios";
import { load } from "cheerio";
import { BASE_URL, RETRY } from "./config";
import { readViewState } from "./html";
import { assertNotErrorPage, decodeBody } from "./http";
import { Documento } from "./types";
import { withRetry } from "./utils/retry";

/** Opciones comunes: las redirecciones las seguimos nosotros, paso a paso. */
const requestOptions = (referer: string) => ({
  maxRedirects: 0,
  validateStatus: (status: number) => status >= 200 && status < 400,
  headers: { Referer: referer },
});

/**
 * Sigue las redirecciones (302) hasta llegar al archivo y comprueba que sea un PDF.
 * El sitio redirige a direcciones con un "cid" que cambia en cada sesión, por eso
 * no se pueden guardar para después: hay que seguirlas de inmediato.
 */
async function followToPdf(
  http: AxiosInstance,
  response: AxiosResponse<Buffer>,
  referer: string
): Promise<Buffer> {
  let res = response;
  for (let hop = 0; hop < 4 && res.status >= 300 && res.status < 400; hop++) {
    const location = res.headers["location"];
    if (typeof location !== "string") {
      throw new Error("Redirección sin cabecera Location");
    }
    res = await http.get<Buffer>(location, requestOptions(referer));
  }

  const bytes = Buffer.from(res.data);
  // Todo PDF empieza con "%PDF". Si no, el servidor devolvió otra cosa.
  if (bytes.subarray(0, 4).toString("latin1") !== "%PDF") {
    throw new Error("La respuesta no es un PDF");
  }
  return bytes;
}

/** Documento tipo "enlace-pdf": el enlace responde con una redirección hacia el PDF. */
async function fetchFromPdfLink(
  http: AxiosInstance,
  href: string,
  referer: string
): Promise<Buffer> {
  const res = await http.get<Buffer>(href, requestOptions(referer));
  return followToPdf(http, res, referer);
}

/**
 * Documento tipo "vista-html": el enlace abre una página con el texto del documento
 * y un botón "Gerar PDF". Ese botón no es un enlace: envía un formulario (POST) cuyos
 * datos (un token "ca" y un "idProcDocBin") están escritos en su propio onclick.
 * Aquí hacemos lo mismo que haría el navegador al pulsarlo.
 */
async function fetchFromHtmlView(
  http: AxiosInstance,
  viewUrl: string,
  referer: string
): Promise<Buffer> {
  // 1. Abrir la vista del documento.
  const view = await http.get<Buffer>(viewUrl, { headers: { Referer: referer } });
  const $ = load(assertNotErrorPage(decodeBody(view.data), "la vista del documento"));

  // 2. Leer los datos del botón "Gerar PDF".
  const onclick = $('a[id$=":downloadPDF"]').first().attr("onclick") ?? "";
  const match = onclick.match(/jsfcljs\(document\.getElementById\('([^']+)'\),\{([^}]*)\}/);
  if (!match) throw new Error('La vista del documento no tiene el botón "Gerar PDF"');
  const [, formId, paramText] = match;

  const action = $(`form[id="${formId}"]`).first().attr("action");
  if (!action) throw new Error("No encontré el formulario de descarga del documento");

  const fields: Record<string, string> = {
    [formId]: formId,
    "javax.faces.ViewState": readViewState($) ?? "j_id1",
  };
  for (const pair of paramText.matchAll(/'([^']+)':'([^']*)'/g)) {
    fields[pair[1]] = pair[2];
  }

  // 3. Enviar el formulario: el sitio responde con el PDF.
  const res = await http.post<Buffer>(action, new URLSearchParams(fields).toString(), {
    ...requestOptions(viewUrl),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Origin: BASE_URL,
      Referer: viewUrl,
    },
  });
  return followToPdf(http, res, viewUrl);
}

/**
 * Descarga el PDF de un documento y lo guarda en "destPath". Devuelve su tamaño en bytes.
 *
 * Si el servidor responde 429 (demasiadas peticiones), withRetry espera y reintenta
 * con backoff exponencial; el proceso completo (abrir la vista, enviar el formulario)
 * se repite desde el principio, porque los enlaces solo valen para la sesión actual.
 */
export async function downloadDocument(
  http: AxiosInstance,
  doc: Documento,
  referer: string,
  destPath: string
): Promise<number> {
  const data = await withRetry(
    () =>
      doc.origen === "vista-html"
        ? fetchFromHtmlView(http, doc.href, referer)
        : fetchFromPdfLink(http, doc.href, referer),
    RETRY,
    "descarga de PDF"
  );

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  // Se escribe primero con extensión .part y luego se renombra, para que un
  // archivo a medias nunca se confunda con una descarga completa.
  const tempPath = `${destPath}.part`;
  fs.writeFileSync(tempPath, data);
  fs.renameSync(tempPath, destPath);
  return data.length;
}
