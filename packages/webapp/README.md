# @fogo-onre/webapp

Minimal Next.js webapp for the FOGO side of Fogo OnRe. Two actions:
**deposit** USDC.s → receive bONyc; **withdraw** bONyc → receive USDC.s.

## Stack

- Next.js 16 (App Router) + React 19
- Tailwind CSS 4 (no component library)
- `@fogo/sessions-sdk-react` for FOGO wallet sessions

## Run

```bash
pnpm install
pnpm --filter @fogo-onre/webapp dev
```

Visit `http://localhost:3000`.

## Configuration

Override defaults with environment variables:

```bash
NEXT_PUBLIC_FOGO_RPC_URL=https://testnet.fogo.io
NEXT_PUBLIC_SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
```

Token mints (USDC.s, bONyc) are placeholders in `src/lib/config.ts` —
replace with the real published addresses before any non-trivial use.

## What's not wired yet

`useDeposit` and `useWithdraw` build the form state and own the
submit/pending/error UX, but the actual cross-chain transaction
construction is a TODO. They need FOGO-side helpers from
`@fogo-onre/sdk` (Gateway transfer instruction with deposit payload;
NTT transfer instruction with withdraw payload). Both hooks document
the expected SDK call sites.

## Layout

```
src/
├── app/
│   ├── layout.tsx        # FOGO session provider, global styles
│   ├── page.tsx          # deposit + withdraw cards
│   └── globals.css       # tailwind directives
├── components/
│   ├── Header.tsx        # logo + SessionButton
│   ├── DepositCard.tsx
│   ├── WithdrawCard.tsx
│   ├── AmountInput.tsx
│   └── StatusLine.tsx
├── hooks/
│   ├── useDeposit.ts
│   └── useWithdraw.ts
├── lib/
│   ├── config.ts         # mints, RPCs, decimals
│   └── tx.ts             # status union + amount parsing
└── providers.tsx         # FogoSessionProvider wrapper
```
