'use client'

import { AnchorProvider } from '@anchor-lang/core'
import { RelayerClient } from '@fogo-onre/sdk'
import { Connection, Keypair } from '@solana/web3.js'

/**
 * Single registry for every RPC `Connection` and the read-only
 * `RelayerClient` the webapp uses. Connections are keyed by URL via a
 * `Map`, so swapping endpoints in the settings drawer transparently
 * returns a fresh instance on the next call without disturbing any other
 * URL's cached connection.
 *
 * Cache eviction is intentionally absent — in normal use a session sees
 * at most a handful of distinct URLs (default + the user's preferred
 * override), so the Map can't meaningfully grow. The `RpcSelect`
 * component debounces custom-URL input commits so mid-typing values
 * don't pollute the cache.
 *
 * The webapp never *signs* on Solana — every Solana-side instruction is
 * permissionless and cranked off-chain — so a throwaway keypair plus a
 * sign-throws stub is a safe stand-in for AnchorProvider's wallet
 * contract. `Wallet` is exported from `@anchor-lang/core`'s CJS build
 * but not its ESM build, so we inline the minimal interface here.
 */

const fogoConnections = new Map<string, Connection>()
const solanaConnections = new Map<string, Connection>()
const relayerClients = new Map<string, RelayerClient>()

export function getFogoConnection(url: string): Connection {
  let connection = fogoConnections.get(url)
  if (connection === undefined) {
    connection = new Connection(url, 'confirmed')
    fogoConnections.set(url, connection)
  }
  return connection
}

export function getSolanaConnection(url: string): Connection {
  let connection = solanaConnections.get(url)
  if (connection === undefined) {
    connection = new Connection(url, 'confirmed')
    solanaConnections.set(url, connection)
  }
  return connection
}

function makeReadOnlyWallet() {
  const payer = Keypair.generate()
  const reject = () => {
    throw new Error('webapp Solana provider is read-only — no signing allowed')
  }
  return {
    publicKey: payer.publicKey,
    payer,
    signTransaction: reject,
    signAllTransactions: reject,
  }
}

export function getReadOnlyRelayerClient(url: string): RelayerClient {
  let client = relayerClients.get(url)
  if (client === undefined) {
    const connection = getSolanaConnection(url)
    const provider = new AnchorProvider(
      connection,
      makeReadOnlyWallet() as never,
      { commitment: 'confirmed' },
    )
    client = new RelayerClient(provider)
    relayerClients.set(url, client)
  }
  return client
}
