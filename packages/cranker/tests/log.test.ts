import { describe, expect, it, vi } from 'vitest'
import { createLogger } from '../src/log'

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
