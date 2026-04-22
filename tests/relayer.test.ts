import type { LiteSVM } from 'litesvm'
import { BN } from '@anchor-lang/core'
import {
  findAuthorityPda,
  findConfigPda,
  findInflightFlowPda,
  findOutflightFlowPda,
  FOGO_WORMHOLE_CHAIN_ID,
  GATEWAY_PROGRAM_ID,
  NTT_PROGRAM_ID,
  ONRE_PROGRAM_ID,
  RelayerClient,
  WORMHOLE_CORE_BRIDGE_ID,
} from '@fogo-onre/sdk'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Keypair, PublicKey } from '@solana/web3.js'
import {
  buildPostedVaaData,
  createAta,
  createMint,
  createProvider,
  createSvm,
  expectError,
  expectFailure,
  failedInProgram,
  findValidatedTransceiverMessagePda,
  FlowStatus,
  logMatches,
  mintTo,
  setFlowAccount,
  setPostedVaa,
  setValidatedTransceiverMessage,
} from './utils'

describe('relayer', () => {
  let svm: LiteSVM
  let authority: Keypair
  let client: RelayerClient
  let usdcMint: Keypair
  let onycMint: Keypair
  // External ONyc fee vault — any pre-existing ONyc account that is NOT
  // the relayer's operating ONyc ATA. Tests use an authority-owned ATA.
  let feeVault: PublicKey

  beforeEach(async () => {
    svm = createSvm()
    authority = Keypair.generate()
    const provider = createProvider(svm, authority)
    client = new RelayerClient(provider as any)
    usdcMint = createMint(svm, authority, 6)
    onycMint = createMint(svm, authority, 6)
    feeVault = createAta(svm, authority, onycMint.publicKey, authority.publicKey)
  })

  // ---------------------------------------------------------------------------
  // initialize
  // ---------------------------------------------------------------------------

  describe('initialize', () => {
    it('creates config PDA and stores parameters', async () => {
      await client
        .initialize({
          authority: authority.publicKey,
          usdcMint: usdcMint.publicKey,
          onycMint: onycMint.publicKey,
          feeVault,
          depositFeeBps: 50,
          withdrawFeeBps: 100,
        })
        .rpc()

      const config = await client.fetchConfig()
      expect(config.authority.toBase58()).toBe(authority.publicKey.toBase58())
      expect(config.usdcMint.toBase58()).toBe(usdcMint.publicKey.toBase58())
      expect(config.onycMint.toBase58()).toBe(onycMint.publicKey.toBase58())
      expect(config.depositFeeBps).toBe(50)
      expect(config.withdrawFeeBps).toBe(100)
    })

    it('rejects fee bps above 10000', async () => {
      // Asserts the specific `FeeBpsTooHigh` custom error from the program,
      // not just "any throw" — guarantees we exercised the bps validator
      // rather than tripping some unrelated constraint upstream.
      await expectError(
        () =>
          client
            .initialize({
              authority: authority.publicKey,
              usdcMint: usdcMint.publicKey,
              onycMint: onycMint.publicKey,
              feeVault,
              depositFeeBps: 10_001,
              withdrawFeeBps: 0,
            })
            .rpc(),
        'FeeBpsTooHigh',
      )
    })

    it('rejects double initialization', async () => {
      // First init: fees = 25/75. Distinctive values so we can later prove
      // the second call did not silently overwrite config.
      await client
        .initialize({
          authority: authority.publicKey,
          usdcMint: usdcMint.publicKey,
          onycMint: onycMint.publicKey,
          feeVault,
          depositFeeBps: 25,
          withdrawFeeBps: 75,
        })
        .rpc()

      // Capture the SendTransactionError. Our `createProvider` wrapper
      // (tests/utils/svm.ts) preloads `.logs` from the FailedTransactionMetadata,
      // so we can assert directly against the program logs without an
      // additional RPC roundtrip.
      let caught: any
      try {
        await client
          .initialize({
            authority: authority.publicKey,
            usdcMint: usdcMint.publicKey,
            onycMint: onycMint.publicKey,
            feeVault,
            depositFeeBps: 999, // would be visible if an overwrite slipped through
            withdrawFeeBps: 888,
          })
          .rpc()
      } catch (e) {
        caught = e
      }
      expect(caught).toBeDefined()

      // Strong assertion #1 — the failure is the system-program rejecting the
      // create_account CPI because the Config PDA already has lamports. This
      // is what the Anchor `init` constraint emits, and it's distinct from
      // any other failure mode (signer / seeds / mint mismatch / etc.).
      const logs: string[] = Array.isArray(caught.logs) ? caught.logs : []

      // The unique fingerprint of "init constraint tripped on an existing
      // Config PDA" is the SYSTEM PROGRAM (not the relayer, not Anchor's own
      // checks) emitting `Allocate: account Address { address: <CONFIG_PDA>, ... } already in use`
      // for the SPECIFIC Config PDA — followed by `custom program error: 0x0`
      // returned from system program 11111111111111111111111111111111.
      //
      // Why this is specific to the claimed failure path:
      //   - Wrong signer / missing sig → fails at signature verify, never reaches the system CPI.
      //   - Wrong seeds / has_one      → Anchor emits its own `Constraint*` error and skips create_account.
      //   - Insufficient lamports      → `InsufficientFundsForRent`, no `Allocate` log.
      //   - "Allocate ... already in use" CAN ONLY be emitted by the system program
      //     when create_account is invoked on an address that already has lamports,
      //     and Anchor's `init` is the only thing in this instruction that issues
      //     that CPI on the Config PDA.
      //
      // Pinning the address to the derived `findConfigPda` result rules out the
      // remote possibility of an unrelated account collision being matched.
      const [configPda] = findConfigPda(client.program.programId)
      const allocateRegex = new RegExp(
        `Allocate: account Address \\{ address: ${configPda.toBase58()}[^}]*\\} already in use`,
      )
      const sysProgramFailRegex = /Program 11111111111111111111111111111111 failed: custom program error: 0x0/

      expect(logs.some(l => allocateRegex.test(l))).toBe(true)
      expect(logs.some(l => sysProgramFailRegex.test(l))).toBe(true)

      // Strong assertion #2 — original config is intact. Belt-and-suspenders:
      // confirms not only that the second call threw, but that no field was
      // mutated before the constraint fired.
      const config = await client.fetchConfig()
      expect(config.depositFeeBps).toBe(25)
      expect(config.withdrawFeeBps).toBe(75)
    })

    it('allows zero and max valid fees', async () => {
      await client
        .initialize({
          authority: authority.publicKey,
          usdcMint: usdcMint.publicKey,
          onycMint: onycMint.publicKey,
          feeVault,
          depositFeeBps: 0,
          withdrawFeeBps: 10_000,
        })
        .rpc()

      const config = await client.fetchConfig()
      expect(config.depositFeeBps).toBe(0)
      expect(config.withdrawFeeBps).toBe(10_000)
    })
  })

  // ---------------------------------------------------------------------------
  // configure
  // ---------------------------------------------------------------------------

  describe('configure', () => {
    beforeEach(async () => {
      await client
        .initialize({
          authority: authority.publicKey,
          usdcMint: usdcMint.publicKey,
          onycMint: onycMint.publicKey,
          feeVault,
          depositFeeBps: 50,
          withdrawFeeBps: 100,
        })
        .rpc()
    })

    it('updates both fee values', async () => {
      await (await client.configure({
        depositFeeBps: 200,
        withdrawFeeBps: 300,
      })).rpc()

      const config = await client.fetchConfig()
      expect(config.depositFeeBps).toBe(200)
      expect(config.withdrawFeeBps).toBe(300)
      expect(config.feeVault.toBase58()).toBe(feeVault.toBase58())
    })

    it('leaves fees unchanged when args are omitted (None)', async () => {
      // Empty configure — no fees, no vault. Authority defaults to provider
      // wallet, onycMint is lazily fetched from config. This is a true no-op.
      await (await client.configure({})).rpc()

      const config = await client.fetchConfig()
      expect(config.depositFeeBps).toBe(50)
      expect(config.withdrawFeeBps).toBe(100)
    })

    it('rotates fee_vault to a new external account', async () => {
      const newOwner = Keypair.generate()
      const newFeeVault = createAta(svm, authority, onycMint.publicKey, newOwner.publicKey)

      await (await client.configure({ feeVault: newFeeVault })).rpc()

      const config = await client.fetchConfig()
      expect(config.feeVault.toBase58()).toBe(newFeeVault.toBase58())
    })

    it('updates only fees with feeVault omitted (Optional account = null)', async () => {
      // Snapshot current fee_vault — must remain unchanged after a
      // fee-only update that omits the account entirely.
      const before = await client.fetchConfig()
      const beforeVault = before.feeVault.toBase58()

      // Minimal-args fee-only update — SDK defaults authority to provider
      // wallet, lazy-fetches onycMint from config, and sends `null` for the
      // optional fee_vault account. The on-chain handler skips the rotation;
      // mint + anti-aliasing checks don't run (account itself is absent).
      await (await client.configure({
        depositFeeBps: 200,
        withdrawFeeBps: 250,
      })).rpc()

      const after = await client.fetchConfig()
      expect(after.depositFeeBps).toBe(200)
      expect(after.withdrawFeeBps).toBe(250)
      expect(after.feeVault.toBase58()).toBe(beforeVault)
    })

    it('rejects fee_vault that aliases the relayer onyc ATA', async () => {
      const [authorityPda] = findAuthorityPda(client.program.programId)
      // Anchor's `init` made this ATA at initialize time.
      const aliasedVault = getAssociatedTokenAddressSync(onycMint.publicKey, authorityPda, true)

      await expectError(
        async () => (await client.configure({ feeVault: aliasedVault })).rpc(),
        'FeeVaultAliasesUserAta',
      )
    })

    it('rejects non-authority signer', async () => {
      const rando = Keypair.generate()
      const randoProvider = createProvider(svm, rando)
      const randoClient = new RelayerClient(randoProvider as any)

      // randoClient's provider wallet IS rando, so default-authority (now
      // sourced from provider.wallet.publicKey) gives us exactly the
      // unauthorized-signer scenario without needing to pass it explicitly.
      await expectError(
        async () => (await randoClient.configure({
          depositFeeBps: 0,
          withdrawFeeBps: 0,
        })).rpc(),
        'UnauthorizedAuthority',
      )
    })

    it('rejects fee above 10000 bps', async () => {
      await expectError(
        async () => (await client.configure({
          depositFeeBps: 10_001,
          withdrawFeeBps: 0,
        })).rpc(),
        'FeeBpsTooHigh',
      )
    })

    it('rotates authority via two-step propose + accept', async () => {
      const newAuthority = Keypair.generate()

      // Step 1: current authority proposes. config.authority is unchanged;
      // pending_authority is set.
      await (await client.configure({ newAuthority: newAuthority.publicKey })).rpc()

      let config = await client.fetchConfig()
      expect(config.authority.toBase58()).toBe(authority.publicKey.toBase58())
      expect(config.pendingAuthority?.toBase58()).toBe(newAuthority.publicKey.toBase58())

      // Old authority can still configure during the pending window.
      await (await client.configure({ depositFeeBps: 11 })).rpc()
      expect((await client.fetchConfig()).depositFeeBps).toBe(11)

      // Step 2: pending authority accepts (separate tx, no current-authority
      // signature required — by design, so two independent multisigs can
      // each act in isolation).
      const newProvider = createProvider(svm, newAuthority)
      const newClient = new RelayerClient(newProvider as any)
      await (await newClient.acceptAuthority()).rpc()

      config = await client.fetchConfig()
      expect(config.authority.toBase58()).toBe(newAuthority.publicKey.toBase58())
      expect(config.pendingAuthority).toBeNull()

      // Old authority is now locked out.
      await expectError(
        async () => (await client.configure({})).rpc(),
        'UnauthorizedAuthority',
      )

      // New authority can drive configure.
      await (await newClient.configure({ depositFeeBps: 77 })).rpc()
      expect((await newClient.fetchConfig()).depositFeeBps).toBe(77)
    })

    it('overwrites a pending proposal with a new one', async () => {
      const firstProposal = Keypair.generate()
      const secondProposal = Keypair.generate()

      await (await client.configure({ newAuthority: firstProposal.publicKey })).rpc()
      expect((await client.fetchConfig()).pendingAuthority?.toBase58())
        .toBe(firstProposal.publicKey.toBase58())

      // Re-propose: prior pending is replaced.
      await (await client.configure({ newAuthority: secondProposal.publicKey })).rpc()
      expect((await client.fetchConfig()).pendingAuthority?.toBase58())
        .toBe(secondProposal.publicKey.toBase58())

      // The first proposal can no longer accept.
      const firstProvider = createProvider(svm, firstProposal)
      const firstClient = new RelayerClient(firstProvider as any)
      await expectError(
        async () => (await firstClient.acceptAuthority()).rpc(),
        'PendingAuthorityMismatch',
      )
    })

    it('cancels a pending proposal via PublicKey.default sentinel', async () => {
      const proposal = Keypair.generate()

      await (await client.configure({ newAuthority: proposal.publicKey })).rpc()
      expect((await client.fetchConfig()).pendingAuthority?.toBase58())
        .toBe(proposal.publicKey.toBase58())

      // Cancel — sentinel default pubkey clears the pending slot.
      await (await client.configure({ newAuthority: PublicKey.default })).rpc()
      expect((await client.fetchConfig()).pendingAuthority).toBeNull()

      // Cancelled proposal cannot accept.
      const proposalProvider = createProvider(svm, proposal)
      const proposalClient = new RelayerClient(proposalProvider as any)
      await expectError(
        async () => (await proposalClient.acceptAuthority()).rpc(),
        'NoPendingAuthority',
      )
    })

    it('accept_authority fails when no proposal is in flight', async () => {
      const random = Keypair.generate()
      const randomProvider = createProvider(svm, random)
      const randomClient = new RelayerClient(randomProvider as any)
      await expectError(
        async () => (await randomClient.acceptAuthority()).rpc(),
        'NoPendingAuthority',
      )
    })

    it('accept_authority fails when signer is not the pending authority', async () => {
      const proposal = Keypair.generate()
      const wrongSigner = Keypair.generate()

      await (await client.configure({ newAuthority: proposal.publicKey })).rpc()

      const wrongProvider = createProvider(svm, wrongSigner)
      const wrongClient = new RelayerClient(wrongProvider as any)
      await expectError(
        async () => (await wrongClient.acceptAuthority()).rpc(),
        'PendingAuthorityMismatch',
      )

      // Pending slot is unchanged after the failed attempt.
      expect((await client.fetchConfig()).pendingAuthority?.toBase58())
        .toBe(proposal.publicKey.toBase58())
    })

    it('non-authority cannot propose a rotation', async () => {
      const rando = Keypair.generate()
      const randoProvider = createProvider(svm, rando)
      const randoClient = new RelayerClient(randoProvider as any)
      const attackerKey = Keypair.generate()

      await expectError(
        async () => (await randoClient.configure({ newAuthority: attackerKey.publicKey })).rpc(),
        'UnauthorizedAuthority',
      )

      const config = await client.fetchConfig()
      expect(config.authority.toBase58()).toBe(authority.publicKey.toBase58())
      expect(config.pendingAuthority).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // sweep — authority extraction path for stranded balances in the
  // relayer-PDA-owned ATAs (pre-upgrade commingled fees, dust, etc.)
  // ---------------------------------------------------------------------------

  describe('sweep', () => {
    beforeEach(async () => {
      await client
        .initialize({
          authority: authority.publicKey,
          usdcMint: usdcMint.publicKey,
          onycMint: onycMint.publicKey,
          feeVault,
          depositFeeBps: 50,
          withdrawFeeBps: 100,
        })
        .rpc()

      // Seed relayer authority PDA's USDC ATA (simulating dust/stranded balance)
      const [authorityPda] = findAuthorityPda(client.program.programId)
      mintTo(svm, authority, usdcMint.publicKey, authorityPda, 1_000_000)
    })

    it('moves USDC out of the relayer ATA to a destination', async () => {
      const destAta = createAta(svm, authority, usdcMint.publicKey, authority.publicKey)

      await client
        .sweep({
          authority: authority.publicKey,
          mint: usdcMint.publicKey,
          to: destAta,
          amount: new BN(500_000),
        })
        .rpc()

      const account = svm.getAccount(destAta)
      expect(account).toBeTruthy()
    })

    it('rejects non-authority signer', async () => {
      const rando = Keypair.generate()
      const randoProvider = createProvider(svm, rando)
      const randoClient = new RelayerClient(randoProvider as any)
      const destAta = createAta(svm, authority, usdcMint.publicKey, authority.publicKey)

      await expectError(
        () =>
          randoClient
            .sweep({
              authority: rando.publicKey,
              mint: usdcMint.publicKey,
              to: destAta,
              amount: new BN(100),
            })
            .rpc(),
        'UnauthorizedAuthority',
      )
    })
  })

  // ---------------------------------------------------------------------------
  // full admin flow: initialize → configure → sweep
  // ---------------------------------------------------------------------------

  describe('full admin flow', () => {
    it('initialize → configure → sweep', async () => {
      // 1. Initialize with default fees + external fee vault
      await client
        .initialize({
          authority: authority.publicKey,
          usdcMint: usdcMint.publicKey,
          onycMint: onycMint.publicKey,
          feeVault,
          depositFeeBps: 50,
          withdrawFeeBps: 100,
        })
        .rpc()

      const config1 = await client.fetchConfig()
      expect(config1.depositFeeBps).toBe(50)

      // 2. Reconfigure: update fees + rotate fee vault
      const newOwner = Keypair.generate()
      const newFeeVault = createAta(svm, authority, onycMint.publicKey, newOwner.publicKey)

      await (await client.configure({
        feeVault: newFeeVault,
        depositFeeBps: 150,
        withdrawFeeBps: 250,
      })).rpc()

      const config2 = await client.fetchConfig()
      expect(config2.depositFeeBps).toBe(150)
      expect(config2.withdrawFeeBps).toBe(250)
      expect(config2.feeVault.toBase58()).toBe(newFeeVault.toBase58())

      // 3. Seed relayer PDA with stranded USDC and sweep it out
      const [authorityPda] = findAuthorityPda(client.program.programId)
      mintTo(svm, authority, usdcMint.publicKey, authorityPda, 2_000_000)
      const destAta = createAta(svm, authority, usdcMint.publicKey, authority.publicKey)

      await client
        .sweep({
          authority: authority.publicKey,
          mint: usdcMint.publicKey,
          to: destAta,
          amount: new BN(1_500_000),
        })
        .rpc()

      const account = svm.getAccount(destAta)
      expect(account).toBeTruthy()
    })
  })

  // ---------------------------------------------------------------------------
  // deposit flow (claim_usdc → swap_usdc_to_onyc → lock_onyc)
  // ---------------------------------------------------------------------------

  describe('deposit flow', () => {
    const fogoSender = new Uint8Array(32).fill(0xAB)

    beforeEach(async () => {
      await client
        .initialize({
          authority: authority.publicKey,
          usdcMint: usdcMint.publicKey,
          onycMint: onycMint.publicKey,
          feeVault,
          depositFeeBps: 50,
          withdrawFeeBps: 100,
        })
        .rpc()
    })

    it('claim_usdc rejects posted VAA not owned by Core Bridge', async () => {
      const fakeVaa = Keypair.generate()
      const fakeClaim = Keypair.generate()

      // VAA-shaped account owned by system program (wrong owner)
      svm.setAccount(fakeVaa.publicKey, {
        executable: false,
        owner: new PublicKey('11111111111111111111111111111111'),
        lamports: 1_000_000,
        data: new Uint8Array(200),
        rentEpoch: 0,
      })

      // Anchor's `owner = WORMHOLE_CORE_BRIDGE_ID` constraint on `posted_vaa`
      // emits `ConstraintOwner` (Anchor 2004). Asserting on the code rules
      // out unrelated failures (signer / seeds / some other accidental
      // mis-config from succeeding on the owner check).
      await expectError(
        () =>
          client
            .claimUsdc({
              payer: authority.publicKey,
              usdcMint: usdcMint.publicKey,
              postedVaa: fakeVaa.publicKey,
              gatewayClaim: fakeClaim.publicKey,
            })
            .rpc(),
        'ConstraintOwner',
      )
    })

    it('claim_usdc rejects too-short remaining_accounts (InvalidAccountSplit)', async () => {
      const vaaKeypair = Keypair.generate()
      const gatewayClaim = Keypair.generate()

      setPostedVaa(svm, vaaKeypair.publicKey, {
        fogoSender,
        amount: 1_000_000n,
      })

      // claim_usdc pins `posted_vaa` and `gateway_claim` to fixed positional
      // slots inside `remaining_accounts` (slots 2 and 3) to defend against
      // a VAA-substitution attack on the TB CPI. Passing a short list trips
      // `InvalidAccountSplit` BEFORE VAA parsing or the CPI — proving the
      // length guard fires first.
      await expectError(
        () =>
          client
            .claimUsdc({
              payer: authority.publicKey,
              usdcMint: usdcMint.publicKey,
              postedVaa: vaaKeypair.publicKey,
              gatewayClaim: gatewayClaim.publicKey,
            })
            .remainingAccounts([
              { pubkey: GATEWAY_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: client.authorityPda, isSigner: false, isWritable: false },
            ])
            .rpc(),
        'InvalidAccountSplit',
      )
    })

    it('claim_usdc rejects VAA with corrupted msg tag (InvalidVaa)', async () => {
      const vaaKeypair = Keypair.generate()
      const gatewayClaim = Keypair.generate()
      const data = buildPostedVaaData({ fogoSender, amount: 1_000_000n })
      data[0] = 0x00 // corrupt "msg" tag
      data[1] = 0x00
      data[2] = 0x00

      svm.setAccount(vaaKeypair.publicKey, {
        executable: false,
        owner: WORMHOLE_CORE_BRIDGE_ID,
        lamports: 1_000_000,
        data,
        rentEpoch: 0,
      })

      // The vaa.rs parser asserts the leading 3 bytes are "msg" or "msu";
      // anything else returns InvalidVaa. Asserting on the specific code
      // proves we hit that exact check rather than an upstream owner /
      // discriminator failure. Pad remaining_accounts with vaaKeypair at
      // slot 2 and gatewayClaim at slot 3 so the relayer's positional
      // binding guards pass and execution reaches the parser.
      await expectError(
        () =>
          client
            .claimUsdc({
              payer: authority.publicKey,
              usdcMint: usdcMint.publicKey,
              postedVaa: vaaKeypair.publicKey,
              gatewayClaim: gatewayClaim.publicKey,
            })
            .remainingAccounts([
              { pubkey: PublicKey.default, isSigner: false, isWritable: false },
              { pubkey: PublicKey.default, isSigner: false, isWritable: false },
              { pubkey: vaaKeypair.publicKey, isSigner: false, isWritable: false },
              { pubkey: gatewayClaim.publicKey, isSigner: false, isWritable: false },
            ])
            .rpc(),
        'InvalidVaa',
      )
    })

    it('claim_usdc rejects replay when inflight Flow PDA already exists', async () => {
      const gatewayClaim = Keypair.generate()

      // Inject a Flow PDA at the expected inflight address to simulate
      // a prior claim_usdc having already created it
      const [inflightPda, bump] = findInflightFlowPda(gatewayClaim.publicKey, client.program.programId)
      setFlowAccount(svm, inflightPda, {
        fogoSender,
        status: FlowStatus.Claimed,
        amount: 500_000n,
        payer: authority.publicKey,
        bump,
      }, client.program.programId)

      const vaaKeypair = Keypair.generate()
      setPostedVaa(svm, vaaKeypair.publicKey, { fogoSender, amount: 1_000_000n })

      // Anchor `init` on a PDA with pre-existing lamports → system program
      // returns "already in use" (custom error 0x0). Same fingerprint as the
      // double-init test but for the inflight Flow PDA. Matching the log
      // line proves the init guard fired and no other validation gave up
      // first.
      await expectFailure(
        () =>
          client
            .claimUsdc({
              payer: authority.publicKey,
              usdcMint: usdcMint.publicKey,
              postedVaa: vaaKeypair.publicKey,
              gatewayClaim: gatewayClaim.publicKey,
            })
            .rpc(),
        logMatches(/already in use/i),
        'inflight Flow init constraint should fire (account already exists)',
      )
    })

    it('swap_usdc_to_onyc rejects flow not in Claimed status', async () => {
      const gatewayClaim = Keypair.generate()
      const [inflightPda, bump] = findInflightFlowPda(gatewayClaim.publicKey, client.program.programId)

      // Inject a Swapped flow — swap_usdc_to_onyc requires Claimed
      setFlowAccount(svm, inflightPda, {
        fogoSender,
        status: FlowStatus.Swapped,
        amount: 500_000n,
        payer: authority.publicKey,
        bump,
      }, client.program.programId)

      await expectError(
        () =>
          client
            .swapUsdcToOnyc({
              usdcMint: usdcMint.publicKey,
              onycMint: onycMint.publicKey,
              gatewayClaim: gatewayClaim.publicKey,
            })
            .remainingAccounts([
              { pubkey: ONRE_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: client.authorityPda, isSigner: false, isWritable: false },
            ])
            .rpc(),
        'FlowStatusMismatch',
      )
    })

    it('swap_usdc_to_onyc with Claimed flow attempts OnRe CPI', async () => {
      const gatewayClaim = Keypair.generate()
      const [inflightPda, bump] = findInflightFlowPda(gatewayClaim.publicKey, client.program.programId)

      // Inject a Claimed flow
      setFlowAccount(svm, inflightPda, {
        fogoSender,
        status: FlowStatus.Claimed,
        amount: 500_000n,
        payer: authority.publicKey,
        bump,
      }, client.program.programId)

      // Fund USDC ATA so the relayer has balance
      const [authorityPda] = findAuthorityPda(client.program.programId)
      mintTo(svm, authority, usdcMint.publicKey, authorityPda, 500_000)

      // OnRe is stubbed only by program ID — no offer state, no vault ATAs.
      // The CPI must therefore fail INSIDE OnRe, proving the relayer's own
      // status check + balance snapshot passed up to the CPI boundary.
      await expectFailure(
        () =>
          client
            .swapUsdcToOnyc({
              usdcMint: usdcMint.publicKey,
              onycMint: onycMint.publicKey,
              gatewayClaim: gatewayClaim.publicKey,
            })
            .remainingAccounts([
              { pubkey: ONRE_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: client.authorityPda, isSigner: false, isWritable: false },
            ])
            .rpc(),
        failedInProgram(ONRE_PROGRAM_ID),
        'OnRe CPI should be reached and fail (relayer validations passed)',
      )
    })

    it('lock_onyc rejects flow not in Swapped status', async () => {
      const gatewayClaim = Keypair.generate()
      const [inflightPda, bump] = findInflightFlowPda(gatewayClaim.publicKey, client.program.programId)

      // Inject a Claimed flow — lock_onyc requires Swapped
      setFlowAccount(svm, inflightPda, {
        fogoSender,
        status: FlowStatus.Claimed,
        amount: 500_000n,
        payer: authority.publicKey,
        bump,
      }, client.program.programId)

      await expectError(
        () =>
          client
            .lockOnyc({
              payer: authority.publicKey,
              onycMint: onycMint.publicKey,
              gatewayClaim: gatewayClaim.publicKey,
              rentDestination: authority.publicKey,
            })
            .remainingAccounts([
              { pubkey: NTT_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: client.authorityPda, isSigner: false, isWritable: false },
            ])
            .rpc(),
        'FlowStatusMismatch',
      )
    })

    it('lock_onyc rejects wrong rent destination', async () => {
      const gatewayClaim = Keypair.generate()
      const [inflightPda, bump] = findInflightFlowPda(gatewayClaim.publicKey, client.program.programId)
      const rando = Keypair.generate()
      svm.airdrop(rando.publicKey, BigInt(1e9))

      // Inject a Swapped flow with payer = authority
      setFlowAccount(svm, inflightPda, {
        fogoSender,
        status: FlowStatus.Swapped,
        amount: 500_000n,
        payer: authority.publicKey,
        bump,
      }, client.program.programId)

      // `#[account(mut, address = inflight_flow.payer)]` on rent_destination
      // makes Anchor emit `ConstraintAddress` when the supplied account
      // doesn't equal the stored payer. Asserting on the code rules out
      // the test passing because of, e.g., a missing-signer issue.
      await expectError(
        () =>
          client
            .lockOnyc({
              payer: authority.publicKey,
              onycMint: onycMint.publicKey,
              gatewayClaim: gatewayClaim.publicKey,
              rentDestination: rando.publicKey,
            })
            .remainingAccounts([
              { pubkey: NTT_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: client.authorityPda, isSigner: false, isWritable: false },
            ])
            .rpc(),
        'ConstraintAddress',
      )
    })

    it('lock_onyc rejects Swapped flow without session authority PDA', async () => {
      const gatewayClaim = Keypair.generate()
      const [inflightPda, bump] = findInflightFlowPda(gatewayClaim.publicKey, client.program.programId)

      // Inject a Swapped flow
      setFlowAccount(svm, inflightPda, {
        fogoSender,
        status: FlowStatus.Swapped,
        amount: 500_000n,
        payer: authority.publicKey,
        bump,
      }, client.program.programId)

      // Fund ONyc ATA
      const [authorityPda] = findAuthorityPda(client.program.programId)
      mintTo(svm, authority, onycMint.publicKey, authorityPda, 500_000)

      // Test omits the NTT session-authority PDA from remaining_accounts.
      // The relayer's own preflight check (`MissingSessionAuthority`) should
      // fire before any NTT CPI runs — proving the relayer enforces the
      // upstream NTT account requirement up front rather than letting NTT
      // surface a confusing "wrong signer" error mid-CPI.
      await expectError(
        () =>
          client
            .lockOnyc({
              payer: authority.publicKey,
              onycMint: onycMint.publicKey,
              gatewayClaim: gatewayClaim.publicKey,
              rentDestination: authority.publicKey,
            })
            .remainingAccounts([
              { pubkey: NTT_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: client.authorityPda, isSigner: false, isWritable: false },
            ])
            .rpc(),
        'MissingSessionAuthority',
      )
    })
  })

  // ---------------------------------------------------------------------------
  // withdrawal flow (unlock_onyc → swap_onyc_to_usdc → send_usdc_to_user)
  // ---------------------------------------------------------------------------

  describe('withdrawal flow', () => {
    const fogoSender = new Uint8Array(32).fill(0xCD)

    beforeEach(async () => {
      await client
        .initialize({
          authority: authority.publicKey,
          usdcMint: usdcMint.publicKey,
          onycMint: onycMint.publicKey,
          feeVault,
          depositFeeBps: 50,
          withdrawFeeBps: 100,
        })
        .rpc()
    })

    // Build a minimal transceiver-message struct we can reuse across tests.
    // `sender` is the only field the handler reads — the rest is arbitrary.
    function makeTransceiverMessage(senderBytes: Uint8Array, messageId: Uint8Array) {
      return {
        fromChain: FOGO_WORMHOLE_CHAIN_ID,
        sourceNttManager: new Uint8Array(32).fill(0x22),
        recipientNttManager: NTT_PROGRAM_ID.toBytes(),
        message: {
          id: messageId,
          sender: senderBytes,
          trimmedAmount: 1_000_000n,
          trimmedDecimals: 6,
          sourceToken: new Uint8Array(32).fill(0x33),
          toChain: 1,
          to: new Uint8Array(32).fill(0x44),
        },
      }
    }

    it('unlock_onyc rejects zero fogo_sender', async () => {
      const nttInboxItem = Keypair.generate()
      const messageId = new Uint8Array(32)
      crypto.getRandomValues(messageId)
      const [validatedMsgPda] = findValidatedTransceiverMessagePda(
        FOGO_WORMHOLE_CHAIN_ID,
        messageId,
        NTT_PROGRAM_ID,
      )
      setValidatedTransceiverMessage(
        svm,
        validatedMsgPda,
        NTT_PROGRAM_ID,
        makeTransceiverMessage(new Uint8Array(32), messageId),
      )

      // The handler explicitly checks `fogo_sender != [0u8; 32]` after
      // parsing the validated transceiver message. Asserting on the code
      // proves we hit THIS check and not, say, the discriminator or
      // length checks earlier in the same handler.
      await expectError(
        () =>
          client
            .unlockOnyc({
              payer: authority.publicKey,
              onycMint: onycMint.publicKey,
              nttInboxItem: nttInboxItem.publicKey,
              nttTransceiverMessage: validatedMsgPda,
              redeemAccountsLen: 1,
            })
            .remainingAccounts([
              { pubkey: NTT_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: client.authorityPda, isSigner: false, isWritable: false },
            ])
            .rpc(),
        'ZeroFogoSender',
      )
    })

    it('unlock_onyc rejects invalid account split (redeem_accounts_len=0)', async () => {
      const nttInboxItem = Keypair.generate()
      const messageId = new Uint8Array(32)
      crypto.getRandomValues(messageId)
      const [validatedMsgPda] = findValidatedTransceiverMessagePda(
        FOGO_WORMHOLE_CHAIN_ID,
        messageId,
        NTT_PROGRAM_ID,
      )
      setValidatedTransceiverMessage(
        svm,
        validatedMsgPda,
        NTT_PROGRAM_ID,
        makeTransceiverMessage(fogoSender, messageId),
      )

      // Handler validates redeem_accounts_len > 0 before splitting
      // remaining_accounts; passing 0 must surface the Anchor code, not
      // an opaque slice panic.
      await expectError(
        () =>
          client
            .unlockOnyc({
              payer: authority.publicKey,
              onycMint: onycMint.publicKey,
              nttInboxItem: nttInboxItem.publicKey,
              nttTransceiverMessage: validatedMsgPda,
              redeemAccountsLen: 0,
            })
            .remainingAccounts([
              { pubkey: NTT_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: client.authorityPda, isSigner: false, isWritable: false },
            ])
            .rpc(),
        'InvalidAccountSplit',
      )
    })

    it('unlock_onyc rejects double unlock (same ntt_inbox_item)', async () => {
      const nttInboxItem = Keypair.generate()
      const [outflightPda, bump] = findOutflightFlowPda(nttInboxItem.publicKey, client.program.programId)

      // Inject an existing outflight flow to simulate prior unlock
      setFlowAccount(svm, outflightPda, {
        fogoSender,
        status: FlowStatus.Claimed,
        amount: 500_000n,
        payer: authority.publicKey,
        bump,
      }, client.program.programId)

      const messageId = new Uint8Array(32)
      crypto.getRandomValues(messageId)
      const [validatedMsgPda] = findValidatedTransceiverMessagePda(
        FOGO_WORMHOLE_CHAIN_ID,
        messageId,
        NTT_PROGRAM_ID,
      )
      setValidatedTransceiverMessage(
        svm,
        validatedMsgPda,
        NTT_PROGRAM_ID,
        makeTransceiverMessage(fogoSender, messageId),
      )

      // init constraint on outflight_flow should fail (account already exists).
      // The system program emits "already in use" when an init account
      // collides with a pre-existing one — proves replay protection holds.
      await expectFailure(
        () =>
          client
            .unlockOnyc({
              payer: authority.publicKey,
              onycMint: onycMint.publicKey,
              nttInboxItem: nttInboxItem.publicKey,
              nttTransceiverMessage: validatedMsgPda,
              redeemAccountsLen: 1,
            })
            .remainingAccounts([
              { pubkey: NTT_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: client.authorityPda, isSigner: false, isWritable: false },
            ])
            .rpc(),
        logMatches(/already in use/i),
        'outflight Flow init constraint should fire on replay',
      )
    })

    it('swap_onyc_to_usdc rejects flow not in Claimed status', async () => {
      const nttInboxItem = Keypair.generate()
      const [outflightPda, bump] = findOutflightFlowPda(nttInboxItem.publicKey, client.program.programId)

      // Inject a Swapped flow — swap_onyc_to_usdc requires Claimed
      setFlowAccount(svm, outflightPda, {
        fogoSender,
        status: FlowStatus.Swapped,
        amount: 500_000n,
        payer: authority.publicKey,
        bump,
      }, client.program.programId)

      await expectError(
        () =>
          client
            .swapOnycToUsdc({
              usdcMint: usdcMint.publicKey,
              onycMint: onycMint.publicKey,
              nttInboxItem: nttInboxItem.publicKey,
            })
            .remainingAccounts([
              { pubkey: ONRE_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: client.authorityPda, isSigner: false, isWritable: false },
            ])
            .rpc(),
        'FlowStatusMismatch',
      )
    })

    it('swap_onyc_to_usdc with Claimed flow attempts OnRe CPI', async () => {
      const nttInboxItem = Keypair.generate()
      const [outflightPda, bump] = findOutflightFlowPda(nttInboxItem.publicKey, client.program.programId)

      // Inject a Claimed flow
      setFlowAccount(svm, outflightPda, {
        fogoSender,
        status: FlowStatus.Claimed,
        amount: 500_000n,
        payer: authority.publicKey,
        bump,
      }, client.program.programId)

      // Fund ONyc ATA
      const [authorityPda] = findAuthorityPda(client.program.programId)
      mintTo(svm, authority, onycMint.publicKey, authorityPda, 500_000)

      // CPI will fail at OnRe (no offer fixtures here), but reaching the
      // OnRe program proves the relayer's flow-status, ATA, and signer-PDA
      // checks all passed — the failure is downstream of relayer logic.
      await expectFailure(
        () =>
          client
            .swapOnycToUsdc({
              usdcMint: usdcMint.publicKey,
              onycMint: onycMint.publicKey,
              nttInboxItem: nttInboxItem.publicKey,
            })
            .remainingAccounts([
              { pubkey: ONRE_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: client.authorityPda, isSigner: false, isWritable: false },
            ])
            .rpc(),
        failedInProgram(ONRE_PROGRAM_ID),
        'OnRe CPI should be reached and fail (no offer state seeded)',
      )
    })

    it('send_usdc_to_user rejects flow not in Swapped status', async () => {
      const nttInboxItem = Keypair.generate()
      const [outflightPda, bump] = findOutflightFlowPda(nttInboxItem.publicKey, client.program.programId)

      // Inject a Claimed flow — send_usdc_to_user requires Swapped
      setFlowAccount(svm, outflightPda, {
        fogoSender,
        status: FlowStatus.Claimed,
        amount: 500_000n,
        payer: authority.publicKey,
        bump,
      }, client.program.programId)

      await expectError(
        () =>
          client
            .sendUsdcToUser({
              payer: authority.publicKey,
              usdcMint: usdcMint.publicKey,
              nttInboxItem: nttInboxItem.publicKey,
              rentDestination: authority.publicKey,
            })
            .remainingAccounts([
              { pubkey: GATEWAY_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: client.authorityPda, isSigner: false, isWritable: false },
            ])
            .rpc(),
        'FlowStatusMismatch',
      )
    })

    it('send_usdc_to_user rejects wrong rent destination', async () => {
      const nttInboxItem = Keypair.generate()
      const [outflightPda, bump] = findOutflightFlowPda(nttInboxItem.publicKey, client.program.programId)
      const rando = Keypair.generate()
      svm.airdrop(rando.publicKey, BigInt(1e9))

      // Inject a Swapped flow with payer = authority
      setFlowAccount(svm, outflightPda, {
        fogoSender,
        status: FlowStatus.Swapped,
        amount: 500_000n,
        payer: authority.publicKey,
        bump,
      }, client.program.programId)

      // Pass rando as rent destination — the `address = flow.payer`
      // constraint on `rent_destination` should fail with ConstraintAddress,
      // proving rent can only be returned to the original payer.
      await expectError(
        () =>
          client
            .sendUsdcToUser({
              payer: authority.publicKey,
              usdcMint: usdcMint.publicKey,
              nttInboxItem: nttInboxItem.publicKey,
              rentDestination: rando.publicKey,
            })
            .remainingAccounts([
              { pubkey: GATEWAY_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: client.authorityPda, isSigner: false, isWritable: false },
            ])
            .rpc(),
        'ConstraintAddress',
      )
    })

    it('send_usdc_to_user with Swapped flow advances past relayer-side checks', async () => {
      const nttInboxItem = Keypair.generate()
      const [outflightPda, bump] = findOutflightFlowPda(nttInboxItem.publicKey, client.program.programId)

      // Inject a Swapped flow
      setFlowAccount(svm, outflightPda, {
        fogoSender,
        status: FlowStatus.Swapped,
        amount: 500_000n,
        payer: authority.publicKey,
        bump,
      }, client.program.programId)

      // Fund USDC ATA
      const [authorityPda] = findAuthorityPda(client.program.programId)
      mintTo(svm, authority, usdcMint.publicKey, authorityPda, 500_000)

      // With minimal remaining_accounts the handler will fail at the
      // pre-CPI lookup for the Token Bridge `authority_signer` PDA (the
      // delegate the Approve step needs). Hitting that error proves the
      // status, ATA, and rent-destination checks all passed cleanly. Full
      // outbound CPI coverage lives in `send-usdc-to-user-e2e.test.ts`.
      await expectError(
        () =>
          client
            .sendUsdcToUser({
              payer: authority.publicKey,
              usdcMint: usdcMint.publicKey,
              nttInboxItem: nttInboxItem.publicKey,
              rentDestination: authority.publicKey,
            })
            .remainingAccounts([
              { pubkey: GATEWAY_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: client.authorityPda, isSigner: false, isWritable: false },
            ])
            .rpc(),
        'AuthorityNotInAccounts',
      )
    })
  })
})
