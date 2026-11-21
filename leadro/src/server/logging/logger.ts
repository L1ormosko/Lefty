import { redactSensitive } from "@/lib/redact";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

/** Receives one finished JSON line (without trailing newline). */
export type LogSink = (level: LogLevel, line: string) => void;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that adds `bindings` (e.g. `{ correlationId }`) to every line. */
  child(bindings: LogFields): Logger;
}

const LEVEL_ORDER: Record<LogLevel | "silent", number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/** stdout for info and below, stderr for warn/error, one JSON object per line. */
const stdioSink: LogSink = (level, line) => {
  const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
  stream.write(line + "\n");
};

function configuredLevel(): LogLevel | "silent" {
  const fromEnv = process.env.LOG_LEVEL;
  if (fromEnv && fromEnv in LEVEL_ORDER) return fromEnv as LogLevel | "silent";
  // Keep test output readable; tests that care inject their own sink and level.
  return process.env.NODE_ENV === "test" || process.env.VITEST ? "silent" : "info";
}

/**
 * Turns an Error into loggable fields. The stack goes to logs only (never to API clients,
 * see core/error-mapping.ts).
 */
export function serializeError(error: unknown): LogFields {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: "NonErrorThrown", message: String(error) };
}

export interface CreateLoggerOptions {
  bindings?: LogFields;
  sink?: LogSink;
  /** Defaults to `LOG_LEVEL`, else "info" ("silent" under tests). */
  level?: LogLevel | "silent";
}

/**
 * Creates a JSON-lines logger. Every field passes through `redactSensitive`, so passwords, tokens
 * and cookies are masked even if a caller logs a whole request object by mistake.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const sink = options.sink ?? stdioSink;
  const bindings = options.bindings ?? {};

  const write = (level: LogLevel, message: string, fields: LogFields = {}): void => {
    // Resolved per call so operators/tests can change LOG_LEVEL at runtime.
    const threshold = LEVEL_ORDER[options.level ?? configuredLevel()];
    if (LEVEL_ORDER[level] < threshold) return;
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      message,
      ...(redactSensitive({ ...bindings, ...fields }) as LogFields),
    });
    sink(level, line);
  };

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    child: (extra) => createLogger({ ...options, bindings: { ...bindings, ...extra } }),
  };
}

/** The process-wide logger. Prefer `.child({ correlationId })` inside a request. */
export const logger: Logger = createLogger();
