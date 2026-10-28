import { AxiosInstance } from "axios";
import { CheerioAPI, load } from "cheerio";
import { BASE_URL, DETAIL_POST_PATH, LIST_PATH } from "./config";
import { clean, readTotal, readViewState, textOfFragment } from "./html";
import { getHtml, postForm } from "./http";
import { Documento, Movimiento, Participante, ProcessData } from "./types";

// Cada tabla de la página de detalle se reconoce por el final de su id.
const POLO_ACTIVO = "PoloAtivoResumidoList";
const POLO_PASIVO = "PoloPassivoResumidoList";
const MOVIMIENTOS = "processoEvento:tb";
const DOCUMENTOS = "processoDocumentoGridTab:tb";

const DATE_TIME = /^(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2})/;

// ---------------------------------------------------------------------------
// Lectura de la primera página (el HTML que entrega el GET del detalle)
// ---------------------------------------------------------------------------

/** "Dados do Processo": pares etiqueta -> valor (número, clase, asunto, órgano julgador...). */
function parseDados($: CheerioAPI): Record<string, string> {
  const dados: Record<string, string> = {};

  for (const el of $(".propertyView").toArray()) {
    const label = clean($(el).find(".name label").first().text());
    const value = $(el).find(".value").first();

    if (label) {
      dados[label] = clean(value.text());
      continue;
    }

    // Algunos campos no tienen etiqueta: el título viene en <b> y el texto justo después
    // (por ejemplo "<b>Órgão Julgador</b><br>Gab 1 - Des. ...").
    const inner = value.html() ?? "";
    for (const part of inner.split(/<b(?:\s[^>]*)?>/i).slice(1)) {
      const [key, ...rest] = part.split(/<\/b>/i);
      const name = textOfFragment(key);
      if (name) dados[name] = textOfFragment(rest.join(""));
    }
  }
  return dados;
}

/** Una tabla de partes (polo activo o pasivo). Sirve para la primera página y las siguientes. */
function parsePolo($: CheerioAPI, tableSuffix: string): Participante[] {
  return $(`tbody[id$="${tableSuffix}:tb"] > tr`)
    .toArray()
    .map((tr) => {
      const cells = $(tr).children("td");
      const first = cells.eq(0);

      // La parte principal va en negrita (span.text-bold); abogados y representantes, no.
      const bold = first.find("span.text-bold").first();
      const esParte = bold.length > 0;
      const nameSpan = esParte ? bold : first.find("div.col-sm-12 > span").first();
      const texto = clean(nameSpan.text());

      return {
        texto,
        nombre: clean(
          texto.split(/\s+-\s+(?:CPF|CNPJ|OAB)\b/)[0].replace(/\s*\([^()]+\)\s*$/, "")
        ),
        tipo: esParte ? "parte" : "representante",
        rol: texto.match(/\(([^()]+)\)\s*$/)?.[1] ?? null,
        documento: texto.match(/\b(?:CPF|CNPJ):\s*([\d./-]+)/)?.[1] ?? null,
        oab: texto.match(/\bOAB\s+([A-Z]{2}\d+(?:-[A-Z])?)/)?.[1] ?? null,
        situacao: clean(cells.eq(1).text()),
        detalles: first
          .find("ul li small")
          .toArray()
          .map((el) => clean($(el).text()))
          .filter(Boolean),
      } satisfies Participante;
    })
    .filter((p) => p.texto !== "");
}

function parseMovimientos($: CheerioAPI): Movimiento[] {
  return $(`tbody[id$="${MOVIMIENTOS}"] > tr`)
    .toArray()
    .map((tr) => {
      const cells = $(tr).children("td");
      const texto = clean(cells.eq(0).text());
      return {
        texto,
        fecha: texto.match(DATE_TIME)?.[1] ?? null,
        documento: clean(cells.eq(1).text()) || null,
      };
    });
}

/**
 * Lista de documentos. La primera celda de cada fila trae el botón del documento
 * (la segunda es el "comprobante de protocolo", que no se descarga).
 * Hay dos tipos de botón:
 *  - enlace-pdf: tiene un href real que lleva al PDF.
 *  - vista-html: href="#" y la dirección de una vista HTML dentro del onclick;
 *    esa vista tiene un botón "Gerar PDF" (ver pdf.ts).
 */
