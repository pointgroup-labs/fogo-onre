/**
 * Tiny structured logger. JSON-per-line on stderr (so stdout stays
 * clean for any future tooling). Centralizes level filtering and
 * defensive error serialization — `console.error(JSON.stringify({err}))`
 * scattered across modules turned into a footgun (non-serializable
 * Error fields, BigInt values, etc.).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
}

export type Logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => void
  info: (msg: string, fields?: Record<string, unknown>) => void
  warn: (msg: string, fields?: Record<string, unknown>) => void
  error: (msg: string, fields?: Record<string, unknown>) => void
  fatal: (msg: string, fields?: Record<string, unknown>) => void
  child: (extra: Record<string, unknown>) => Logger
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => {
      if (typeof v === 'bigint') {
        return v.toString()
      }
      if (v instanceof Error) {
        return { name: v.name, message: v.message, stack: v.stack }
      }
      return v
    })
  } catch (err) {
    return JSON.stringify({ __serializeError: String(err) })
  }
}

export function createLogger(opts: { level: LogLevel, base?: Record<string, unknown> } = { level: 'info' }): Logger {
  const threshold = ORDER[opts.level]
  const base = opts.base ?? {}

  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (ORDER[level] < threshold) {
      return
    }
    const line = safeStringify({
      level,
      msg,
      time: new Date().toISOString(),
      ...base,
      ...fields,
    })

    console.error(line)
  }

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    fatal: (msg, fields) => emit('fatal', msg, fields),
    child: extra => createLogger({ level: opts.level, base: { ...base, ...extra } }),
  }
}
