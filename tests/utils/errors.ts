const ERROR_CODE_RE = /Error Code: (\w+)/

/**
 * Extract Anchor error code from a failed LiteSVM transaction.
 * Anchor logs errors as `Program log: AnchorError ... Error Code: <name>`.
 */
export function extractErrorCode(error: unknown): string | null {
  const msg = String(error)
  const match = msg.match(ERROR_CODE_RE)
  return match?.[1] ?? null
}

/**
 * Assert that an async action throws with a specific Anchor error code.
 */
export async function expectError(fn: () => Promise<unknown> | unknown, code: string) {
  try {
    await fn()
    throw new Error(`Expected error ${code} but succeeded`)
  } catch (e: unknown) {
    const actual = extractErrorCode(e)
    expect(actual).toBe(code)
  }
}