function parseDocumentos($: CheerioAPI): Documento[] {
  return $(`tbody[id$="${DOCUMENTOS}"] > tr`)
    .toArray()
    .flatMap((tr): Documento[] => {
      const link = $(tr).children("td").first().find("a").first();
      if (link.length === 0) return [];

      // El botón trae un texto oculto ("Visualizar documentos") que hay que quitar.
      const copy = link.clone();
      copy.find(".sr-only").remove();
      const texto = clean(copy.text());

      const href = link.attr("href") ?? "";
      const viewUrl = (link.attr("onclick") ?? "").match(
        /openPopUp\('[^']*',\s*'([^']*documentoSemLoginHTML[^']*)'/
      )?.[1];

      let origen: Documento["origen"];
      let url: string;
      if (href && href !== "#") {
        origen = "enlace-pdf";
        url = href;
      } else if (viewUrl) {
        origen = "vista-html";
        url = viewUrl;
      } else {
        return [];
      }

      const params = new URL(url, BASE_URL).searchParams;
      // "31/01/2024 11:43:51 - Decisão (Decisão)" -> "Decisão"
      const tipoDelTexto = texto.includes(" - ")
        ? texto.slice(texto.indexOf(" - ") + 3).replace(/\s*\([^()]*\)\s*$/, "")
        : null;

      return [
        {
          texto,
          fecha: texto.match(DATE_TIME)?.[1] ?? null,
          tipo: params.get("nomeArqProcDocBin") ?? tipoDelTexto,
          tamano: (link.attr("title") ?? "").match(/\(([^()]+)\)\s*$/)?.[1] ?? null,
          idProcessoDocumento:
            params.get("idProcessoDocumento") ?? params.get("idProcessoDoc"),
          href: url,
          origen,
        },
      ];
    });
}

// ---------------------------------------------------------------------------
// Paginación
// ---------------------------------------------------------------------------

/** Total que declara el panel que contiene la tabla ("65 resultados encontrados"). */
function panelTotal($: CheerioAPI, tbodySuffix: string): number | null {
  const tbody = $(`tbody[id$="${tbodySuffix}"]`).first();
  if (tbody.length === 0) return null;
  return readTotal(clean(tbody.closest(".rich-panel").text()));
}

/** Paginador de las partes: una fila de números (1 2 3 ... 7). */
interface Scroller {
  id: string;
  form: string;
  pages: number;
}

function findScroller($: CheerioAPI, tableSuffix: string): Scroller | null {
  const tbody = $(`tbody[id$="${tableSuffix}:tb"]`).first();
  if (tbody.length === 0) return null;

  const panel = tbody.closest(".rich-panel");
  const id = panel.find("div.rich-datascr").first().attr("id");
  if (!id) return null;

  const rows = tbody.children("tr").length;
  const total = readTotal(clean(panel.text())) ?? rows;
  const shown = panel
    .find("div.rich-datascr td.rich-datascr-act, div.rich-datascr td.rich-datascr-inact")
    .toArray()
    .map((td) => Number(clean($(td).text())))
    .filter((n) => Number.isFinite(n) && n > 0);

  const pages = Math.max(rows > 0 ? Math.ceil(total / rows) : 1, ...shown, 1);
  return { id, form: id.slice(0, id.lastIndexOf(":")), pages };
}

/** Paginador de movimientos y documentos: un control deslizante con el número de página. */
interface Slider {
  input: string;
  form: string;
  group: string;
  container: string;
  pages: number;
}

/**
 * Los identificadores del slider (j_id561, j_id474...) están escritos en el script
 * que lo crea, así que se leen de ahí en vez de copiarlos a mano.
 */
