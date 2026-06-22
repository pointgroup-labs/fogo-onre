import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Env schema is the single source of truth — this test generates the
// operator-facing cranker.env.example from it and asserts the committed
// file matches. Mirrors `cargo fmt`/`cargo fmt --check`: pass `UPDATE=1`
// to regenerate the example after a schema change.
//
//   pnpm exec vitest run cranker-env-sync        # --check mode (CI gate)
//   make gen-env                                 # regenerate

vi.mock('../packages/cranker/src/config', async () => {
  const actual = await vi.importActual<typeof import('../packages/cranker/src/config')>('../packages/cranker/src/config')
  return { configSchema: actual.configSchema }
})

// Minimal Zod introspection — we only need: shape, description, and the
// default value. These live at predictable `_def` paths across Zod wrappers
// (ZodEffects.refine, ZodDefault, ZodOptional, ZodCoerce). We walk inward
// through both `innerType` (ZodDefault/ZodOptional) and `schema` (ZodEffects)
// until we either find a `_def.defaultValue` function or hit a terminal.
type ZodAny = { _def: unknown }
type FieldShape = {
  description?: string
  hasDefault: boolean
  defaultValue?: unknown
}

function inspectField(zodType: ZodAny): FieldShape {
  const outerDef = zodType._def as Record<string, unknown>
  const description = (outerDef as { description?: string }).description
  let cursor = zodType
  for (let depth = 0; depth < 8; depth++) {
    const d = cursor._def as Record<string, unknown>
    if (typeof d.defaultValue === 'function') {
      try {
        return { description, hasDefault: true, defaultValue: (d.defaultValue as () => unknown)() }
      } catch {
        return { description, hasDefault: true, defaultValue: undefined }
      }
    }
    // ZodEffects wraps via `schema`; ZodDefault/ZodOptional/ZodCatch via `innerType`.
    const inner = (d.innerType ?? d.schema) as ZodAny | undefined
    if (!inner) {
      break
    }
    cursor = inner
  }
  return { description, hasDefault: false }
}

/** Read the object shape off the schema, tolerating either Zod v3 `_def.shape` or the direct `.shape` property. */
function schemaShape(schema: ZodAny): Record<string, ZodAny> {
  const direct = (schema as { shape?: Record<string, ZodAny> }).shape
  if (direct) {
    return direct
  }
  const fromDef = (schema._def as { shape?: Record<string, ZodAny> }).shape
  if (fromDef) {
    return fromDef
  }
  throw new Error('configSchema is not a Zod object — cannot derive shape')
}

function escapeValue(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number') {
    return String(value)
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  return String(value)
}

/** Build the canonical cranker.env.example text from the Zod schema. */
export function generateEnvExample(schema: ZodAny): string {
  const shape = schemaShape(schema)

  const header = `# Cranker runtime configuration. Copy to \`cranker.env\` and fill in.
# GENERATED from packages/cranker/src/config.ts (configSchema) by
# tests/cranker-env-sync.test.ts. Edit the schema, not this file — run
# \`make gen-env\` to regenerate. Any hand edit here is overwritten on
# the next regeneration.
#
# Required vars have no default and must be set. Everything else has a
# mainnet-safe default; uncomment to override.`

  const lines: string[] = [header, '']

  // Required block first, then optional — the example reads as a checklist.
  const entries = Object.entries(shape).map(([key, zodType]) => ({ key, field: inspectField(zodType) }))
  const required = entries.filter(e => !e.field.hasDefault)
  const optional = entries.filter(e => e.field.hasDefault)

  if (required.length) {
    lines.push('# ─── Required ──────────────────────────────────────────────────────────')
    for (const { key, field } of required) {
      const doc = field.description?.trim() ?? ''
      lines.push(...doc.split('\n').map(l => `# ${l}`))
      lines.push(`${key}=`)
      lines.push('')
    }
  }

  if (optional.length) {
    lines.push('# ─── Optional (sensible defaults — uncomment to override) ───────────────')
    for (const { key, field } of optional) {
      const doc = field.description?.trim() ?? ''
      lines.push(...doc.split('\n').map(l => `# ${l}`))
      lines.push(`# ${key}=${escapeValue(field.defaultValue)}`)
      lines.push('')
    }
  }

  // Trim trailing blank line; files end with a single newline.
  while (lines.length && lines[lines.length - 1] === '') {
    lines.pop()
  }
  return `${lines.join('\n')}\n`
}

describe('cranker.env.example ↔ configSchema sync', () => {
  const examplePath = resolve(import.meta.dirname, '..', 'deploy', 'cranker', 'cranker.env.example')
  let schema: ZodAny

  beforeEach(async () => {
    const mod = await import('../packages/cranker/src/config')
    schema = mod.configSchema as unknown as ZodAny
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('committed example matches schema-derived text (or regenerates under UPDATE=1)', () => {
    const generated = generateEnvExample(schema)
    const committed = readFileSync(examplePath, 'utf8')

    if (process.env.UPDATE) {
      writeFileSync(examplePath, generated, 'utf8')
      return
    }

    if (generated !== committed) {
      throw new Error(
        'deploy/cranker/cranker.env.example is out of sync with configSchema.\n'
        + 'Regenerate with:  make gen-env\n'
        + 'Do NOT hand-edit the example; change the schema in packages/cranker/src/config.ts.',
      )
    }
    expect(committed).toBe(generated)
  })

  it('schema has at least the baseline required vars (regression guard)', () => {
    const shape = schemaShape(schema)
    for (const required of ['SOLANA_RPC_URL', 'SOLANA_WS_URL', 'FOGO_RPC_URL', 'KEYPAIR_PATH']) {
      expect(shape[required], `expected ${required} in configSchema`).toBeDefined()
      const field = inspectField(shape[required])
      expect(field.hasDefault, `${required} must stay required (no .default())`).toBe(false)
    }
  })
})
