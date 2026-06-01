/**
 * Minimal scoped logger. Intentionally tiny — structured logging can come later;
 * for now we just want consistent, greppable prefixes across the sync engine.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? order.info;

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export function createLogger(scope: string): Logger {
  const emit =
    (level: Level) =>
    (msg: string, ...args: unknown[]): void => {
      if (order[level] < threshold) return;
      const line = `[${scope}] ${msg}`;
      if (level === 'error') console.error(line, ...args);
      else if (level === 'warn') console.warn(line, ...args);
      else console.log(line, ...args);
    };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}
