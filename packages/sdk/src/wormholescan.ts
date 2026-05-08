/**
 * Minimal Wormholescan REST client. Used by crankers/observers to fetch
 * signed VAAs by source-chain tx hash, by `(chain, emitter, sequence)`,
 * or to scan recent emissions for a `(chain, emitter)` pair.
 *
 * Pure `fetch` + base64 — no third-party HTTP deps.
 */

const DEFAULT_BASE_URL = 'https://api.wormholescan.io'

export type WormholescanVaa = {
  vaa: Uint8Array
  sequence: bigint
  txHash: string | null
}

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

  /**
   * List recent VAAs for a (chain, emitter) pair, newest first. Used by
   * scanners to discover Pending bridge messages that don't yet have an
   * on-chain Flow account.
   */
  async listVaasByEmitter(
    chain: number,
    emitterHex: string,
    opts: { pageSize?: number, page?: number } = {},
  ): Promise<WormholescanVaa[]> {
    const pageSize = opts.pageSize ?? 50
    const page = opts.page ?? 0
    const url = `${this.baseUrl}/api/v1/vaas/${chain}/${emitterHex}?pageSize=${pageSize}&page=${page}`
    const json = await this.getJson<{
      data?: Array<{ vaa?: string, sequence?: string | number, txHash?: string }>
    }>(url)
    if (!json.data) {
      return []
    }
    const out: WormholescanVaa[] = []
    for (const item of json.data) {
      if (!item.vaa) {
        continue
      }
      out.push({
        vaa: decodeBase64(item.vaa),
        sequence: BigInt(item.sequence ?? 0),
        txHash: item.txHash ?? null,
      })
    }
    return out
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
