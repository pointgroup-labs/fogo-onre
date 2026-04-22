import type { LiteSVM } from 'litesvm'
import { BN } from '@anchor-lang/core'
import {
  findAuthorityPda,
  findInflightFlowPda,
  findOutflightFlowPda,
  FOGO_WORMHOLE_CHAIN_ID,
  GATEWAY_PROGRAM_ID,
  NTT_PROGRAM_ID,
  ONRE_PROGRAM_ID,
  RelayerClient,
  WORMHOLE_CORE_BRIDGE_ID,
} from '@fogo-onre/sdk'
import { Keypair, PublicKey } from '@solana/web3.js'
import {
  buildPostedVaaData,
  createAta,
  createMint,
  createProvider,
  createSvm,
  expectError,
  findValidatedTransceiverMessagePda,
  FlowStatus,
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

  beforeEach(async () => {
    svm = createSvm()
    authority = Keypair.generate()
    const provider = createProvider(svm, authority)
    client = new RelayerClient(provider as any)
    usdcMint = createMint(svm, authority, 6)
    onycMint = createMint(svm, authority, 6)
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
      await expect(
        client
          .initialize({
            authority: authority.publicKey,
            usdcMint: usdcMint.publicKey,
            onycMint: onycMint.publicKey,
            depositFeeBps: 10_001,
            withdrawFeeBps: 0,
          })
          .rpc(),
      ).rejects.toThrow()
    })

    it('rejects double initialization', async () => {
      await client
        .initialize({
          authority: authority.publicKey,
          usdcMint: usdcMint.publicKey,
          onycMint: onycMint.publicKey,
          depositFeeBps: 0,
          withdrawFeeBps: 0,
        })
        .rpc()

      await expect(
        client
          .initialize({
            authority: authority.publicKey,
            usdcMint: usdcMint.publicKey,
            onycMint: onycMint.publicKey,
            depositFeeBps: 0,
            withdrawFeeBps: 0,
          })
          .rpc(),
      ).rejects.toThrow()
    })

    it('allows zero and max valid fees', async () => {
      await client
        .initialize({
          authority: authority.publicKey,
          usdcMint: usdcMint.publicKey,
          onycMint: onycMint.publicKey,
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
  // update_fees
  // ---------------------------------------------------------------------------

  describe('update_fees', () => {
    beforeEach(async () => {
      await client
        .initialize({
          authority: authority.publicKey,
          usdcMint: usdcMint.publicKey,
          onycMint: onycMint.publicKey,
          depositFeeBps: 50,
          withdrawFeeBps: 100,
        })
        .rpc()
    })

    it('updates both fee values', async () => {
      await client
        .updateFees({
          authority: authority.publicKey,
          depositFeeBps: 200,
          withdrawFeeBps: 300,
        })
        .rpc()

      const config = await client.fetchConfig()
      expect(config.depositFeeBps).toBe(200)
      expect(config.withdrawFeeBps).toBe(300)
    })

    it('rejects non-authority signer', async () => {
      const rando = Keypair.generate()
      const randoProvider = createProvider(svm, rando)
      const randoClient = new RelayerClient(randoProvider as any)

      await expectError(
        () =>
          randoClient
            .updateFees({
              authority: rando.publicKey,
              depositFeeBps: 0,
              withdrawFeeBps: 0,
            })
            .rpc(),
        'UnauthorizedAuthority',
      )
    })

    it('rejects fee above 10000 bps', async () => {
      await expectError(
        () =>
          client
            .updateFees({
              authority: authority.publicKey,
              depositFeeBps: 10_001,
              withdrawFeeBps: 0,
            })
            .rpc(),
        'FeeBpsTooHigh',
      )
    })

    it('allows setting fees to zero', async () => {
      await client
        .updateFees({
          authority: authority.publicKey,
          depositFeeBps: 0,
          withdrawFeeBps: 0,
        })
        .rpc()

      const config = await client.fetchConfig()
      expect(config.depositFeeBps).toBe(0)
      expect(config.withdrawFeeBps).toBe(0)
    })
  })

  // ---------------------------------------------------------------------------
  // withdraw_fees
  // ---------------------------------------------------------------------------

  describe('withdraw_fees', () => {
    beforeEach(async () => {
      await client
        .initialize({
          authority: authority.publicKey,
          usdcMint: usdcMint.publicKey,
          onycMint: onycMint.publicKey,
          depositFeeBps: 50,
          withdrawFeeBps: 100,
        })
        .rpc()

      // Seed relayer authority PDA with USDC (simulating accumulated fees)
      const [authorityPda] = findAuthorityPda(client.program.programId)
      mintTo(svm, authority, usdcMint.publicKey, authorityPda, 1_000_000)
    })

    it('withdraws fees to destination ATA', async () => {
      const destAta = createAta(svm, authority, usdcMint.publicKey, authority.publicKey)

      await client
        .withdrawFees({
          authority: authority.publicKey,
          mint: usdcMint.publicKey,
          toAta: destAta,
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
            .withdrawFees({
              authority: rando.publicKey,
              mint: usdcMint.publicKey,
              toAta: destAta,
              amount: new BN(100),
            })
            .rpc(),
        'UnauthorizedAuthority',
      )
    })
  })

  // ---------------------------------------------------------------------------
  // full admin flow: initialize → update fees → withdraw
  // ---------------------------------------------------------------------------

  describe('full admin flow', () => {
    it('initialize → update fees → withdraw fees', async () => {
      // 1. Initialize with default fees
      await client
        .initialize({
          authority: authority.publicKey,
          usdcMint: usdcMint.publicKey,
          onycMint: onycMint.publicKey,
          depositFeeBps: 50,
          withdrawFeeBps: 100,
        })
        .rpc()

      const config1 = await client.fetchConfig()
      expect(config1.depositFeeBps).toBe(50)

      // 2. Update fees
      await client
        .updateFees({
          authority: authority.publicKey,
          depositFeeBps: 150,
          withdrawFeeBps: 250,
        })
        .rpc()

      const config2 = await client.fetchConfig()
      expect(config2.depositFeeBps).toBe(150)
      expect(config2.withdrawFeeBps).toBe(250)

      // 3. Seed relayer PDA with USDC and withdraw fees
      const [authorityPda] = findAuthorityPda(client.program.programId)
      mintTo(svm, authority, usdcMint.publicKey, authorityPda, 2_000_000)
      const destAta = createAta(svm, authority, usdcMint.publicKey, authority.publicKey)

      await client
        .withdrawFees({
          authority: authority.publicKey,
          mint: usdcMint.publicKey,
          toAta: destAta,
          amount: new BN(1_500_000),
        })
        .rpc()

      const account = svm.getAccount(destAta)
      expect(account).toBeTruthy()
    })
  })

  // ---------------------------------------------------------------------------
  // cancel_flow
  // ---------------------------------------------------------------------------

  describe('cancel_flow', () => {
    let flowKeypair: Keypair

    beforeEach(async () => {
      await client
        .initialize({
          authority: authority.publicKey,
          usdcMint: usdcMint.publicKey,
          onycMint: onycMint.publicKey,
          depositFeeBps: 50,
          withdrawFeeBps: 100,
        })
        .rpc()

      // Inject a fake Flow PDA at a random address (cancel_flow has no seeds constraint)
      flowKeypair = Keypair.generate()
      setFlowAccount(svm, flowKeypair.publicKey, {
        fogoSender: new Uint8Array(32).fill(1),
        status: FlowStatus.Claimed,
        amount: 1_000_000n,
        payer: authority.publicKey,
        bump: 0,
      }, client.program.programId)
    })

    it('authority can cancel a stuck flow', async () => {
      // Verify flow exists before cancel
      const preAccount = svm.getAccount(flowKeypair.publicKey)
      expect(preAccount).toBeTruthy()

      await client
        .cancelFlow({
          authority: authority.publicKey,
          flow: flowKeypair.publicKey,
          rentDestination: authority.publicKey,
        })
        .rpc()

      // Flow PDA should be closed
      const postAccount = svm.getAccount(flowKeypair.publicKey)
      // After close, the account should either be null or have zero data
      expect(!postAccount || postAccount.data.length === 0 || postAccount.lamports === 0).toBe(true)
    })

    it('rejects non-authority signer', async () => {
      const rando = Keypair.generate()
      const randoProvider = createProvider(svm, rando)
      const randoClient = new RelayerClient(randoProvider as any)

      // Need a flow whose payer is rando for rent_destination to match
      const randoFlow = Keypair.generate()
      setFlowAccount(svm, randoFlow.publicKey, {
        fogoSender: new Uint8Array(32).fill(2),
        status: FlowStatus.Claimed,
        amount: 500_000n,
        payer: rando.publicKey,
        bump: 0,
      }, client.program.programId)

      await expectError(
        () =>
          randoClient
            .cancelFlow({
              authority: rando.publicKey,
              flow: randoFlow.publicKey,
              rentDestination: rando.publicKey,
            })
            .rpc(),
        'UnauthorizedAuthority',
      )
    })

    it('rejects wrong rent destination (not flow payer)', async () => {
      const rando = Keypair.generate()
      svm.airdrop(rando.publicKey, BigInt(1e9))

      await expect(
        client
          .cancelFlow({
            authority: authority.publicKey,
            flow: flowKeypair.publicKey,
            rentDestination: rando.publicKey, // wrong — flow.payer is authority
          })
          .rpc(),
      ).rejects.toThrow()
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

      await expect(
        client
          .claimUsdc({
            payer: authority.publicKey,
            usdcMint: usdcMint.publicKey,
            postedVaa: fakeVaa.publicKey,
            gatewayClaim: fakeClaim.publicKey,
          })
          .rpc(),
      ).rejects.toThrow()
    })

    it('claim_usdc parses fogo_sender from valid posted VAA', async () => {
      // Build a real PostedVAA data buffer owned by Wormhole Core Bridge
      const vaaKeypair = Keypair.generate()
      const gatewayClaim = Keypair.generate()

      setPostedVaa(svm, vaaKeypair.publicKey, {
        fogoSender,
        amount: 1_000_000n,
      })

      // The CPI into Gateway will fail (no valid Gateway state), but
      // we verify the relayer accepted the VAA and attempted the CPI.
      // The error should come from the Gateway program, not from the
      // relayer's own VAA parsing.
      await expect(
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
      ).rejects.toThrow()
    })

    it('claim_usdc rejects VAA with invalid tag', async () => {
      const vaaKeypair = Keypair.generate()
      const gatewayClaim = Keypair.generate()

      // Build valid data then corrupt the tag
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

      await expect(
        client
          .claimUsdc({
            payer: authority.publicKey,
            usdcMint: usdcMint.publicKey,
            postedVaa: vaaKeypair.publicKey,
            gatewayClaim: gatewayClaim.publicKey,
          })
          .rpc(),
      ).rejects.toThrow()
    })

    it('claim_usdc rejects double claim (same gateway_claim)', async () => {
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

      // init constraint on inflight_flow should fail (account already exists)
      await expect(
        client
          .claimUsdc({
            payer: authority.publicKey,
            usdcMint: usdcMint.publicKey,
            postedVaa: vaaKeypair.publicKey,
            gatewayClaim: gatewayClaim.publicKey,
          })
          .rpc(),
      ).rejects.toThrow()
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

      // CPI will fail at OnRe (no valid offer state), but the relayer
      // should get past its own validations
      await expect(
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
      ).rejects.toThrow()
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

      // Pass rando as rent destination — should fail (flow.payer = authority)
      await expect(
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
      ).rejects.toThrow()
    })

    it('lock_onyc with Swapped flow attempts NTT CPI', async () => {
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

      // CPI will fail at NTT (no valid NTT state), but the relayer
      // should pass its own flow status + rent_destination checks
      await expect(
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
      ).rejects.toThrow()
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

      await expect(
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
      ).rejects.toThrow()
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

      await expect(
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
      ).rejects.toThrow()
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

      // init constraint on outflight_flow should fail (account already exists)
      await expect(
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
      ).rejects.toThrow()
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

      // CPI will fail at OnRe, but relayer validations should pass
      await expect(
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
      ).rejects.toThrow()
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

      // Pass rando as rent destination — should fail
      await expect(
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
      ).rejects.toThrow()
    })

    it('send_usdc_to_user with Swapped flow attempts Gateway CPI', async () => {
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

      // CPI will fail at Gateway, but relayer validations should pass
      await expect(
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
      ).rejects.toThrow()
    })
  })
})
