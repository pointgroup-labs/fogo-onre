export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'
export type LogFields = Record<string, unknown>

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
}

export type Logger = {
  debug: (msg: string, fields?: LogFields) => void
  info: (msg: string, fields?: LogFields) => void
  warn: (msg: string, fields?: LogFields) => void
  error: (msg: string, fields?: LogFields) => void
  fatal: (msg: string, fields?: LogFields) => void
  child: (extra: LogFields) => Logger
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function errorFields(err: unknown): LogFields {
  return { err: err instanceof Error ? err : String(err) }
}

// Base58 (32–44 chars, Solana pubkey/signature alphabet) and hex (64+ chars).
// Used by errorClass() to collapse 100 "cannot derive userWallet for VAA
// recipient <pubkey>" failures into one class with stable identity.
const BASE58_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,88}\b/g
const HEX_RE = /\b[0-9a-fA-F]{32,}\b/g

/**
 * Stable class fingerprint for an error: message text with variable
 * identifiers (pubkeys, signatures, hex hashes) redacted. Two failures
 * whose messages differ only in pubkey are the same recurring class —
 * dedup on this so a sender-side encoding bug affecting 100 distinct
 * flows produces one warn, not 100.
 */
export function errorClass(err: unknown): string {
  const msg = errorMessage(err)
  return msg.replace(BASE58_RE, '<pubkey>').replace(HEX_RE, '<hex>')
}

/**
 * Compact, single-line error fields for high-frequency debug paths
 * (e.g. routine VAA-skip in enumerate). Drops the stack trace —
 * stacks are useful for warns/errors, but they triple the log volume
 * for known-routine debug-level events.
 */
export function errorFieldsCompact(err: unknown): LogFields {
  return { err: errorMessage(err) }
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

export function writeLogLine(level: LogLevel, msg: string, fields: LogFields = {}): void {
  console.error(safeStringify({
    level,
    msg,
    time: new Date().toISOString(),
    ...fields,
  }))
}

export function createLogger(opts: { level: LogLevel, base?: LogFields } = { level: 'info' }): Logger {
  const threshold = ORDER[opts.level]
  const base = opts.base ?? {}

  const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (ORDER[level] < threshold) {
      return
    }
    writeLogLine(level, msg, { ...base, ...fields })
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

/**
 * No-op logger for tests — discards every emission. Avoids polluting test
 * stderr with diagnostic chatter from production-path debug/info/warn calls.
 */
export function silentLogger(): Logger {
  const noop = (): void => {}
  const self: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => self,
  }
  return self
}
