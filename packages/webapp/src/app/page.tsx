import DepositCard from '@/components/DepositCard'
import Header from '@/components/Header'
import WithdrawCard from '@/components/WithdrawCard'

export default function Page() {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 px-6 py-12">
        <div className="mx-auto max-w-md flex flex-col gap-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Yield from OnRe</h1>
            <p className="mt-1 text-sm text-neutral-400">
              Deposit USDC.s on FOGO. Hold bONyc. Withdraw when you want.
            </p>
          </div>
          <DepositCard />
          <WithdrawCard />
        </div>
      </main>
      <footer className="border-t border-neutral-800 px-6 py-4 text-xs text-neutral-500">
        Cross-chain via Wormhole Gateway and NTT. The relayer is immutable and
        custody-free —
        {' '}
        <a className="underline hover:text-neutral-300" href="https://github.com/your-org/fogo-onre/blob/main/docs/security.md">
          security model
        </a>
        .
      </footer>
    </div>
  )
}
