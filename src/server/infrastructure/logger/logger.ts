import "server-only";
import { isProduction } from "@/server/config/env";

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const MIN_LEVEL: Level = isProduction ? "info" : "debug";

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function emit(
  level: Level,
  scope: Record<string, unknown>,
  msg: string,
  meta?: Record<string, unknown>,
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;

  const record = {
    level,
    time: new Date().toISOString(),
    msg,
    ...scope,
    ...meta,
  };

  const line = isProduction
    ? JSON.stringify(record)
    : `${record.time} ${level.toUpperCase().padEnd(5)} ${msg}${
        Object.keys({ ...scope, ...meta }).length
          ? ` ${JSON.stringify({ ...scope, ...meta })}`
          : ""
      }`;

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

function build(scope: Record<string, unknown>): Logger {
  return {
    debug: (m, meta) => emit("debug", scope, m, meta),
    info: (m, meta) => emit("info", scope, m, meta),
    warn: (m, meta) => emit("warn", scope, m, meta),
    error: (m, meta) => emit("error", scope, m, meta),
    child: (bindings) => build({ ...scope, ...bindings }),
  };
}

export const logger: Logger = build({});
