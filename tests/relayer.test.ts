import type { LiteSVM } from 'litesvm'
import {
  findAuthorityPda,
  findConfigPda,
  findInboxRateLimitPda,
  findInflightFlowPda,
  findIntentTransferSetterPda,
  findNttPeerPda,
  findOutflightFlowPda,
  findUserInboxAuthorityPda,
  FOGO_WORMHOLE_CHAIN_ID,
  NTT_ONYC_PROGRAM_ID,
  NTT_USDC_PROGRAM_ID,
  ONRE_PROGRAM_ID,
  RelayerClient,
} from '@fogo-onre/sdk'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Keypair, PublicKey } from '@solana/web3.js'
import {
  createAta,
  createMint,
  createProvider,
  createSvm,
  expectError,
  expectFailure,
  findValidatedTransceiverMessagePda,
  FlowStatus,
  logMatches,
  mintTo,
  setFlowAccount,
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
          withdrawFeeBps: 1_000,
        })
        .rpc()

      const config = await client.fetchConfig()
      expect(config.depositFeeBps).toBe(0)
      expect(config.withdrawFeeBps).toBe(1_000)
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

    it('stages fee raises and leaves live values unchanged', async () => {
      // 50→200 and 100→300 are both raises. Under the asymmetric timelock,
      // raises land on `pending_fee` (with `ready_slot = now + DELAY`) and
      // the live fields stay put until a future `configure` call (after
      // `ready_slot`) auto-promotes them. fee_vault rotation is unchanged.
      await (await client.configure({
        depositFeeBps: 200,
        withdrawFeeBps: 300,
      })).rpc()

      const config = await client.fetchConfig()
      expect(config.depositFeeBps).toBe(50)
      expect(config.withdrawFeeBps).toBe(100)
      expect(config.pendingFee?.depositFeeBps).toBe(200)
      expect(config.pendingFee?.withdrawFeeBps).toBe(300)
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

    it('stages fee raises with feeVault omitted (Optional account = null)', async () => {
      // Snapshot current fee_vault — must remain unchanged after a
      // fee-only update that omits the account entirely.
      const before = await client.fetchConfig()
      const beforeVault = before.feeVault.toBase58()

      // Minimal-args fee-only update — SDK defaults authority to provider
      // wallet, lazy-fetches onycMint from config, and sends `null` for the
      // optional fee_vault account. The on-chain handler skips the rotation;
      // mint + anti-aliasing checks don't run (account itself is absent).
      // Both fee changes are raises (50→200, 100→250), so under the
      // asymmetric timelock they land on `pending_fee`, not the live fields.
      await (await client.configure({
        depositFeeBps: 200,
        withdrawFeeBps: 250,
      })).rpc()

      const after = await client.fetchConfig()
      expect(after.depositFeeBps).toBe(50)
      expect(after.withdrawFeeBps).toBe(100)
      expect(after.pendingFee?.depositFeeBps).toBe(200)
      expect(after.pendingFee?.withdrawFeeBps).toBe(250)
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

      // New authority can drive configure. 11→77 is a raise, so it stages
      // on `pending_fee` rather than landing on the live field.
      await (await newClient.configure({ depositFeeBps: 77 })).rpc()
      const afterRaise = await newClient.fetchConfig()
      expect(afterRaise.depositFeeBps).toBe(11)
      expect(afterRaise.pendingFee?.depositFeeBps).toBe(77)
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
  // full admin flow: initialize → configure
  // ---------------------------------------------------------------------------

  describe('full admin flow', () => {
    it('initialize → configure', async () => {
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
      // Fee raises stage; live values remain at the initialize-time defaults.
      expect(config2.depositFeeBps).toBe(50)
      expect(config2.withdrawFeeBps).toBe(100)
      expect(config2.pendingFee?.depositFeeBps).toBe(150)
      expect(config2.pendingFee?.withdrawFeeBps).toBe(250)
      // fee_vault rotation is independent of the fee timelock — applies now.
      expect(config2.feeVault.toBase58()).toBe(newFeeVault.toBase58())
    })
  })

  // ---------------------------------------------------------------------------
  // deposit flow (claim_usdc → swap_usdc_to_onyc → lock_onyc)
  // ---------------------------------------------------------------------------

  describe('deposit flow', () => {
    // Pinned by the relayer's claim_usdc — the VAA's NTT sender must be
    // intent_transfer's singleton setter PDA. Other deposit-flow tests
    // here exercise paths AFTER claim_usdc (swap/lock); they only need
    // a valid `fogo_sender` field on the injected Flow account, not on
    // the VAA itself.
    const fogoSender = findIntentTransferSetterPda()[0].toBytes()

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

    // Reused across the NTT-shape claim_usdc failure tests below — `sender`
    // is the only field the handler reads; everything else is arbitrary.
    function makeTransceiverMessage(senderBytes: Uint8Array, messageId: Uint8Array) {
      return {
        fromChain: FOGO_WORMHOLE_CHAIN_ID,
        sourceNttManager: new Uint8Array(32).fill(0x22),
        recipientNttManager: NTT_USDC_PROGRAM_ID.toBytes(),
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

    // Drives claim_usdc only far enough to hit the setter-allowlist check
    // (handler's first guard, before any NTT CPI). Used by the
    // non-allowlisted-sender rejection tests below.
    async function claimUsdcWithSender(senderBytes: Uint8Array) {
      const nttInboxItem = Keypair.generate()
      const userWallet = Keypair.generate()
      const [userInboxAuthority] = findUserInboxAuthorityPda(userWallet.publicKey, client.program.programId)
      createAta(svm, authority, usdcMint.publicKey, userInboxAuthority)
      createAta(svm, authority, usdcMint.publicKey, client.authorityPda)

      const messageId = new Uint8Array(32)
      crypto.getRandomValues(messageId)
      const [validatedMsgPda] = findValidatedTransceiverMessagePda(
        FOGO_WORMHOLE_CHAIN_ID,
        messageId,
        NTT_USDC_PROGRAM_ID,
      )
      setValidatedTransceiverMessage(
        svm,
        validatedMsgPda,
        NTT_USDC_PROGRAM_ID,
        makeTransceiverMessage(senderBytes, messageId),
      )

      return client
        .claimUsdc({
          payer: authority.publicKey,
          userWallet: userWallet.publicKey,
          usdcMint: usdcMint.publicKey,
          nttInboxItem: nttInboxItem.publicKey,
          nttTransceiverMessage: validatedMsgPda,
          redeemAccountsLen: 1,
        })
        .remainingAccounts([
          { pubkey: NTT_USDC_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: client.authorityPda, isSigner: false, isWritable: false },
        ])
        .rpc()
    }

    it('claim_usdc rejects a non-allowlisted sender', async () => {
      const stranger = Keypair.generate().publicKey
      await expectError(() => claimUsdcWithSender(stranger.toBytes()), 'UnexpectedFogoSender')
    })

    it('claim_usdc rejects a direct NTT bridge (sender = user session authority)', async () => {
      // A plain NTT transfer (no intent_transfer) surfaces the user's own
      // session authority as the VAA sender — not a setter PDA. Must be
      // rejected so only fee-bearing intent bridges can deposit here.
      const userSessionAuthority = Keypair.generate().publicKey
      await expectError(() => claimUsdcWithSender(userSessionAuthority.toBytes()), 'UnexpectedFogoSender')
    })

    it('claim_usdc rejects replay when inflight Flow PDA already exists', async () => {
      const nttInboxItem = Keypair.generate()
      const userWallet = Keypair.generate()

      // Inject a Flow PDA at the expected inflight address to simulate a
      // prior claim_usdc having already created it.
      const [inflightPda, bump] = findInflightFlowPda(nttInboxItem.publicKey, client.program.programId)
      setFlowAccount(svm, inflightPda, {
        fogoSender,
        status: FlowStatus.Claimed,
        amount: 500_000n,
        payer: authority.publicKey,
        bump,
      }, client.program.programId)

      // Pre-create the per-user inbox ATA so Anchor's account
      // deserialization passes; the `inflight_flow` init constraint must
      // be the first thing to fail.
      const [userInboxAuthority] = findUserInboxAuthorityPda(userWallet.publicKey, client.program.programId)
      createAta(svm, authority, usdcMint.publicKey, userInboxAuthority)
      // Sweep destination must also exist for the same reason.
      createAta(svm, authority, usdcMint.publicKey, client.authorityPda)

      const messageId = new Uint8Array(32)
      crypto.getRandomValues(messageId)
      const [validatedMsgPda] = findValidatedTransceiverMessagePda(
        FOGO_WORMHOLE_CHAIN_ID,
        messageId,
        NTT_USDC_PROGRAM_ID,
      )
      setValidatedTransceiverMessage(
        svm,
        validatedMsgPda,
        NTT_USDC_PROGRAM_ID,
        makeTransceiverMessage(fogoSender, messageId),
      )

      // Anchor `init` on a PDA with pre-existing lamports → system program
      // returns "already in use" (custom error 0x0). Matching the log line
      // proves the init guard fired and no other validation gave up first.
      await expectFailure(
        () =>
          client
            .claimUsdc({
              payer: authority.publicKey,
              userWallet: userWallet.publicKey,
              usdcMint: usdcMint.publicKey,
              nttInboxItem: nttInboxItem.publicKey,
              nttTransceiverMessage: validatedMsgPda,
              redeemAccountsLen: 1,
            })
            .remainingAccounts([
              { pubkey: NTT_USDC_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: client.authorityPda, isSigner: false, isWritable: false },
            ])
            .rpc(),
        logMatches(/already in use/i),
        'inflight Flow init constraint should fire (account already exists)',
      )
    })

    it('claim_usdc rejects forged system-owned inbox_item on the released-skip path', async () => {
      // Forgery attack vector: a malicious cranker bypasses the FOGO
      // intent_transfer fee path by self-funding their own inbox ATA
      // and crafting a 75-byte system-program-owned account with the
      // real InboxItem discriminator + Released release_status.
      // Without the conditional owner check in claim_usdc's skip
      // branch, the relayer would sweep that USDC into custody and
      // mint phantom-attributed credit. With the check, this MUST
      // fail with InvalidInboxItem before any balance moves.
      const attackerWallet = Keypair.generate()
      const fakeInboxItem = Keypair.generate()
      const [attackerInbox] = findUserInboxAuthorityPda(
        attackerWallet.publicKey,
        client.program.programId,
      )
      const attackerInboxAta = createAta(svm, authority, usdcMint.publicKey, attackerInbox)
      // Self-funded "deposit" — without the owner guard, this would be
      // swept into relayer custody as phantom intent-bypass credit.
      mintTo(svm, authority, usdcMint.publicKey, attackerInboxAta, 1_000_000)
      createAta(svm, authority, usdcMint.publicKey, client.authorityPda)

      // Hand-roll a 75-byte InboxItem-shaped payload owned by the
      // system program (the attacker's only writeable target). disc +
      // init + bump + amount(u64 LE @10) + recipient(@18) +
      // bitmap(@50) + release_status_tag(@66 = 2 = Released).
      const INBOX_ITEM_DISC = Buffer.from([0xED, 0x8D, 0xCC, 0x67, 0xBB, 0x7A, 0x39, 0x5C])
      const payload = Buffer.alloc(75)
      INBOX_ITEM_DISC.copy(payload, 0)
      payload[8] = 1 // init
      payload[9] = 255 // bump (arbitrary)
      payload.writeBigUInt64LE(1_000_000n, 10) // amount
      attackerInbox.toBuffer().copy(payload, 18) // recipient_address
      // bitmap at 50..66 left as zeros
      payload[66] = 2 // release_status = Released
      // bytes 67..75 (ReleaseAfterDelay payload slot) left as zeros
      svm.setAccount(fakeInboxItem.publicKey, {
        executable: false,
        owner: PublicKey.default, // system program
        lamports: 1_500_000,
        data: payload,
        rentEpoch: 0,
      })

      const messageId = new Uint8Array(32)
      crypto.getRandomValues(messageId)
      const [validatedMsgPda] = findValidatedTransceiverMessagePda(
        FOGO_WORMHOLE_CHAIN_ID,
        messageId,
        NTT_USDC_PROGRAM_ID,
      )
      setValidatedTransceiverMessage(
        svm,
        validatedMsgPda,
        NTT_USDC_PROGRAM_ID,
        makeTransceiverMessage(fogoSender, messageId),
      )

      await expectError(
        () =>
          client
            .claimUsdc({
              payer: authority.publicKey,
              userWallet: attackerWallet.publicKey,
              usdcMint: usdcMint.publicKey,
              nttInboxItem: fakeInboxItem.publicKey,
              nttTransceiverMessage: validatedMsgPda,
              redeemAccountsLen: 1,
            })
            .remainingAccounts([
              { pubkey: NTT_USDC_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: client.authorityPda, isSigner: false, isWritable: false },
            ])
            .rpc(),
        'InvalidInboxItem',
      )
    })

    it('claim_usdc rejects released-skip with valid setter VTM but unrelated InboxItem', async () => {
      // Bypass attack vector caught in the deploy-readiness review:
      //
      //   1. Attacker bridges USDC.s from FOGO via NTT *directly*
      //      (not through intent_transfer), targeting their own per-user
      //      inbox PDA on Solana. Funds land in attacker_inbox_ata.
      //      This skips intent_transfer's fee path.
      //   2. Attacker borrows ANY real intent_transfer-originated VTM
      //      (e.g. someone else's prior legitimate deposit) — its
      //      `sender == intent_transfer_setter` check passes.
      //   3. Attacker calls claim_usdc with their attacker-controlled
      //      InboxItem + the borrowed VTM.
      //
      // The cryptographic link between VTM and InboxItem (NTT's own
      // `inbox_item` PDA seed = keccak256(from_chain_BE || msg_wire))
      // is bypassed on the released-skip path because the redeem CPI
      // is skipped. Without an explicit re-derivation in the handler,
      // the sender check passes (borrowed real VTM), the recipient
      // check passes (attacker InboxItem really does target their PDA),
      // and the sweep happens — minting ONyc on FOGO without paying
      // intent_transfer fees.
      //
      // The fix re-derives the InboxItem PDA from the supplied VTM and
      // requires equality with the supplied InboxItem account. This
      // test injects a valid Released NTT-owned InboxItem at an
      // *unrelated* keypair address and a valid setter VTM, then
      // expects InboxItemMismatch.
      const attackerWallet = Keypair.generate()
      const unrelatedInboxItem = Keypair.generate()
      const [attackerInbox] = findUserInboxAuthorityPda(
        attackerWallet.publicKey,
        client.program.programId,
      )
      const attackerInboxAta = createAta(svm, authority, usdcMint.publicKey, attackerInbox)
      mintTo(svm, authority, usdcMint.publicKey, attackerInboxAta, 1_000_000)
      createAta(svm, authority, usdcMint.publicKey, client.authorityPda)

      // NTT-owned (passes the skip-path owner guard) Released InboxItem,
      // recipient = attacker's per-user inbox PDA. Same 75-byte layout
      // the prior forgery test uses — the only difference here is the
      // owner is the real NTT manager program, so the owner check on
      // its own can't catch this.
      const INBOX_ITEM_DISC = Buffer.from([0xED, 0x8D, 0xCC, 0x67, 0xBB, 0x7A, 0x39, 0x5C])
      const payload = Buffer.alloc(75)
      INBOX_ITEM_DISC.copy(payload, 0)
      payload[8] = 1
      payload[9] = 255
      payload.writeBigUInt64LE(1_000_000n, 10)
      attackerInbox.toBuffer().copy(payload, 18)
      payload[66] = 2 // Released
      svm.setAccount(unrelatedInboxItem.publicKey, {
        executable: false,
        owner: NTT_USDC_PROGRAM_ID,
        lamports: 1_500_000,
        data: payload,
        rentEpoch: 0,
      })

      // Borrowed real intent_transfer-originated VTM. `sender` =
      // intent_transfer_setter PDA, so the existing UnexpectedFogoSender
      // check passes. The VTM's contents hash to *some* InboxItem PDA,
      // but NOT to `unrelatedInboxItem.publicKey` (a fresh keypair).
      const messageId = new Uint8Array(32)
      crypto.getRandomValues(messageId)
      const [validatedMsgPda] = findValidatedTransceiverMessagePda(
        FOGO_WORMHOLE_CHAIN_ID,
        messageId,
        NTT_USDC_PROGRAM_ID,
      )
      setValidatedTransceiverMessage(
        svm,
        validatedMsgPda,
        NTT_USDC_PROGRAM_ID,
        makeTransceiverMessage(fogoSender, messageId),
      )

      await expectError(
        () =>
          client
            .claimUsdc({
              payer: authority.publicKey,
              userWallet: attackerWallet.publicKey,
              usdcMint: usdcMint.publicKey,
              nttInboxItem: unrelatedInboxItem.publicKey,
              nttTransceiverMessage: validatedMsgPda,
              redeemAccountsLen: 1,
            })
            .remainingAccounts([
              { pubkey: NTT_USDC_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: client.authorityPda, isSigner: false, isWritable: false },
            ])
            .rpc(),
        'InboxItemMismatch',
      )
    })

    it('swap_usdc_to_onyc rejects flow not in Claimed status', async () => {
      const nttInboxItem = Keypair.generate()
      const [inflightPda, bump] = findInflightFlowPda(nttInboxItem.publicKey, client.program.programId)

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
              feeVault,
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

    it('swap_usdc_to_onyc rejects an offer account not owned by OnRe', async () => {
      const nttInboxItem = Keypair.generate()
      const [inflightPda, bump] = findInflightFlowPda(nttInboxItem.publicKey, client.program.programId)

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

      // OnRe is stubbed only by program ID — the derived deposit Offer PDA
      // doesn't exist, so its owner is the system program. The NAV-floor
      // offer pin must reject it before any CPI is attempted.
      await expectError(
        () =>
          client
            .swapUsdcToOnyc({
              usdcMint: usdcMint.publicKey,
              onycMint: onycMint.publicKey,
              feeVault,
              nttInboxItem: nttInboxItem.publicKey,
            })
            .remainingAccounts([
              { pubkey: ONRE_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: client.authorityPda, isSigner: false, isWritable: false },
            ])
            .rpc(),
        'OnreOfferOwnerMismatch',
      )
    })

    it('lock_onyc rejects flow not in Swapped status', async () => {
      const nttInboxItem = Keypair.generate()
      const [inflightPda, bump] = findInflightFlowPda(nttInboxItem.publicKey, client.program.programId)

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
              nttInboxItem: nttInboxItem.publicKey,
              rentDestination: authority.publicKey,
            })
            .remainingAccounts([
              { pubkey: NTT_ONYC_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: client.authorityPda, isSigner: false, isWritable: false },
            ])
            .rpc(),
        'FlowStatusMismatch',
      )
    })

    it('lock_onyc rejects wrong rent destination', async () => {
      const nttInboxItem = Keypair.generate()
      const [inflightPda, bump] = findInflightFlowPda(nttInboxItem.publicKey, client.program.programId)
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
      // doesn't equal the stored payer.
      await expectError(
        () =>
          client
            .lockOnyc({
              payer: authority.publicKey,
              onycMint: onycMint.publicKey,
              nttInboxItem: nttInboxItem.publicKey,
              rentDestination: rando.publicKey,
            })
            .remainingAccounts([
              { pubkey: NTT_ONYC_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: client.authorityPda, isSigner: false, isWritable: false },
            ])
            .rpc(),
        'ConstraintAddress',
      )
    })

    it('lock_onyc rejects Swapped flow without session authority PDA', async () => {
      const nttInboxItem = Keypair.generate()
      const [inflightPda, bump] = findInflightFlowPda(nttInboxItem.publicKey, client.program.programId)

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
      // fire before any NTT CPI runs.
      await expectError(
        () =>
          client
            .lockOnyc({
              payer: authority.publicKey,
              onycMint: onycMint.publicKey,
              nttInboxItem: nttInboxItem.publicKey,
              rentDestination: authority.publicKey,
            })
            .remainingAccounts([
              { pubkey: NTT_ONYC_PROGRAM_ID, isSigner: false, isWritable: false },
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
    // A real {OnRe, Fogo} setter PDA — passes the unlock_onyc allowlist
    // pin so VTM-driven negatives can reach their intended check.
    const setterSender = findIntentTransferSetterPda()[0].toBytes()

    // Per-user inbox the release lands in. unlock_onyc resolves the ATA as
    // an InterfaceAccount before the handler runs, so it must exist even
    // for negatives that revert in the handler body.
    function setupUserInbox(): { userWallet: PublicKey, userInboxAta: PublicKey } {
      const userWallet = Keypair.generate().publicKey
      const [userInboxAuthority] = findUserInboxAuthorityPda(userWallet, client.program.programId)
      const userInboxAta = createAta(svm, authority, onycMint.publicKey, userInboxAuthority)
      return { userWallet, userInboxAta }
    }

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
        recipientNttManager: NTT_ONYC_PROGRAM_ID.toBytes(),
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
      const { userWallet } = setupUserInbox()
      const messageId = new Uint8Array(32)
      crypto.getRandomValues(messageId)
      const [validatedMsgPda] = findValidatedTransceiverMessagePda(
        FOGO_WORMHOLE_CHAIN_ID,
        messageId,
        NTT_ONYC_PROGRAM_ID,
      )
      setValidatedTransceiverMessage(
        svm,
        validatedMsgPda,
        NTT_ONYC_PROGRAM_ID,
        makeTransceiverMessage(new Uint8Array(32), messageId),
      )

      // `parse_fogo_sender_from_vtm` rejects the all-zero sender before the
      // setter-allowlist pin, so a zero VTM sender surfaces ZeroFogoSender
      // (not UnexpectedFogoSender).
      await expectError(
        () =>
          client
            .unlockOnyc({
              payer: authority.publicKey,
              userWallet,
              onycMint: onycMint.publicKey,
              nttInboxItem: nttInboxItem.publicKey,
              nttTransceiverMessage: validatedMsgPda,
              redeemAccountsLen: 1,
            })
            .remainingAccounts([
              { pubkey: NTT_ONYC_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: client.authorityPda, isSigner: false, isWritable: false },
            ])
            .rpc(),
        'ZeroFogoSender',
      )
    })

    it('unlock_onyc rejects invalid account split (redeem_accounts_len=0)', async () => {
      const nttInboxItem = Keypair.generate()
      const { userWallet } = setupUserInbox()
      const messageId = new Uint8Array(32)
      crypto.getRandomValues(messageId)
      const [validatedMsgPda] = findValidatedTransceiverMessagePda(
        FOGO_WORMHOLE_CHAIN_ID,
        messageId,
        NTT_ONYC_PROGRAM_ID,
      )
      setValidatedTransceiverMessage(
        svm,
        validatedMsgPda,
        NTT_ONYC_PROGRAM_ID,
        makeTransceiverMessage(setterSender, messageId),
      )

      // Handler validates redeem_accounts_len > 0 before splitting
      // remaining_accounts; passing 0 must surface the Anchor code, not
      // an opaque slice panic.
      await expectError(
        () =>
          client
            .unlockOnyc({
              payer: authority.publicKey,
              userWallet,
              onycMint: onycMint.publicKey,
              nttInboxItem: nttInboxItem.publicKey,
              nttTransceiverMessage: validatedMsgPda,
              redeemAccountsLen: 0,
            })
            .remainingAccounts([
              { pubkey: NTT_ONYC_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: client.authorityPda, isSigner: false, isWritable: false },
            ])
            .rpc(),
        'InvalidAccountSplit',
      )
    })

    it('unlock_onyc rejects double unlock (same ntt_inbox_item)', async () => {
      const nttInboxItem = Keypair.generate()
      const { userWallet } = setupUserInbox()
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
        NTT_ONYC_PROGRAM_ID,
      )
      setValidatedTransceiverMessage(
        svm,
        validatedMsgPda,
        NTT_ONYC_PROGRAM_ID,
        makeTransceiverMessage(setterSender, messageId),
      )

      // init constraint on outflight_flow should fail (account already exists).
      // The system program emits "already in use" when an init account
      // collides with a pre-existing one — proves replay protection holds.
      await expectFailure(
        () =>
          client
            .unlockOnyc({
              payer: authority.publicKey,
              userWallet,
              onycMint: onycMint.publicKey,
              nttInboxItem: nttInboxItem.publicKey,
              nttTransceiverMessage: validatedMsgPda,
              redeemAccountsLen: 1,
            })
            .remainingAccounts([
              { pubkey: NTT_ONYC_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: client.authorityPda, isSigner: false, isWritable: false },
            ])
            .rpc(),
        logMatches(/already in use/i),
        'outflight Flow init constraint should fire on replay',
      )
    })

    // Position-binding negatives for unlock_onyc. NTT consumes its account
    // lists positionally — `redeem` reads slot 3 (transceiver_message) and
    // slot 6 (inbox_item); `release_inbound_unlock` reads slot 2 (inbox_item)
    // and slot 3 (recipient_ata). The handler pins all four slots against
    // the named accounts (unlock_onyc.rs:81-97). Each test below corrupts
    // exactly ONE slot and arranges the other three so the under-test
    // require! is the FIRST one to fire.
    function buildUnlockRemainingAccounts(slots: {
      redeem3: PublicKey
      redeem6: PublicKey
      release2: PublicKey
      release3: PublicKey
    }) {
      const PAD = { pubkey: PublicKey.default, isSigner: false, isWritable: false }
      const ra = Array.from({ length: 18 }, () => ({ ...PAD }))
      // Pin slots 2 (peer) and 7 (inbox rate-limit) to the FOGO-derived PDAs
      // so the WrongOriginChain checks pass and execution reaches the
      // mismatch the individual test wants to fire.
      const [peerPda] = findNttPeerPda(FOGO_WORMHOLE_CHAIN_ID, NTT_ONYC_PROGRAM_ID)
      const [inboxRlPda] = findInboxRateLimitPda(FOGO_WORMHOLE_CHAIN_ID, NTT_ONYC_PROGRAM_ID)
      ra[2] = { pubkey: peerPda, isSigner: false, isWritable: false }
      ra[7] = { pubkey: inboxRlPda, isSigner: false, isWritable: false }
      ra[3] = { pubkey: slots.redeem3, isSigner: false, isWritable: false }
      ra[6] = { pubkey: slots.redeem6, isSigner: false, isWritable: false }
      ra[10 + 2] = { pubkey: slots.release2, isSigner: false, isWritable: false }
      ra[10 + 3] = { pubkey: slots.release3, isSigner: false, isWritable: false }
      return ra
    }

    it('unlock_onyc rejects TransceiverMessageMismatch when redeem[3] differs from named ntt_transceiver_message', async () => {
      const nttInboxItem = Keypair.generate()
      const { userWallet } = setupUserInbox()
      const messageId = new Uint8Array(32)
      crypto.getRandomValues(messageId)
      const [validatedMsgPda] = findValidatedTransceiverMessagePda(
        FOGO_WORMHOLE_CHAIN_ID,
        messageId,
        NTT_ONYC_PROGRAM_ID,
      )
      setValidatedTransceiverMessage(
        svm,
        validatedMsgPda,
        NTT_ONYC_PROGRAM_ID,
        makeTransceiverMessage(setterSender, messageId),
      )

      const [authorityPda] = findAuthorityPda(client.program.programId)
      const onycAta = getAssociatedTokenAddressSync(onycMint.publicKey, authorityPda, true)
      const wrongMsg = Keypair.generate().publicKey

      await expectError(
        () =>
          client
            .unlockOnyc({
              payer: authority.publicKey,
              userWallet,
              onycMint: onycMint.publicKey,
              nttInboxItem: nttInboxItem.publicKey,
              nttTransceiverMessage: validatedMsgPda,
              redeemAccountsLen: 10,
            })
            .remainingAccounts(buildUnlockRemainingAccounts({
              redeem3: wrongMsg, // mismatched — should fire FIRST require!
              redeem6: nttInboxItem.publicKey,
              release2: nttInboxItem.publicKey,
              release3: onycAta,
            }))
            .rpc(),
        'TransceiverMessageMismatch',
      )
    })

    it('unlock_onyc rejects InboxItemMismatch when redeem[6] differs from named ntt_inbox_item', async () => {
      const nttInboxItem = Keypair.generate()
      const { userWallet } = setupUserInbox()
      const messageId = new Uint8Array(32)
      crypto.getRandomValues(messageId)
      const [validatedMsgPda] = findValidatedTransceiverMessagePda(
        FOGO_WORMHOLE_CHAIN_ID,
        messageId,
        NTT_ONYC_PROGRAM_ID,
      )
      setValidatedTransceiverMessage(
        svm,
        validatedMsgPda,
        NTT_ONYC_PROGRAM_ID,
        makeTransceiverMessage(setterSender, messageId),
      )

      const [authorityPda] = findAuthorityPda(client.program.programId)
      const onycAta = getAssociatedTokenAddressSync(onycMint.publicKey, authorityPda, true)
      const wrongInbox = Keypair.generate().publicKey

      await expectError(
        () =>
          client
            .unlockOnyc({
              payer: authority.publicKey,
              userWallet,
              onycMint: onycMint.publicKey,
              nttInboxItem: nttInboxItem.publicKey,
              nttTransceiverMessage: validatedMsgPda,
              redeemAccountsLen: 10,
            })
            .remainingAccounts(buildUnlockRemainingAccounts({
              redeem3: validatedMsgPda, // passes check 1
              redeem6: wrongInbox, // mismatched — fires check 2
              release2: nttInboxItem.publicKey,
              release3: onycAta,
            }))
            .rpc(),
        'InboxItemMismatch',
      )
    })

    it('unlock_onyc rejects RecipientAtaMismatch when release[3] differs from named user_inbox_ata', async () => {
      const nttInboxItem = Keypair.generate()
      const { userWallet } = setupUserInbox()
      const messageId = new Uint8Array(32)
      crypto.getRandomValues(messageId)
      const [validatedMsgPda] = findValidatedTransceiverMessagePda(
        FOGO_WORMHOLE_CHAIN_ID,
        messageId,
        NTT_ONYC_PROGRAM_ID,
      )
      setValidatedTransceiverMessage(
        svm,
        validatedMsgPda,
        NTT_ONYC_PROGRAM_ID,
        makeTransceiverMessage(setterSender, messageId),
      )

      // The recipient ATA position-bind protects against an attacker
      // redirecting the NTT release to an attacker-owned ATA while the
      // relayer's named `user_inbox_ata` (which the sweep reads) reports a
      // stale balance.
      const wrongAta = Keypair.generate().publicKey

      await expectError(
        () =>
          client
            .unlockOnyc({
              payer: authority.publicKey,
              userWallet,
              onycMint: onycMint.publicKey,
              nttInboxItem: nttInboxItem.publicKey,
              nttTransceiverMessage: validatedMsgPda,
              redeemAccountsLen: 10,
            })
            .remainingAccounts(buildUnlockRemainingAccounts({
              redeem3: validatedMsgPda,
              redeem6: nttInboxItem.publicKey,
              release2: nttInboxItem.publicKey,
              release3: wrongAta, // mismatched — fires check 4
            }))
            .rpc(),
        'RecipientAtaMismatch',
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
              { pubkey: NTT_USDC_PROGRAM_ID, isSigner: false, isWritable: false },
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
              { pubkey: NTT_USDC_PROGRAM_ID, isSigner: false, isWritable: false },
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
              { pubkey: NTT_USDC_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: client.authorityPda, isSigner: false, isWritable: false },
            ])
            .rpc(),
        'MissingSessionAuthority',
      )
    })
  })
})
