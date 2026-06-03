import chalk from 'chalk'
import { program as cli } from 'commander'
import { relayerCommands } from './commands/relayer'
import { initContext } from './context'

// `status` is read-only (Wormholescan + on-chain reads, no signing).
// Other cranker subcommands DO sign — they fall through to the keypair
// path. The set is keyed on the leaf subcommand name, not the group.
const READ_ONLY_COMMANDS = new Set(['show', 'status'])

cli
  .name('fogo-onre')
  .description('CLI for the Fogo OnRe relayer program')
  .version('0.0.1')
  .option('-u, --url <url>', 'RPC URL or cluster name [env: SOLANA_RPC_URL]', process.env.SOLANA_RPC_URL ?? 'mainnet-beta')
  .option('-k, --keypair <path>', 'Path to keypair file [env: SOLANA_KEYPAIR]')
  .hook('preAction', (command, actionCommand) => {
    const opts = command.opts()
    const isReadOnly = READ_ONLY_COMMANDS.has(actionCommand.name())
    const { connection, keypair } = initContext({
      url: opts.url,
      keypair: isReadOnly ? undefined : opts.keypair,
      readOnly: isReadOnly,
    })

    if (isReadOnly) {
      console.log(chalk.dim(`rpc: ${connection.rpcEndpoint}`))
    } else {
      console.log(chalk.dim(JSON.stringify({
        rpc: connection.rpcEndpoint,
        signer: keypair.publicKey.toBase58(),
      }, null, 2)))
    }
    console.log()
  })

cli.addCommand(relayerCommands())

cli.parseAsync()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    // String(err) → "ErrorName: message", or just "ErrorName" if message
    // is empty (e.g. spl-token's TokenAccountNotFoundError). Plain
    // err.message would render invisibly for those cases.
    console.error(chalk.red(String(e)))
    process.exit(1)
  })
