import { AxiosInstance } from "axios";
import { load } from "cheerio";
import { BASE_URL, LIST_PATH } from "./config";
import { clean, readTotal, readViewState } from "./html";
import { getHtml, postForm } from "./http";
import { SearchOutcome, SearchResult } from "./types";
import { isoToBr, isoToMonth } from "./utils/dates";

const PROCESS_NUMBER = /\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/;

/**
 * Busca procesos por fecha de autuação (un solo día).
 *
 * El sitio exige al menos un filtro y muestra como máximo 30 resultados por
 * búsqueda, así que el scraper recorre el sitio día por día. Si un día supera
 * el tope, el sitio avisa y devolvemos truncated = true.
 */
export async function searchByDate(
  http: AxiosInstance,
  isoDate: string
): Promise<SearchOutcome> {
  // 1. Abrir la página: el servidor entrega las cookies de sesión y el ViewState.
  const home = await getHtml(http, LIST_PATH);
  const viewState = readViewState(load(home)) ?? "j_id1";

  // 2. Enviar el formulario igual que lo hace el botón PESQUISAR del navegador.
  const date = isoToBr(isoDate);
  const month = isoToMonth(isoDate);
  const html = await postForm(
    http,
    LIST_PATH,
    {
      AJAXREQUEST: "_viewRoot",
      "fPP:numProcesso-inputNumeroProcessoDecoration:numProcesso-inputNumeroProcesso": "",
      mascaraProcessoReferenciaRadio: "on",
      "fPP:j_id162:processoReferenciaInput": "",
      "fPP:dnp:nomeParte": "",
      "fPP:j_id180:nomeAdv": "",
      "fPP:j_id189:classeJudicial": "",
      "fPP:j_id189:sgbClasseJudicial_selection": "",
      tipoMascaraDocumento: "on",
      "fPP:dpDec:documentoParte": "",
      "fPP:Decoration:numeroOAB": "",
      "fPP:Decoration:j_id223": "",
      "fPP:Decoration:estadoComboOAB": "org.jboss.seam.ui.NoSelectionConverter.noSelectionValue",
      "fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputDate": date,
      "fPP:dataAutuacaoDecoration:dataAutuacaoInicioInputCurrentDate": month,
      "fPP:dataAutuacaoDecoration:dataAutuacaoFimInputDate": date,
      "fPP:dataAutuacaoDecoration:dataAutuacaoFimInputCurrentDate": month,
      fPP: "fPP",
      autoScroll: "",
      "javax.faces.ViewState": viewState,
      "fPP:j_id244": "fPP:j_id244", // el botón PESQUISAR
      "AJAX:EVENTS_COUNT": "1",
    },
    BASE_URL + LIST_PATH
  );

  // 3. Leer las filas de la tabla de resultados.
  const $ = load(html);
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  for (const tr of $('[id="fPP:processosTable:tb"] tr.rich-table-row').toArray()) {
    // Cada fila tiene dos enlaces al detalle: un botón con ícono y el título en negrita.
    // Usamos el del título (el que contiene <b class="btn-block">).
    const link = $(tr).find("a:has(b.btn-block)").first();
    const onclick = link.attr("onclick") ?? "";
    const detailPath = onclick.match(/'(\/pjeconsulta\/[^']*\?ca=[^']+)'/)?.[1];
    if (!detailPath) continue;

    const titulo = clean(link.find("b").first().text());
    const numero = titulo.match(PROCESS_NUMBER)?.[0];
    if (!numero || seen.has(numero)) continue;
    seen.add(numero);

    // En la celda del título: primero el texto de la clase, luego el enlace, luego las partes.
    const cell = link.closest("td");
    const texts = cell
      .contents()
      .filter((_, node) => node.nodeType === 3)
      .toArray()
      .map((node) => clean($(node).text()))
      .filter(Boolean);

    results.push({
      numero,
      titulo,
      clase: texts[0] ?? "",
      partes: texts.length > 1 ? texts[texts.length - 1] : "",
      ultimaMovimentacao: clean($(tr).children("td").last().text()),
      detailPath,
    });
  }

  const pageText = clean($.root().text());
  return {
    fecha: isoDate,
    results,
    totalReportado: readTotal(pageText),
    truncated: /somente os \d+ primeiros/i.test(pageText),
  };
}
