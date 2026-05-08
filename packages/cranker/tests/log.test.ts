import { describe, expect, it, vi } from 'vitest'
import { createLogger, errorClass, errorFields, errorMessage } from '../src/utils/log'

describe('createLogger', () => {
  it('emits JSON lines on stderr', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = createLogger({ level: 'info' })
    log.info('hi', { foo: 1 })
    expect(spy).toHaveBeenCalledTimes(1)
    const line = spy.mock.calls[0][0] as string
    const parsed = JSON.parse(line)
    expect(parsed.level).toBe('info')
    expect(parsed.msg).toBe('hi')
    expect(parsed.foo).toBe(1)
    expect(parsed.time).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    spy.mockRestore()
  })

  it('respects level threshold', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = createLogger({ level: 'warn' })
    log.debug('debug-msg')
    log.info('info-msg')
    log.warn('warn-msg')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(JSON.parse(spy.mock.calls[0][0] as string).msg).toBe('warn-msg')
    spy.mockRestore()
  })

  it('serializes Error and bigint safely', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = createLogger({ level: 'info' })
    log.error('boom', { err: new Error('kaboom'), big: 12345678901234567890n })
    const parsed = JSON.parse(spy.mock.calls[0][0] as string)
    expect(parsed.err.message).toBe('kaboom')
    expect(parsed.big).toBe('12345678901234567890')
    spy.mockRestore()
  })

  it('child() merges base fields', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = createLogger({ level: 'info', base: { component: 'root' } })
    const child = log.child({ subsystem: 'scan' })
    child.info('hello')
    const parsed = JSON.parse(spy.mock.calls[0][0] as string)
    expect(parsed.component).toBe('root')
    expect(parsed.subsystem).toBe('scan')
    spy.mockRestore()
  })
})

describe('errorMessage / errorClass — Anchor errors', () => {
  // Anchor's `ProgramError` and `AnchorError` both call `super()` with no
  // arg, so `.message` is "" and `errorClass` would otherwise collapse
  // every distinct on-chain failure into one bucket. Lock that behavior
  // in so dedup remains meaningful.

  function makeAnchorError(code: string, num: number, msg: string): Error {
    // Mirrors Anchor's `AnchorError` ctor (calls `super()` with no arg).
    // eslint-disable-next-line unicorn/error-message
    const err = new Error()
    Object.assign(err, {
      error: { errorCode: { code, number: num }, errorMessage: msg },
      logs: [`Program log: ${msg}`],
      errorLogs: [`Program log: AnchorError thrown in ${code}`],
    })
    return err
  }

  function makeProgramError(code: number, msg: string): Error {
    // Mirrors Anchor's `ProgramError` ctor (calls `super()` with no arg).
    // eslint-disable-next-line unicorn/error-message
    const err = new Error()
    Object.assign(err, { code, msg, logs: [`Program log: ${msg}`] })
    return err
  }

  it('extracts AnchorError code + message', () => {
    const err = makeAnchorError('InsufficientInboxBalance', 6024, 'user inbox ata balance is insufficient')
    expect(errorMessage(err)).toBe('AnchorError InsufficientInboxBalance (6024): user inbox ata balance is insufficient')
  })

  it('extracts ProgramError code + msg', () => {
    const err = makeProgramError(6024, 'user inbox ata balance is insufficient')
    expect(errorMessage(err)).toBe('ProgramError 6024: user inbox ata balance is insufficient')
  })

  it('errorClass distinguishes distinct AnchorError codes', () => {
    const a = makeAnchorError('InsufficientInboxBalance', 6024, 'inbox short')
    const b = makeAnchorError('InvalidStatus', 6010, 'wrong status')
    expect(errorClass(a)).not.toBe(errorClass(b))
  })

  it('falls back to constructor name for empty Errors', () => {
    // eslint-disable-next-line unicorn/error-message
    expect(errorMessage(new Error())).toBe('<empty error>')
    class CustomErr extends Error {}

    expect(errorMessage(new CustomErr())).toBe('<CustomErr with no message>')
  })

  it('errorFields surfaces programLogs and errorLogs', () => {
    const err = makeAnchorError('InsufficientInboxBalance', 6024, 'short')
    const f = errorFields(err) as { programLogs?: string[], errorLogs?: string[], err?: { message?: string } }
    expect(f.programLogs).toEqual(['Program log: short'])
    expect(f.errorLogs).toEqual(['Program log: AnchorError thrown in InsufficientInboxBalance'])
    expect(f.err?.message).toBe('AnchorError InsufficientInboxBalance (6024): short')
  })
})
