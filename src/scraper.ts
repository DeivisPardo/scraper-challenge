import * as fs from "fs";
import * as path from "path";
import { AxiosError } from "axios";
import { BASE_URL, DOWNLOADS_DIR, OUTPUT_DIR } from "./config";
import { fetchDocuments, fetchProcessData } from "./detail";
import { createClient } from "./http";
import { downloadDocument } from "./pdf";
import { searchByDate } from "./search";
import { Documento, FailedDownload, ProcesoGuardado, SearchResult } from "./types";
import { eachDay } from "./utils/dates";

export interface ScrapeOptions {
  from: string; // primer día (AAAA-MM-DD)
  to: string; // último día (AAAA-MM-DD)
  delayMs: number; // pausa entre peticiones
  maxProcesses: number | null; // tope de procesos (null = sin tope)
  maxDocs: number | null; // tope de PDFs por proceso (null = sin tope)
  downloadPdfs: boolean;
  searchOnly: boolean; // solo buscar y contar procesos por día (no abre detalles)
}

// Archivos de salida
const PROCESOS_DIR = path.join(OUTPUT_DIR, "procesos");
const COMPLETED_FILE = path.join(OUTPUT_DIR, "completed.txt");
const FAILED_DOWNLOADS_FILE = path.join(OUTPUT_DIR, "failed-downloads.json");
const FAILED_PROCESSES_FILE = path.join(OUTPUT_DIR, "failed-processes.json");
const TRUNCATED_DAYS_FILE = path.join(OUTPUT_DIR, "truncated-days.json");

/** Detenerse si fallan tantos procesos seguidos (probablemente nos están bloqueando). */
const MAX_CONSECUTIVE_FAILURES = 5;

const log = (message: string): void =>
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

function describeError(error: unknown): string {
  const err = error as AxiosError;
  if (err.response) return `HTTP ${err.response.status} ${err.message}`;
  return err instanceof Error ? err.message : String(error);
}

function slug(text: string): string {
  return (
    text
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "documento"
  );
}

/** Nombre descriptivo del PDF: downloads/<proceso>/<fecha>_<tipo>_<id>.pdf */
function pdfPath(numero: string, doc: Documento): string {
  const fecha = doc.fecha
    ? doc.fecha.replace(/(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})/, "$3-$2-$1_$4$5$6")
    : "sin-fecha";
  const tipo = slug(doc.tipo ?? "documento").slice(0, 50);
  const id = doc.idProcessoDocumento ?? "sin-id";
  return path.join(DOWNLOADS_DIR, numero, `${fecha}_${tipo}_${id}.pdf`);
}

