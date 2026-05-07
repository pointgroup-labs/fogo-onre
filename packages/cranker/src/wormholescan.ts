/**
 * Tiny Wormholescan REST client. Two operations the cranker needs:
 *
 *   - Resolve a source-chain tx signature → signed VAA bytes
 *   - Fetch a signed VAA by `(chain, emitter, sequence)` triple
 *
 * Built on global `fetch` (Node 18+). Errors are thrown as plain Errors
 * with the failing URL + status. Originally lived in the CLI; moved
 * here so the daemon and CLI both consume the same implementation.
 */

const DEFAULT_BASE_URL = 'https://api.wormholescan.io'

export interface WormholescanClientOptions {
  baseUrl?: string
  fetchImpl?: typeof fetch
}

export class WormholescanClient {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(opts: WormholescanClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async resolveVaaByTxHash(txHash: string): Promise<Uint8Array | null> {
    const url = `${this.baseUrl}/api/v1/operations?txHash=${encodeURIComponent(txHash)}`
    const json = await this.getJson<{
      operations?: Array<{ vaa?: { raw?: string } }>
    }>(url)
    const raw = json.operations?.find(op => op.vaa?.raw)?.vaa?.raw
    if (!raw) {
      return null
    }
    return decodeBase64(raw)
  }

  async findVaaByEmitterSequence(
    chain: number,
    emitterHex: string,
    sequence: bigint | number,
  ): Promise<Uint8Array | null> {
    const url = `${this.baseUrl}/api/v1/vaas/${chain}/${emitterHex}/${sequence.toString()}`
    const res = await this.fetchImpl(url)
    if (res.status === 404) {
      return null
    }
    if (!res.ok) {
      throw new Error(`Wormholescan ${res.status} ${res.statusText} for ${url}`)
    }
    const json = (await res.json()) as { data?: { vaa?: string } }
    if (!json.data?.vaa) {
      return null
    }
    return decodeBase64(json.data.vaa)
  }

  private async getJson<T>(url: string): Promise<T> {
    const res = await this.fetchImpl(url)
    if (!res.ok) {
      throw new Error(`Wormholescan ${res.status} ${res.statusText} for ${url}`)
    }
    return (await res.json()) as T
  }
}

function decodeBase64(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, 'base64'))
}
