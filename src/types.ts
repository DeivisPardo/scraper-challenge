/** Tipos de datos que maneja el scraper. */

/** Una fila de la lista de resultados de la búsqueda. */
export interface SearchResult {
  numero: string;
  titulo: string;
  clase: string;
  partes: string;
  ultimaMovimentacao: string;
  detailPath: string;
}

export interface SearchOutcome {
  fecha: string; // día consultado (AAAA-MM-DD)
  results: SearchResult[];
  totalReportado: number | null; // lo que dice "N resultados encontrados"
  truncated: boolean; // true si el sitio avisó que solo muestra los primeros 30
}

export interface Participante {
  texto: string; // texto completo tal como lo muestra el sitio
  nombre: string;
  tipo: "parte" | "representante"; // representante = abogado, procuraduría, etc.
  rol: string | null; // por ejemplo APELANTE, APELADO, ADVOGADO
  documento: string | null; // CPF o CNPJ
  oab: string | null;
  situacao: string;
  detalles: string[]; // líneas extra, por ejemplo "Procuradoria Geral Federal (PGF/AGU)"
}

export interface Movimiento {
  texto: string;
  fecha: string | null;
  documento: string | null;
}

export type EstadoDescarga = "descargado" | "existente" | "fallido" | "omitido";

export interface Documento {
  texto: string;
  fecha: string | null;
  tipo: string | null;
  tamano: string | null;
  idProcessoDocumento: string | null;
  href: string; // dirección del PDF o de la vista HTML del documento (según "origen")
  /**
   * enlace-pdf: el botón del documento apunta directo a un PDF.
   * vista-html: el botón abre una vista HTML que trae un botón "Gerar PDF".
   */
  origen: "enlace-pdf" | "vista-html";
  estado?: EstadoDescarga;
  archivo?: string;
  bytes?: number;
  error?: string;
}

/** Cuántos elementos dice el sitio que hay y cuántos obtuvimos realmente. */
export interface Conteo {
  esperado: number | null;
  obtenido: number;
}

export interface ProcessData {
  dados: Record<string, string>;
  poloActivo: Participante[];
  poloPasivo: Participante[];
  movimientos: Movimiento[];
  conteos: { poloActivo: Conteo; poloPasivo: Conteo; movimientos: Conteo };
}

export interface ProcesoGuardado extends ProcessData {
  numero: string;
  titulo: string;
  clase: string;
  partes: string;
  ultimaMovimentacao: string;
  detalleUrl: string;
  documentos: Documento[];
  conteoDocumentos: Conteo;
  extraidoEn: string;
}

export interface FailedDownload {
  proceso: string;
  detailPath: string;
  idProcessoDocumento: string | null;
  documento: string;
  error: string;
  fecha: string;
}
