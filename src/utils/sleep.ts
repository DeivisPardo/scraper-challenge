// Devuelve una promesa que se resuelve después de "ms" milisegundos.
// Sirve para hacer pausas entre peticiones y no sobrecargar el servidor.
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
