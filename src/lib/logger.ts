/**
 * Structured JSON Logger — Phase 8
 *
 * Production-grade structured logging.
 * Drop-in compatible with pino API surface.
 * Replace internals with `import pino from 'pino'` for full pino features.
 *
 * No console.log anywhere in the codebase — all output goes through this logger.
 */

export enum LogLevel {
  DEBUG = 10,
  INFO = 20,
  WARN = 30,
  ERROR = 40,
  FATAL = 50,
}

const LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'debug',
  [LogLevel.INFO]: 'info',
  [LogLevel.WARN]: 'warn',
  [LogLevel.ERROR]: 'error',
  [LogLevel.FATAL]: 'fatal',
};

function parseLogLevel(level: string): LogLevel {
  const map: Record<string, LogLevel> = {
    debug: LogLevel.DEBUG,
    info: LogLevel.INFO,
    warn: LogLevel.WARN,
    error: LogLevel.ERROR,
    fatal: LogLevel.FATAL,
  };
  return map[level.toLowerCase()] ?? LogLevel.INFO;
}

const CURRENT_LEVEL = parseLogLevel(process.env.LOG_LEVEL || 'info');

interface LogRecord {
  level: string;
  time: string;
  msg: string;
  [key: string]: unknown;
}

function emit(level: LogLevel, bindings: Record<string, unknown>, context: Record<string, unknown> | string, msg?: string): void {
  if (level < CURRENT_LEVEL) return;

  const record: LogRecord = {
    level: LEVEL_NAMES[level],
    time: new Date().toISOString(),
    ...bindings,
    ...(typeof context === 'object' ? context : {}),
    msg: typeof context === 'string' ? context : (msg ?? ''),
  };

  const line = JSON.stringify(record) + '\n';

  if (level >= LogLevel.ERROR) {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

export interface Logger {
  debug(context: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  info(context: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  warn(context: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  error(context: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  fatal(context: Record<string, unknown>, msg: string): void;
  fatal(msg: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

function createLogger(bindings: Record<string, unknown> = {}): Logger {
  const make = (level: LogLevel) => {
    return (contextOrMsg: Record<string, unknown> | string, msg?: string): void => {
      emit(level, bindings, contextOrMsg, msg);
    };
  };

  return {
    debug: make(LogLevel.DEBUG) as Logger['debug'],
    info: make(LogLevel.INFO) as Logger['info'],
    warn: make(LogLevel.WARN) as Logger['warn'],
    error: make(LogLevel.ERROR) as Logger['error'],
    fatal: make(LogLevel.FATAL) as Logger['fatal'],
    child(childBindings: Record<string, unknown>): Logger {
      return createLogger({ ...bindings, ...childBindings });
    },
  };
}

/** Root application logger */
export const logger: Logger = createLogger({ service: 'prism-ai' });
