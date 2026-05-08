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
  if (!(err instanceof Error)) {
    return String(err)
  }

  // Anchor `AnchorError`: structurally `{ error: { errorCode: { code,
  // number }, errorMessage } }`. Constructed via `super()` with no arg,
  // so `.message` is "". Produces e.g.
  // "AnchorError InsufficientInboxBalance (6024): user inbox ata balance
  // is insufficient" — meaningful enough for class dedup.
  const anchorErr = err as {
    error?: {
      errorCode?: { code?: unknown, number?: unknown }
      errorMessage?: unknown
    }
  }
  const code = anchorErr.error?.errorCode?.code
  const number = anchorErr.error?.errorCode?.number
  if (typeof code === 'string') {
    const num = typeof number === 'number' ? ` (${number})` : ''
    const msg = typeof anchorErr.error?.errorMessage === 'string' && anchorErr.error.errorMessage
      ? `: ${anchorErr.error.errorMessage}`
      : ''
    return `AnchorError ${code}${num}${msg}`
  }

  // Anchor `ProgramError`: structurally `{ code: number, msg: string }`.
  // Same empty-`.message` problem.
  const programErr = err as { code?: unknown, msg?: unknown }
  if (typeof programErr.code === 'number' && typeof programErr.msg === 'string') {
    return `ProgramError ${programErr.code}: ${programErr.msg}`
  }

  if (err.message) {
    return err.message
  }
  // Last resort: an Error with no message and no Anchor shape. Surface
  // the constructor name so dedup at least separates by error class.
  return err.constructor === Error ? '<empty error>' : `<${err.constructor.name} with no message>`
}

export function errorFields(err: unknown): LogFields {
  if (!(err instanceof Error)) {
    return { err: String(err) }
  }
  // Send a normalized error envelope so the JSON encoder doesn't have to
  // guess: explicit message (Anchor-aware), name, stack, plus any
  // program-side logs that Anchor attaches. Without this the operator
  // sees `message: ""` and zero context for on-chain failures.
  const fields: LogFields = {
    err: {
      name: err.name,
      message: errorMessage(err),
      stack: err.stack,
    },
  }
  const withLogs = err as { logs?: unknown, errorLogs?: unknown }
  if (Array.isArray(withLogs.logs) && withLogs.logs.length > 0) {
    fields.programLogs = withLogs.logs
  }
  if (Array.isArray(withLogs.errorLogs) && withLogs.errorLogs.length > 0) {
    fields.errorLogs = withLogs.errorLogs
  }
  return fields
}

// Base58 (32–44 chars, Solana pubkey/signature alphabet) and hex (64+ chars).
// Used by errorClass() to collapse 100 "cannot derive userWallet for VAA
// recipient <pubkey>" failures into one class with stable identity.
const BASE58_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,88}\b/g
const HEX_RE = /\b[0-9a-f]{32,}\b/gi

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

/**
 * Per-iteration aggregator entry for class-keyed error dedup. The
 * `sampleKey` is opaque to the helper — Flow scanner uses the flow
 * pubkey, bridge scanner uses the sequence string. Each call site maps
 * it to its preferred public field name in the rollup log line.
 */
export type ClassRollupAgg = {
  count: number
  sampleKey: string
  sampleMessage: string
}

/**
 * Records an error in both the cross-iteration "first-seen" memo and the
 * per-iteration aggregator. Returns enough context for the caller to
 * pick the log level + format the log fields itself.
 *
 *   - `firstSeenOn === undefined` → first sighting; caller logs at warn,
 *     and the memo has been populated with `sampleKey`.
 *   - `firstSeenOn !== undefined` → known class; caller logs at debug
 *     and may include `firstSeenOn` for triage.
 *
 * The two scanners (Flow and bridge) share this bookkeeping verbatim;
 * only the log message text and the public field name for `sampleKey`
 * differ.
 */
export function recordErrorClass(args: {
  err: Error
  sampleKey: string
  seenErrors: Map<string, string> | undefined
  iterFailures: Map<string, ClassRollupAgg>
}): { klass: string, firstSeenOn: string | undefined } {
  const klass = errorClass(args.err)
  const firstSeenOn = args.seenErrors?.get(klass)
  if (firstSeenOn === undefined) {
    args.seenErrors?.set(klass, args.sampleKey)
  }
  const agg = args.iterFailures.get(klass)
  if (agg) {
    agg.count += 1
  } else {
    args.iterFailures.set(klass, {
      count: 1,
      sampleKey: args.sampleKey,
      sampleMessage: errorMessage(args.err),
    })
  }
  return { klass, firstSeenOn }
}

/**
 * Yields per-iteration rollup entries for classes hit more than once.
 * `isKnown` reflects whether the class was already in `seenErrors` at
 * the start of the scan — the caller uses it to pick log level
 * (debug for known, info for novel).
 */
export function* rollupErrorClasses(
  iterFailures: Map<string, ClassRollupAgg>,
  knownAtStart: Set<string>,
): Generator<{ klass: string, agg: ClassRollupAgg, isKnown: boolean }> {
  for (const [klass, agg] of iterFailures) {
    if (agg.count <= 1) {
      continue
    }
    yield { klass, agg, isKnown: knownAtStart.has(klass) }
  }
}
