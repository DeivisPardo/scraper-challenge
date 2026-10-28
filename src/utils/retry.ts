import { AxiosError } from "axios";
import { sleep } from "./sleep";

export interface RetryOptions {
  maxAttempts: number; // cuántas veces intentar en total
  baseDelayMs: number; // espera inicial antes de reintentar
}

/** Devuelve el motivo si el error merece un reintento, o null si no. */
function retryReason(error: unknown): string | null {
  const err = error as AxiosError;
  const status = err.response?.status;
  if (status === 429) return "429 Too Many Requests";
  if (status !== undefined && status >= 500) return `HTTP ${status}`;
  const transient = ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "EAI_AGAIN"];
  if (err.code && transient.includes(err.code)) return err.code;
  return null;
}

/** Si el servidor manda la cabecera Retry-After (en segundos), la respetamos. */
function retryAfterMs(error: unknown): number {
  const header = (error as AxiosError).response?.headers?.["retry-after"];
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

/**
 * Ejecuta "task". Si falla con un error temporal (sobre todo 429, demasiadas
 * peticiones), espera y reintenta duplicando la espera cada vez (backoff
 * exponencial). Los demás errores se lanzan de inmediato. Si se agotan los
 * intentos, lanza el último error.
 */
export async function withRetry<T>(
  task: () => Promise<T>,
  options: RetryOptions,
  label = "petición"
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      const reason = retryReason(error);
      if (!reason) throw error; // no es un error temporal: no tiene sentido reintentar
      if (attempt === options.maxAttempts) break;

      // 1ª espera: base, 2ª: base x 2, 3ª: base x 4... más un poco de azar.
      const backoff = options.baseDelayMs * 2 ** (attempt - 1) + Math.random() * 1000;
      const delay = Math.min(Math.max(backoff, retryAfterMs(error)), 60000);
      console.warn(
        `${reason} en ${label}. Intento ${attempt}/${options.maxAttempts}. Esperando ${Math.round(delay)} ms...`
      );
      await sleep(delay);
    }
  }

  throw lastError;
}
