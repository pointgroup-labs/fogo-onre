import type { LiteSVM } from 'litesvm'
import {
  findAuthorityPda,
  findConfigPda,
  findInboxRateLimitPda,
  findInflightFlowPda,
  findIntentTransferSetterPda,
  findNttPeerPda,
  findOutflightFlowPda,
  findUserInboxWithMinPda,
  FOGO_WORMHOLE_CHAIN_ID,
  NTT_ONYC_PROGRAM_ID,
  NTT_USDC_PROGRAM_ID,
  ONRE_PROGRAM_ID,
  RelayerClient,
} from '@fogo-onre/sdk'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js'
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

// User-signed swap floor used across receive/swap tests. Committed into the
// min-bearing inbox PDA the handler re-derives.
const RECEIVE_MIN = 1_000n

describe('relayer', () => {
  let svm: LiteSVM
  let authority: Keypair
  let client: RelayerClient
  let baseMint: Keypair
  let assetMint: Keypair
  // External ONyc fee vault — any pre-existing ONyc account that is NOT
  // the relayer's operating ONyc ATA. Tests use an authority-owned ATA.
  let feeVault: PublicKey

  beforeEach(async () => {
    svm = createSvm()
    authority = Keypair.generate()
    const provider = createProvider(svm, authority)
    baseMint = createMint(svm, authority, 6)
    assetMint = createMint(svm, authority, 6)
    client = new RelayerClient(provider as any, { baseMint: baseMint.publicKey, assetMint: assetMint.publicKey })
    feeVault = createAta(svm, authority, assetMint.publicKey, authority.publicKey)
    await client.bootstrap().rpc()
  })

  describe('initialize', () => {
    it('creates config PDA and stores parameters', async () => {
      await client
        .initialize({
          authority: authority.publicKey,
          baseMint: baseMint.publicKey,
          assetMint: assetMint.publicKey,
          feeVault,
          depositFeeBps: 50,
          withdrawFeeBps: 100,
        })
        .rpc()

      const config = await client.fetchConfig()
      expect(config.authority.toBase58()).toBe(authority.publicKey.toBase58())
      expect(config.baseMint.toBase58()).toBe(baseMint.publicKey.toBase58())
      expect(config.assetMint.toBase58()).toBe(assetMint.publicKey.toBase58())
      expect(config.depositFeeBps).toBe(50)
      expect(config.withdrawFeeBps).toBe(100)
    })

    it('rejects fee bps above 10000', async () => {
      // Assert the specific `FeeBpsTooHigh` error, proving we hit the bps
      // validator rather than an unrelated upstream constraint.
      await expectError(
        () =>
          client
            .initialize({
              authority: authority.publicKey,
              baseMint: baseMint.publicKey,
              assetMint: assetMint.publicKey,
              feeVault,
              depositFeeBps: 10_001,
              withdrawFeeBps: 0,
            })
            .rpc(),
        'FeeBpsTooHigh',
      )
    })

    it('rejects double initialization', async () => {
      // First init uses distinctive fees (25/75) so a later read proves the
      // second call never overwrote config.
      await client
        .initialize({
          authority: authority.publicKey,
          baseMint: baseMint.publicKey,
          assetMint: assetMint.publicKey,
          feeVault,
          depositFeeBps: 25,
          withdrawFeeBps: 75,
        })
        .rpc()

      let caught: any
      try {
        await client
          .initialize({
            authority: authority.publicKey,
            baseMint: baseMint.publicKey,
            assetMint: assetMint.publicKey,
            feeVault,
            depositFeeBps: 999,
            withdrawFeeBps: 888,
          })
          .rpc()
      } catch (e) {
        caught = e
      }
      expect(caught).toBeDefined()

      // Anchor `init` on the existing Config PDA makes the system program
      // emit `Allocate ... already in use` + custom error 0x0. Pinning the
      // exact PDA address rules out an unrelated account collision.
      const logs: string[] = Array.isArray(caught.logs) ? caught.logs : []
      const [configPda] = findConfigPda(baseMint.publicKey, assetMint.publicKey, client.program.programId)
      const allocateRegex = new RegExp(
        `Allocate: account Address \\{ address: ${configPda.toBase58()}[^}]*\\} already in use`,
      )
      const sysProgramFailRegex = /Program 11111111111111111111111111111111 failed: custom program error: 0x0/

      expect(logs.some(l => allocateRegex.test(l))).toBe(true)
      expect(logs.some(l => sysProgramFailRegex.test(l))).toBe(true)

      // Original config must be intact — no field mutated before the constraint fired.
      const config = await client.fetchConfig()
      expect(config.depositFeeBps).toBe(25)
      expect(config.withdrawFeeBps).toBe(75)
    })

    it('allows zero and max valid fees', async () => {
      await client
        .initialize({
          authority: authority.publicKey,
          baseMint: baseMint.publicKey,
          assetMint: assetMint.publicKey,
          feeVault,
          depositFeeBps: 0,
          withdrawFeeBps: 1_000,
        })
        .rpc()

      const config = await client.fetchConfig()
      expect(config.depositFeeBps).toBe(0)
      expect(config.withdrawFeeBps).toBe(1_000)
    })

    it('pins the NTT manager program IDs as init-only safety fields', async () => {
      // Defaults to the canonical USDC/ONyc managers; these are set once at
      // init and `configure` has no path to change them.
      await client
        .initialize({
          authority: authority.publicKey,
          baseMint: baseMint.publicKey,
          assetMint: assetMint.publicKey,
          feeVault,
          depositFeeBps: 50,
          withdrawFeeBps: 100,
        })
        .rpc()

      const cfg = await client.fetchConfig()
      expect(cfg.nttBaseProgram.toBase58()).toBe(NTT_USDC_PROGRAM_ID.toBase58())
      expect(cfg.nttAssetProgram.toBase58()).toBe(NTT_ONYC_PROGRAM_ID.toBase58())
    })
  })

  describe('configure', () => {
    beforeEach(async () => {
      await client
        .initialize({
          authority: authority.publicKey,
          baseMint: baseMint.publicKey,
          assetMint: assetMint.publicKey,
          feeVault,
          depositFeeBps: 50,
          withdrawFeeBps: 100,
        })
        .rpc()
    })

    it('stages fee raises and leaves live values unchanged', async () => {
      // Both are raises: under the asymmetric timelock they land on
      // `pending_fee` while live fields stay put until a later promotion.
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
      // wallet, assetMint is lazily fetched from config. This is a true no-op.
      await (await client.configure({})).rpc()

      const config = await client.fetchConfig()
      expect(config.depositFeeBps).toBe(50)
      expect(config.withdrawFeeBps).toBe(100)
    })

    it('rotates fee_vault to a new external account', async () => {
      const newOwner = Keypair.generate()
      const newFeeVault = createAta(svm, authority, assetMint.publicKey, newOwner.publicKey)

      await (await client.configure({ feeVault: newFeeVault })).rpc()

      const config = await client.fetchConfig()
      expect(config.feeVault.toBase58()).toBe(newFeeVault.toBase58())
    })

    it('stages fee raises with feeVault omitted (Optional account = null)', async () => {
      const before = await client.fetchConfig()
      const beforeVault = before.feeVault.toBase58()

      // Fee-only update sends `null` for the optional fee_vault, so the
      // handler skips rotation. Both raises stage on `pending_fee`.
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
      const aliasedVault = getAssociatedTokenAddressSync(assetMint.publicKey, authorityPda, true)

      await expectError(
        async () => (await client.configure({ feeVault: aliasedVault })).rpc(),
        'FeeVaultAliasesUserAta',
      )
    })

    it('rejects non-authority signer', async () => {
      const rando = Keypair.generate()
      const randoProvider = createProvider(svm, rando)
      const randoClient = new RelayerClient(randoProvider as any, { baseMint: baseMint.publicKey, assetMint: assetMint.publicKey })

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
      const newClient = new RelayerClient(newProvider as any, { baseMint: baseMint.publicKey, assetMint: assetMint.publicKey })
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
      const firstClient = new RelayerClient(firstProvider as any, { baseMint: baseMint.publicKey, assetMint: assetMint.publicKey })
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
      const proposalClient = new RelayerClient(proposalProvider as any, { baseMint: baseMint.publicKey, assetMint: assetMint.publicKey })
      await expectError(
        async () => (await proposalClient.acceptAuthority()).rpc(),
        'NoPendingAuthority',
      )
    })

    it('accept_authority fails when no proposal is in flight', async () => {
      const random = Keypair.generate()
      const randomProvider = createProvider(svm, random)
      const randomClient = new RelayerClient(randomProvider as any, { baseMint: baseMint.publicKey, assetMint: assetMint.publicKey })
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
      const wrongClient = new RelayerClient(wrongProvider as any, { baseMint: baseMint.publicKey, assetMint: assetMint.publicKey })
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
      const randoClient = new RelayerClient(randoProvider as any, { baseMint: baseMint.publicKey, assetMint: assetMint.publicKey })
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

  describe('full admin flow', () => {
    it('initialize → configure', async () => {
      // 1. Initialize with default fees + external fee vault
      await client
        .initialize({
          authority: authority.publicKey,
          baseMint: baseMint.publicKey,
          assetMint: assetMint.publicKey,
          feeVault,
          depositFeeBps: 50,
          withdrawFeeBps: 100,
        })
        .rpc()

      const config1 = await client.fetchConfig()
      expect(config1.depositFeeBps).toBe(50)

      // 2. Reconfigure: update fees + rotate fee vault
      const newOwner = Keypair.generate()
      const newFeeVault = createAta(svm, authority, assetMint.publicKey, newOwner.publicKey)

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
          baseMint: baseMint.publicKey,
          assetMint: assetMint.publicKey,
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

    // Drives receive (deposit) only far enough to hit the setter-allowlist
    // check (handler's first guard, before any NTT CPI). Used by the
    // non-allowlisted-sender rejection tests below.
    async function receiveDepositWithSender(senderBytes: Uint8Array) {
      const nttInboxItem = Keypair.generate()
      const userWallet = Keypair.generate()
      const [userInboxAuthority] = findUserInboxWithMinPda(userWallet.publicKey, RECEIVE_MIN, client.program.programId)
      createAta(svm, authority, baseMint.publicKey, userInboxAuthority)
      createAta(svm, authority, baseMint.publicKey, client.authorityPda)

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
        .receive({
          payer: authority.publicKey,
          direction: { deposit: {} },
          userWallet: userWallet.publicKey,
          recvMint: baseMint.publicKey,
          minSwapOut: RECEIVE_MIN,
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

    it('receive (deposit) rejects a non-allowlisted sender', async () => {
      const stranger = Keypair.generate().publicKey
      await expectError(() => receiveDepositWithSender(stranger.toBytes()), 'UnexpectedFogoSender')
    })

    it('receive (deposit) rejects a direct NTT bridge (sender = user session authority)', async () => {
      // A plain NTT transfer (no intent_transfer) surfaces the user's own
      // session authority as the VAA sender — not a setter PDA. Must be
      // rejected so only fee-bearing intent bridges can deposit here.
      const userSessionAuthority = Keypair.generate().publicKey
      await expectError(() => receiveDepositWithSender(userSessionAuthority.toBytes()), 'UnexpectedFogoSender')
    })

    it('receive (deposit) rejects replay when inflight Flow PDA already exists', async () => {
      const nttInboxItem = Keypair.generate()
      const userWallet = Keypair.generate()

      // Inject a Flow PDA at the expected inflight address to simulate a
      // prior claim_usdc having already created it.
      const [inflightPda, bump] = findInflightFlowPda(client.configPda, nttInboxItem.publicKey, client.program.programId)
      setFlowAccount(svm, inflightPda, {
        recipient: fogoSender,
        status: FlowStatus.Received,
        amount: 500_000n,
        payer: authority.publicKey,
        bump,
      }, client.program.programId)

      // Pre-create the per-user inbox ATA so Anchor's account
      // deserialization passes; the `inflight_flow` init constraint must
      // be the first thing to fail.
      const [userInboxAuthority] = findUserInboxWithMinPda(userWallet.publicKey, RECEIVE_MIN, client.program.programId)
      createAta(svm, authority, baseMint.publicKey, userInboxAuthority)
      // Sweep destination must also exist for the same reason.
      createAta(svm, authority, baseMint.publicKey, client.authorityPda)

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
            .receive({
              payer: authority.publicKey,
              direction: { deposit: {} },
              userWallet: userWallet.publicKey,
              recvMint: baseMint.publicKey,
              minSwapOut: RECEIVE_MIN,
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

    it('round-trips Flow.direction', async () => {
      const nttInboxItem = Keypair.generate()
      const [flowPda, bump] = findInflightFlowPda(client.configPda, nttInboxItem.publicKey, client.program.programId)
      setFlowAccount(svm, flowPda, {
        recipient: fogoSender,
        status: FlowStatus.Received,
        amount: 1_000n,
        payer: authority.publicKey,
        bump,
        direction: 1,
      }, client.program.programId)
      const flow = await client.fetchFlow(flowPda)
      expect('withdraw' in flow.direction).toBe(true)
    })

    it('receive (deposit) rejects forged system-owned inbox_item on the released-skip path', async () => {
      // Attack: a cranker self-funds its own inbox ATA and forges a
      // system-owned Released InboxItem to bypass the intent_transfer fee
      // path. The skip-branch owner check must reject it before any sweep.
      const attackerWallet = Keypair.generate()
      const fakeInboxItem = Keypair.generate()
      const [attackerInbox] = findUserInboxWithMinPda(
        attackerWallet.publicKey,
        RECEIVE_MIN,
        client.program.programId,
      )
      const attackerInboxAta = createAta(svm, authority, baseMint.publicKey, attackerInbox)
      // Self-funded "deposit" — without the owner guard, this would be
      // swept into relayer custody as phantom intent-bypass credit.
      mintTo(svm, authority, baseMint.publicKey, attackerInboxAta, 1_000_000)
      createAta(svm, authority, baseMint.publicKey, client.authorityPda)

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
            .receive({
              payer: authority.publicKey,
              direction: { deposit: {} },
              userWallet: attackerWallet.publicKey,
              recvMint: baseMint.publicKey,
              minSwapOut: RECEIVE_MIN,
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

    it('receive (deposit) rejects released-skip with valid setter VTM but unrelated InboxItem', async () => {
      // Attack: bridge USDC directly via NTT to the attacker's own inbox
      // (skipping intent_transfer fees), then borrow a real setter-originated
      // VTM. On the released-skip path the redeem CPI is skipped, so the
      // VTM↔InboxItem crypto link (NTT's keccak256 inbox_item seed) is only
      // enforced by the handler re-deriving the PDA. This test pairs a valid
      // Released NTT-owned InboxItem at an unrelated address with a valid
      // setter VTM and expects InboxItemMismatch.
      const attackerWallet = Keypair.generate()
      const unrelatedInboxItem = Keypair.generate()
      const [attackerInbox] = findUserInboxWithMinPda(
        attackerWallet.publicKey,
        RECEIVE_MIN,
        client.program.programId,
      )
      const attackerInboxAta = createAta(svm, authority, baseMint.publicKey, attackerInbox)
      mintTo(svm, authority, baseMint.publicKey, attackerInboxAta, 1_000_000)
      createAta(svm, authority, baseMint.publicKey, client.authorityPda)

      // NTT-owned Released InboxItem (passes the skip-path owner guard),
      // recipient = attacker inbox. Same 75-byte layout as the prior test.
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

      // Borrowed real setter-originated VTM: passes UnexpectedFogoSender,
      // but its contents hash to some other InboxItem, not unrelatedInboxItem.
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
            .receive({
              payer: authority.publicKey,
              direction: { deposit: {} },
              userWallet: attackerWallet.publicKey,
              recvMint: baseMint.publicKey,
              minSwapOut: RECEIVE_MIN,
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

    it('swap rejects flow not in Received status', async () => {
      const nttInboxItem = Keypair.generate()
      const [inflightPda, bump] = findInflightFlowPda(client.configPda, nttInboxItem.publicKey, client.program.programId)

      // Inject a Swapped flow — swap requires Received
      setFlowAccount(svm, inflightPda, {
        recipient: fogoSender,
        status: FlowStatus.Swapped,
        amount: 500_000n,
        payer: authority.publicKey,
        bump,
      }, client.program.programId)

      await expectError(
        () =>
          client
            .swap({
              flowPda: inflightPda,
              baseMint: baseMint.publicKey,
              assetMint: assetMint.publicKey,
              feeVault,
              nttInboxItem: nttInboxItem.publicKey,
              swapProgram: ONRE_PROGRAM_ID,
              swapDelegate: client.authorityPda,
              swapIxData: Buffer.alloc(0),
              swapAccounts: [],
            })
            .rpc(),
        'FlowStatusMismatch',
      )
    })

    it('rejects swap on a Flow with an undecodable direction', async () => {
      const nttInboxItem = Keypair.generate()
      const [flowPda, bump] = findInflightFlowPda(client.configPda, nttInboxItem.publicKey, client.program.programId)

      // direction byte 9 is not a valid Direction variant; borsh decode of
      // the Flow account must fail before the handler ever runs.
      setFlowAccount(svm, flowPda, {
        recipient: fogoSender,
        status: FlowStatus.Received,
        amount: 500_000n,
        payer: authority.publicKey,
        bump,
        direction: 9,
      }, client.program.programId)

      await expect(
        client
          .swap({
            flowPda,
            baseMint: baseMint.publicKey,
            assetMint: assetMint.publicKey,
            feeVault,
            nttInboxItem: nttInboxItem.publicKey,
            swapProgram: ONRE_PROGRAM_ID,
            swapDelegate: client.authorityPda,
            swapIxData: Buffer.alloc(0),
            swapAccounts: [
              { pubkey: client.authorityPda, isSigner: false, isWritable: false },
            ],
          })
          .rpc(),
      ).rejects.toThrow(/AccountDidNotDeserialize|failed to deserialize/i)
    })

    it('rejects receive with an invalid direction discriminant', async () => {
      // Direction has only {0: Deposit, 1: Withdraw}; byte 2 has no variant,
      // so borsh decode of the instruction arg fails before account validation.
      const recvIx = (client.program.idl as any).instructions.find(
        (i: any) => i.name === 'receive',
      )
      const discriminator = Buffer.from(recvIx.discriminator)
      const data = Buffer.concat([discriminator, Buffer.from([2]), Buffer.from([0])])

      const ix = new TransactionInstruction({
        programId: client.program.programId,
        keys: [{ pubkey: authority.publicKey, isSigner: true, isWritable: true }],
        data,
      })
      const tx = new Transaction().add(ix)

      await expectFailure(
        () => (client.program.provider as any).sendAndConfirm(tx, []),
        logMatches(/InstructionDidNotDeserialize/i),
        'receive must reject an unknown Direction discriminant',
      )
    })

    it('send rejects flow not in Swapped status', async () => {
      const nttInboxItem = Keypair.generate()
      const [inflightPda, bump] = findInflightFlowPda(client.configPda, nttInboxItem.publicKey, client.program.programId)

      // Inject a Received flow — send requires Swapped
      setFlowAccount(svm, inflightPda, {
        recipient: fogoSender,
        status: FlowStatus.Received,
        amount: 500_000n,
        payer: authority.publicKey,
        bump,
      }, client.program.programId)

      await expectError(
        () =>
          client
            .sendBase({
              payer: authority.publicKey,
              direction: { deposit: {} },
              baseMint: baseMint.publicKey,
              assetMint: assetMint.publicKey,
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

    it('send (deposit) rejects wrong rent destination', async () => {
      const nttInboxItem = Keypair.generate()
      const [inflightPda, bump] = findInflightFlowPda(client.configPda, nttInboxItem.publicKey, client.program.programId)
      const rando = Keypair.generate()
      svm.airdrop(rando.publicKey, BigInt(1e9))

      // Inject a Swapped flow with payer = authority
      setFlowAccount(svm, inflightPda, {
        recipient: fogoSender,
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
            .sendBase({
              payer: authority.publicKey,
              direction: { deposit: {} },
              baseMint: baseMint.publicKey,
              assetMint: assetMint.publicKey,
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

    it('send (deposit) rejects Swapped flow without session authority PDA', async () => {
      const nttInboxItem = Keypair.generate()
      const [inflightPda, bump] = findInflightFlowPda(client.configPda, nttInboxItem.publicKey, client.program.programId)

      // Inject a Swapped flow
      setFlowAccount(svm, inflightPda, {
        recipient: fogoSender,
        status: FlowStatus.Swapped,
        amount: 500_000n,
        payer: authority.publicKey,
        bump,
      }, client.program.programId)

      // Fund ONyc ATA
      const [authorityPda] = findAuthorityPda(client.program.programId)
      mintTo(svm, authority, assetMint.publicKey, authorityPda, 500_000)

      // Test omits the NTT session-authority PDA from remaining_accounts.
      // The relayer's own preflight check (`MissingSessionAuthority`) should
      // fire before any NTT CPI runs.
      await expectError(
        () =>
          client
            .sendBase({
              payer: authority.publicKey,
              direction: { deposit: {} },
              baseMint: baseMint.publicKey,
              assetMint: assetMint.publicKey,
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
      const [userInboxAuthority] = findUserInboxWithMinPda(userWallet, RECEIVE_MIN, client.program.programId)
      const userInboxAta = createAta(svm, authority, assetMint.publicKey, userInboxAuthority)
      return { userWallet, userInboxAta }
    }

    beforeEach(async () => {
      await client
        .initialize({
          authority: authority.publicKey,
          baseMint: baseMint.publicKey,
          assetMint: assetMint.publicKey,
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

    it('receive (withdraw) rejects zero fogo_sender', async () => {
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
            .receive({
              payer: authority.publicKey,
              direction: { withdraw: {} },
              userWallet,
              recvMint: assetMint.publicKey,
              minSwapOut: RECEIVE_MIN,
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

    it('receive (withdraw) rejects invalid account split (redeem_accounts_len=0)', async () => {
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
            .receive({
              payer: authority.publicKey,
              direction: { withdraw: {} },
              userWallet,
              recvMint: assetMint.publicKey,
              minSwapOut: RECEIVE_MIN,
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

    it('receive (withdraw) rejects double unlock (same ntt_inbox_item)', async () => {
      const nttInboxItem = Keypair.generate()
      const { userWallet } = setupUserInbox()
      const [outflightPda, bump] = findOutflightFlowPda(client.configPda, nttInboxItem.publicKey, client.program.programId)

      // Inject an existing outflight flow to simulate prior unlock
      setFlowAccount(svm, outflightPda, {
        recipient: fogoSender,
        status: FlowStatus.Received,
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
            .receive({
              payer: authority.publicKey,
              direction: { withdraw: {} },
              userWallet,
              recvMint: assetMint.publicKey,
              minSwapOut: RECEIVE_MIN,
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

    // Position-binding negatives for receive (withdraw). NTT consumes its account
    // lists positionally: `redeem` reads slots 3/6, `release_inbound_unlock`
    // reads slots 2/3; the handler pins all four
    // (receive.rs / validate_ntt_redeem_release_accounts). Each test corrupts
    // one slot and arranges the rest so its require! fires first.
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

    it('receive (withdraw) rejects TransceiverMessageMismatch when redeem[3] differs from named ntt_transceiver_message', async () => {
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
      const onycAta = getAssociatedTokenAddressSync(assetMint.publicKey, authorityPda, true)
      const wrongMsg = Keypair.generate().publicKey

      await expectError(
        () =>
          client
            .receive({
              payer: authority.publicKey,
              direction: { withdraw: {} },
              userWallet,
              recvMint: assetMint.publicKey,
              minSwapOut: RECEIVE_MIN,
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

    it('receive (withdraw) rejects InboxItemMismatch when redeem[6] differs from named ntt_inbox_item', async () => {
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
      const onycAta = getAssociatedTokenAddressSync(assetMint.publicKey, authorityPda, true)
      const wrongInbox = Keypair.generate().publicKey

      await expectError(
        () =>
          client
            .receive({
              payer: authority.publicKey,
              direction: { withdraw: {} },
              userWallet,
              recvMint: assetMint.publicKey,
              minSwapOut: RECEIVE_MIN,
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

    it('receive (withdraw) rejects RecipientAtaMismatch when release[3] differs from named user_inbox_ata', async () => {
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
            .receive({
              payer: authority.publicKey,
              direction: { withdraw: {} },
              userWallet,
              recvMint: assetMint.publicKey,
              minSwapOut: RECEIVE_MIN,
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

    it('send (withdraw) rejects flow not in Swapped status', async () => {
      const nttInboxItem = Keypair.generate()
      const [outflightPda, bump] = findOutflightFlowPda(client.configPda, nttInboxItem.publicKey, client.program.programId)

      // Inject a Received flow — send requires Swapped
      setFlowAccount(svm, outflightPda, {
        recipient: fogoSender,
        status: FlowStatus.Received,
        amount: 500_000n,
        payer: authority.publicKey,
        direction: 1,
        bump,
      }, client.program.programId)

      await expectError(
        () =>
          client
            .sendBase({
              payer: authority.publicKey,
              direction: { withdraw: {} },
              baseMint: baseMint.publicKey,
              assetMint: assetMint.publicKey,
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

    it('send (withdraw) rejects wrong rent destination', async () => {
      const nttInboxItem = Keypair.generate()
      const [outflightPda, bump] = findOutflightFlowPda(client.configPda, nttInboxItem.publicKey, client.program.programId)
      const rando = Keypair.generate()
      svm.airdrop(rando.publicKey, BigInt(1e9))

      // Inject a Swapped flow with payer = authority
      setFlowAccount(svm, outflightPda, {
        recipient: fogoSender,
        status: FlowStatus.Swapped,
        amount: 500_000n,
        payer: authority.publicKey,
        direction: 1,
        bump,
      }, client.program.programId)

      // Pass rando as rent destination — the `address = flow.payer`
      // constraint on `rent_destination` should fail with ConstraintAddress,
      // proving rent can only be returned to the original payer.
      await expectError(
        () =>
          client
            .sendBase({
              payer: authority.publicKey,
              direction: { withdraw: {} },
              baseMint: baseMint.publicKey,
              assetMint: assetMint.publicKey,
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

    it('send (withdraw) advances past relayer-side checks', async () => {
      const nttInboxItem = Keypair.generate()
      const [outflightPda, bump] = findOutflightFlowPda(client.configPda, nttInboxItem.publicKey, client.program.programId)

      // Inject a Swapped flow
      setFlowAccount(svm, outflightPda, {
        recipient: fogoSender,
        status: FlowStatus.Swapped,
        amount: 500_000n,
        payer: authority.publicKey,
        direction: 1,
        bump,
      }, client.program.programId)

      // Fund USDC ATA
      const [authorityPda] = findAuthorityPda(client.program.programId)
      mintTo(svm, authority, baseMint.publicKey, authorityPda, 500_000)

      // Omitting the NTT session-authority PDA trips `MissingSessionAuthority`
      // only after status, ATA, and rent-destination checks pass cleanly.
      await expectError(
        () =>
          client
            .sendBase({
              payer: authority.publicKey,
              direction: { withdraw: {} },
              baseMint: baseMint.publicKey,
              assetMint: assetMint.publicKey,
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