function findSlider($: CheerioAPI, tbodySuffix: string): Slider | null {
  for (const el of $("script").toArray()) {
    const js = $(el).html() ?? $(el).text();
    if (!js.includes("Richfaces.Slider")) continue;

    // ¿Este slider pertenece al panel de esta tabla?
    const panel = $(el).closest(".rich-panel");
    if (panel.find(`tbody[id$="${tbodySuffix}"]`).length === 0) continue;

    const input = js.match(/new Richfaces\.Slider\("([^"]+)"/)?.[1];
    const pages = js.match(/'maxValue':'(\d+)'/)?.[1];
    const form = js.match(/A4J\.AJAX\.Submit\([\\']+([^\\']+)/)?.[1];
    const group = js.match(/similarityGroupingId[\\']+:[\\']+([^\\']+)/)?.[1];
    const container = js.match(/containerId[\\']+:[\\']+([^\\']+)/)?.[1];
    if (input && pages && form && group && container) {
      return { input, form, group, container, pages: Number(pages) };
    }
  }
  return null;
}

function scrollerBody(s: Scroller, page: number, viewState: string): Record<string, string> {
  return {
    AJAXREQUEST: "_viewRoot",
    [s.form]: s.form,
    "javax.faces.ViewState": viewState,
    [s.id]: String(page),
    ajaxSingle: s.id,
    "AJAX:EVENTS_COUNT": "1",
  };
}

function sliderBody(s: Slider, page: number, viewState: string): Record<string, string> {
  return {
    AJAXREQUEST: s.container,
    [s.input]: String(page),
    [s.form]: s.form,
    autoScroll: "",
    "javax.faces.ViewState": viewState,
    [s.group]: s.group,
    "AJAX:EVENTS_COUNT": "1",
  };
}

// ---------------------------------------------------------------------------
// Funciones públicas
// ---------------------------------------------------------------------------

/**
 * Abre el detalle de un proceso y recorre todas las páginas de sus partes
 * (polo activo y pasivo) y de sus movimientos.
 * Los documentos se leen aparte con fetchDocuments.
 */
export async function fetchProcessData(
  http: AxiosInstance,
  detailPath: string
): Promise<ProcessData> {
  const referer = BASE_URL + detailPath;
  const html = await getHtml(http, detailPath, BASE_URL + LIST_PATH);
  const $ = load(html);
  let viewState = readViewState($) ?? "j_id1";

  const dados = parseDados($);
  if (Object.keys(dados).length === 0) {
    throw new Error("La página de detalle no trae los datos del proceso");
  }
  const poloActivo = parsePolo($, POLO_ACTIVO);
  const poloPasivo = parsePolo($, POLO_PASIVO);
  const movimientos = parseMovimientos($);

  const esperado = {
    poloActivo: panelTotal($, `${POLO_ACTIVO}:tb`),
    poloPasivo: panelTotal($, `${POLO_PASIVO}:tb`),
    movimientos: panelTotal($, MOVIMIENTOS),
  };

  // Partes: páginas 2..N
  for (const [suffix, target] of [
    [POLO_ACTIVO, poloActivo],
    [POLO_PASIVO, poloPasivo],
  ] as const) {
    const scroller = findScroller($, suffix);
    for (let page = 2; scroller && page <= scroller.pages; page++) {
      const html2 = await postForm(
        http,
        DETAIL_POST_PATH,
        scrollerBody(scroller, page, viewState),
        referer
      );
      const $2 = load(html2);
      viewState = readViewState($2) ?? viewState;
      target.push(...parsePolo($2, suffix));
    }
  }

  // Movimientos: páginas 2..N
  const slider = findSlider($, MOVIMIENTOS);
  for (let page = 2; slider && page <= slider.pages; page++) {
    const html2 = await postForm(
      http,
      DETAIL_POST_PATH,
      sliderBody(slider, page, viewState),
      referer
    );
    const $2 = load(html2);
    viewState = readViewState($2) ?? viewState;
    movimientos.push(...parseMovimientos($2));
  }

  return {
    dados,
    poloActivo,
    poloPasivo,
    movimientos,
    conteos: {
      poloActivo: { esperado: esperado.poloActivo, obtenido: poloActivo.length },
      poloPasivo: { esperado: esperado.poloPasivo, obtenido: poloPasivo.length },
      movimientos: { esperado: esperado.movimientos, obtenido: movimientos.length },
    },
  };
}

/**
 * Abre el detalle y recorre todas las páginas de "Documentos juntados ao processo".
 *
 * Los enlaces de descarga solo valen para la sesión actual, así que
 * "onPage" se ejecuta con los documentos de cada página apenas se leen
 * (ahí es donde el scraper descarga los PDFs), antes de pasar a la siguiente.
 */
export async function fetchDocuments(
  http: AxiosInstance,
  detailPath: string,
  onPage?: (docs: Documento[]) => Promise<void>
): Promise<{ documentos: Documento[]; esperado: number | null }> {
  const referer = BASE_URL + detailPath;
  const html = await getHtml(http, detailPath, BASE_URL + LIST_PATH);
  const $ = load(html);
  let viewState = readViewState($) ?? "j_id1";

  const esperado = panelTotal($, DOCUMENTOS);
  const slider = findSlider($, DOCUMENTOS);
  const documentos: Documento[] = [];

  const firstPage = parseDocumentos($);
  documentos.push(...firstPage);
  if (onPage) await onPage(firstPage);

  for (let page = 2; slider && page <= slider.pages; page++) {
    const html2 = await postForm(
      http,
      DETAIL_POST_PATH,
      sliderBody(slider, page, viewState),
      referer
    );
    const $2 = load(html2);
    viewState = readViewState($2) ?? viewState;
    const docs = parseDocumentos($2);
    documentos.push(...docs);
    if (onPage) await onPage(docs);
  }

  return { documentos, esperado };
}