export async function runScraper(options: ScrapeOptions): Promise<void> {
  const http = createClient(options.delayMs);
  fs.mkdirSync(PROCESOS_DIR, { recursive: true });

  // Estado que se conserva entre ejecuciones (así se puede retomar donde se dejó).
  const completed = new Set(
    fs.existsSync(COMPLETED_FILE)
      ? fs.readFileSync(COMPLETED_FILE, "utf-8").split("\n").filter(Boolean)
      : []
  );
  const failedDownloads = new Map<string, FailedDownload>(
    readJson<FailedDownload[]>(FAILED_DOWNLOADS_FILE, []).map((f) => [
      `${f.proceso}:${f.idProcessoDocumento}`,
      f,
    ])
  );
  const failedProcesses = new Map<string, { proceso: string; error: string; fecha: string }>(
    readJson<{ proceso: string; error: string; fecha: string }[]>(FAILED_PROCESSES_FILE, []).map(
      (f) => [f.proceso, f]
    )
  );
  const truncatedDays = new Map<string, { fecha: string; totalReportado: number | null }>(
    readJson<{ fecha: string; totalReportado: number | null }[]>(TRUNCATED_DAYS_FILE, []).map(
      (d) => [d.fecha, d]
    )
  );

  const stats = {
    procesos: 0,
    saltados: 0,
    pdfsNuevos: 0,
    pdfsFallidos: 0,
    procesosFallidos: 0,
    diasConsultados: 0,
    listados: 0,
  };
  let consecutiveFailures = 0;

  const saveFailures = (): void => {
    writeJson(FAILED_DOWNLOADS_FILE, [...failedDownloads.values()]);
    writeJson(FAILED_PROCESSES_FILE, [...failedProcesses.values()]);
  };

  /** Extrae un proceso completo: datos, todas las páginas y sus PDFs. */
  async function scrapeProcess(result: SearchResult, position: string): Promise<boolean> {
    const { numero, detailPath } = result;
    const referer = BASE_URL + detailPath;
    log(`${position} ${numero}`);

    const data = await fetchProcessData(http, detailPath);

    let attempted = 0; // PDFs que intentamos descargar en este proceso
    let processFailures = 0;

    const handlePage = async (docs: Documento[]): Promise<void> => {
      for (const doc of docs) {
        const dest = pdfPath(numero, doc);

        if (!options.downloadPdfs || (options.maxDocs !== null && attempted >= options.maxDocs)) {
          doc.estado = "omitido";
          continue;
        }
        if (fs.existsSync(dest)) {
          doc.estado = "existente";
          doc.archivo = dest;
          continue;
        }

        attempted++;
        const key = `${numero}:${doc.idProcessoDocumento}`;
        try {
          doc.bytes = await downloadDocument(http, doc, referer, dest);
          doc.estado = "descargado";
          doc.archivo = dest;
          failedDownloads.delete(key);
          stats.pdfsNuevos++;
        } catch (error) {
          doc.estado = "fallido";
          doc.error = describeError(error);
          processFailures++;
          stats.pdfsFallidos++;
          failedDownloads.set(key, {
            proceso: numero,
            detailPath,
            idProcessoDocumento: doc.idProcessoDocumento,
            documento: doc.texto,
            error: doc.error,
            fecha: new Date().toISOString(),
          });
          log(`   ✗ no se pudo descargar "${doc.texto}": ${doc.error}`);
        }
      }
    };

    const { documentos, esperado } = await fetchDocuments(http, detailPath, handlePage);

    const registro: ProcesoGuardado = {
      numero,
      titulo: result.titulo,
      clase: result.clase,
      partes: result.partes,
      ultimaMovimentacao: result.ultimaMovimentacao,
      detalleUrl: referer,
      ...data,
      documentos,
      conteoDocumentos: { esperado, obtenido: documentos.length },
      extraidoEn: new Date().toISOString(),
    };
    writeJson(path.join(PROCESOS_DIR, `${numero}.json`), registro);

    // Avisar si el sitio declaraba más elementos de los que obtuvimos.
    const conteos = {
      "polo activo": data.conteos.poloActivo,
      "polo pasivo": data.conteos.poloPasivo,
      movimientos: data.conteos.movimientos,
      documentos: registro.conteoDocumentos,
    };
    for (const [nombre, c] of Object.entries(conteos)) {
      if (c.esperado !== null && c.esperado !== c.obtenido) {
        log(`   ⚠ ${nombre}: el sitio declara ${c.esperado} pero se obtuvieron ${c.obtenido}`);
      }
    }

    const pdfs = documentos.filter((d) => d.estado === "descargado").length;
    const existentes = documentos.filter((d) => d.estado === "existente").length;
    log(
      `   datos guardados | documentos: ${documentos.length} (PDFs nuevos: ${pdfs}, ya existentes: ${existentes}, fallidos: ${processFailures})`
    );

    // Solo se marca como completo si los conteos coinciden con los que declara el sitio
    // y todos los PDFs están en disco.
    const conteosOk = Object.values(conteos).every(
      (c) => c.esperado === null || c.esperado === c.obtenido
    );
    const pdfsOk = documentos.every((d) => d.estado === "descargado" || d.estado === "existente");
    return conteosOk && pdfsOk;
  }

  const days = eachDay(options.from, options.to);
  log(`Rango: ${options.from} a ${options.to} (${days.length} día/s). Pausa entre peticiones: ${options.delayMs} ms`);

  outer: for (const day of days) {
    let outcome;
    try {
      outcome = await searchByDate(http, day);
    } catch (error) {
      log(`✗ Falló la búsqueda del día ${day}: ${describeError(error)}`);
      continue;
    }

    log(
      `Día ${day}: ${outcome.results.length} procesos leídos` +
        (outcome.totalReportado !== null ? ` (el sitio dice ${outcome.totalReportado})` : "")
    );

    if (outcome.truncated) {
      log(`⚠ El sitio solo muestra los primeros resultados de este día. Quedó anotado en ${TRUNCATED_DAYS_FILE}`);
      truncatedDays.set(day, { fecha: day, totalReportado: outcome.totalReportado });
    } else {
      truncatedDays.delete(day);
    }
    writeJson(TRUNCATED_DAYS_FILE, [...truncatedDays.values()]);

    stats.diasConsultados++;
    stats.listados += outcome.results.length;
    if (options.searchOnly) continue; // modo "solo contar": no se abren los detalles

    let index = 0;
    for (const result of outcome.results) {
      index++;
      if (options.maxProcesses !== null && stats.procesos >= options.maxProcesses) {
        log(`Se alcanzó el tope de ${options.maxProcesses} procesos (--max-processes).`);
        break outer;
      }
      if (completed.has(result.numero)) {
        stats.saltados++;
        log(`[${index}/${outcome.results.length}] ${result.numero} ya estaba completo, se omite`);
        continue;
      }

      try {
        const complete = await scrapeProcess(result, `[${index}/${outcome.results.length}]`);
        stats.procesos++;
        consecutiveFailures = 0;
        failedProcesses.delete(result.numero);
        if (complete) {
          completed.add(result.numero);
          fs.appendFileSync(COMPLETED_FILE, `${result.numero}\n`);
        }
      } catch (error) {
        stats.procesosFallidos++;
        consecutiveFailures++;
        const message = describeError(error);
        log(`   ✗ falló el proceso ${result.numero}: ${message}`);
        failedProcesses.set(result.numero, {
          proceso: result.numero,
          error: message,
          fecha: new Date().toISOString(),
        });
      }
      saveFailures();

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        throw new Error(
          `${MAX_CONSECUTIVE_FAILURES} procesos seguidos fallaron; se detiene para no sobrecargar el sitio. Vuelve a ejecutar más tarde: retoma donde quedó.`
        );
      }
    }
  }

  saveFailures();
  log("---- Resumen ----");
  if (options.searchOnly) {
    log(`Días consultados: ${stats.diasConsultados} | procesos listados: ${stats.listados} | días recortados por el sitio: ${truncatedDays.size}`);
    return;
  }
  log(`Procesos extraídos: ${stats.procesos} | omitidos por estar completos: ${stats.saltados}`);
  log(`PDFs nuevos: ${stats.pdfsNuevos} | descargas fallidas: ${stats.pdfsFallidos} | procesos fallidos: ${stats.procesosFallidos}`);
  if (failedDownloads.size > 0) log(`Descargas pendientes de reintento: ${failedDownloads.size} (ver ${FAILED_DOWNLOADS_FILE})`);
  if (truncatedDays.size > 0) log(`Días con resultados recortados por el sitio: ${truncatedDays.size} (ver ${TRUNCATED_DAYS_FILE})`);
}
