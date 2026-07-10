export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  child(scope: string): Logger;
}

export function createLogger(scope = 'app'): Logger {
  const tag = (lvl: string) => `[${lvl}] (${scope})`;
  return {
    info: (msg, ...args) => console.log(tag('info'), msg, ...args),
    warn: (msg, ...args) => console.warn(tag('warn'), msg, ...args),
    error: (msg, ...args) => console.error(tag('error'), msg, ...args),
    child: (s) => createLogger(`${scope}:${s}`),
  };
}
