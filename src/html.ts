import { CheerioAPI, load } from "cheerio";

/** Junta espacios, saltos de línea y espacios duros en un solo espacio. */
export const clean = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Lee el ViewState de JSF (un valor oculto que el servidor pide de vuelta en cada POST). */
export function readViewState($: CheerioAPI): string | null {
  const value = $('input[name="javax.faces.ViewState"]').first().attr("value");
  return value ?? null;
}

/** Busca "N resultados encontrados" dentro de un texto. */
export function readTotal(text: string): number | null {
  const match = text.match(/(\d+)\s+resultados?\s+encontrados?/i);
  return match ? Number(match[1]) : null;
}

/** Convierte un trozo de HTML en texto plano (quita etiquetas y decodifica entidades). */
export function textOfFragment(fragment: string): string {
  return clean(load(`<div>${fragment}</div>`).root().text());
}
