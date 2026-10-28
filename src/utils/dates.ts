/** Utilidades para trabajar con fechas en formato AAAA-MM-DD. */

export function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** 2024-03-15 -> 15/03/2024 (formato que usa el formulario del sitio). */
export function isoToBr(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

/** 2024-03-15 -> 03/2024 (el formulario también envía el mes visible del calendario). */
export function isoToMonth(iso: string): string {
  const [year, month] = iso.split("-");
  return `${month}/${year}`;
}

/** Lista todos los días entre dos fechas, ambas incluidas. */
export function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86400000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}
