/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found in the `idl` directory.
 */
export type Relayer = {
  address: 'Re1ayRHhmeqByGjgT5uLFExZCvQ8sv6LK74xowK8pJH'
  metadata: {
    name: 'relayer'
    version: '0.1.0'
    spec: '0.1.0'
    description: 'Fogo RWA relayer \u2014 stateless PDA-custody relay between Wormhole Gateway, OnRe, and Wormhole NTT on Solana'
  }
  docs: [
    'Stateless cross-chain relayer between FOGO and Solana (Phase 1 \u2014 no',
    'vault).',
    '',
    'All operational instructions are permissionless \u2014 anyone can crank any',
    'step. Safety comes from the Flow PDA design: each inbound Wormhole',
    'message (Gateway VAA or NTT VAA) carries the originating FOGO user\'s',
    'wallet in its payload. `claim_usdc` / `unlock_onyc` persist that wallet',
    'in a one-shot `Flow` PDA keyed by the bridge\'s per-VAA claim account',
    'pubkey; `lock_onyc` / `send_usdc_to_user` then consume that PDA to',
    'choose the outbound recipient. The Flow PDA also tracks status and',
    'amount, isolating concurrent flows and enabling resumability.',
  ]
  instructions: [
    {
      name: 'initialize'
      docs: [
        'One-time setup: create the relayer config PDA + USDC/ONyc ATAs',
        'owned by the relayer authority PDA.',
      ]
      discriminator: [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237,
      ]
      accounts: [
        {
          name: 'authority'
          docs: [
            'Deployer / authority \u2014 pays for account creation and becomes the',
            'admin key.',
          ]
          writable: true
          signer: true
        },
        {
          name: 'relayer_config'
          docs: [
            'Relayer config PDA \u2014 stores mint references.',
          ]
          writable: true
        },
        {
          name: 'relayer_authority'
          docs: [
            'Relayer authority PDA \u2014 owns the token accounts.',
          ]
        },
        {
          name: 'usdc_mint'
          docs: [
            'USDC token mint.',
          ]
        },
        {
          name: 'onyc_mint'
          docs: [
            'ONyc token mint.',
          ]
        },
        {
          name: 'usdc_ata'
          docs: [
            'USDC associated token account owned by the relayer authority PDA.',
          ]
          writable: true
        },
        {
          name: 'onyc_ata'
          docs: [
            'ONyc associated token account owned by the relayer authority PDA.',
          ]
          writable: true
        },
        {
          name: 'token_program'
        },
        {
          name: 'associated_token_program'
        },
        {
          name: 'system_program'
        },
      ]
      args: [
        {
          name: 'deposit_fee_bps'
          type: 'u16'
        },
        {
          name: 'withdraw_fee_bps'
          type: 'u16'
        },
      ]
    },
    {
      name: 'claim_usdc'
      docs: [
        'Claim USDC bridged from a FOGO user via Wormhole Gateway. Creates',
        'a `Flow` receipt that binds the eventual bONyc return to that same',
        'user\'s FOGO wallet.',
      ]
      discriminator: [
        43,
        131,
        9,
        102,
        229,
        140,
        91,
        141,
      ]
      accounts: [
        {
          name: 'payer'
          writable: true
          signer: true
        },
        {
          name: 'relayer_config'
        },
        {
          name: 'relayer_authority'
        },
        {
          name: 'usdc_mint'
        },
        {
          name: 'usdc_ata'
          writable: true
        },
        {
          name: 'posted_vaa'
          docs: [
            'Wormhole posted-VAA account. We read `fogo_sender` from its on-chain',
            'data (guardian-signed) rather than trusting an instruction argument.',
          ]
        },
        {
          name: 'gateway_claim'
          docs: [
            'Wormhole Gateway\'s per-VAA claim PDA. Created by the Gateway CPI;',
            'we use its pubkey as unique seed material for the flow PDA.',
          ]
        },
        {
          name: 'inflight_flow'
          docs: [
            'One-shot flow receipt. `init` fails if a flow for this claim PDA',
            'already exists (double-claim protection).',
          ]
          writable: true
        },
        {
          name: 'token_program'
        },
        {
          name: 'system_program'
        },
      ]
      args: []
    },
    {
      name: 'swap_usdc_to_onyc'
      docs: [
        'Swap the flow\'s USDC amount into ONyc via OnRe.',
      ]
      discriminator: [
        88,
        26,
        182,
        123,
        92,
        54,
        57,
        55,
      ]
      accounts: [
        {
          name: 'relayer_config'
        },
        {
          name: 'relayer_authority'
        },
        {
          name: 'usdc_mint'
        },
        {
          name: 'onyc_mint'
        },
        {
          name: 'usdc_ata'
          writable: true
        },
        {
          name: 'onyc_ata'
          writable: true
        },
        {
          name: 'gateway_claim'
          docs: [
            'Gateway claim PDA \u2014 seed material for the flow PDA.',
          ]
        },
        {
          name: 'inflight_flow'
          docs: [
            'The flow PDA created by `claim_usdc`. Must be in `Claimed` status.',
          ]
          writable: true
        },
        {
          name: 'token_program'
        },
      ]
      args: []
    },
    {
      name: 'lock_onyc'
      docs: [
        'Lock the flow\'s ONyc amount via Wormhole NTT, sending bONyc back',
        'to the FOGO wallet recorded in the `Flow` PDA. Consumes the PDA.',
      ]
      discriminator: [
        4,
        104,
        99,
        210,
        97,
        143,
        190,
        63,
      ]
      accounts: [
        {
          name: 'payer'
          writable: true
          signer: true
        },
        {
          name: 'relayer_config'
        },
        {
          name: 'relayer_authority'
        },
        {
          name: 'onyc_mint'
        },
        {
          name: 'onyc_ata'
          writable: true
        },
        {
          name: 'gateway_claim'
          docs: [
            'Same Gateway claim PDA used at `claim_usdc` time.',
          ]
        },
        {
          name: 'inflight_flow'
          docs: [
            'The one-shot receipt created by `claim_usdc`. `close = rent_destination`',
            'consumes the receipt so a second `lock_onyc` against the same flow',
            'is impossible.',
          ]
          writable: true
        },
        {
          name: 'rent_destination'
          docs: [
            'The original payer who created this flow PDA. Receives the rent refund.',
          ]
          writable: true
        },
        {
          name: 'token_program'
        },
      ]
      args: []
    },
    {
      name: 'unlock_onyc'
      docs: [
        'Release ONyc from NTT custody for an inbound withdrawal VAA, and',
        'record a `Flow` receipt binding the USDC return to the FOGO user',
        'who initiated the withdrawal.',
      ]
      discriminator: [
        225,
        208,
        126,
        107,
        209,
        43,
        111,
        166,
      ]
      accounts: [
        {
          name: 'payer'
          writable: true
          signer: true
        },
        {
          name: 'relayer_config'
        },
        {
          name: 'relayer_authority'
        },
        {
          name: 'onyc_mint'
        },
        {
          name: 'onyc_ata'
          writable: true
        },
        {
          name: 'ntt_inbox_item'
          docs: [
            'NTT inbox-item PDA. Created by the NTT `redeem` CPI; we use its',
            'pubkey as unique seed material for the flow PDA.',
          ]
        },
        {
          name: 'ntt_transceiver_message'
          docs: [
            'NTT `ValidatedTransceiverMessage` for this inbound transfer.',
            'Handler parses `fogo_sender` directly from its validated bytes.',
          ]
        },
        {
          name: 'outflight_flow'
          docs: [
            'One-shot receipt PDA for the withdrawal leg. `init` fails on',
            'replay (same NTT inbox \u2192 same PDA \u2192 already exists).',
          ]
          writable: true
        },
        {
          name: 'token_program'
        },
        {
          name: 'system_program'
        },
      ]
      args: [
        {
          name: 'redeem_accounts_len'
          type: 'u8'
        },
      ]
    },
    {
      name: 'swap_onyc_to_usdc'
      docs: [
        'Swap the flow\'s ONyc amount into USDC via OnRe.',
      ]
      discriminator: [
        113,
        41,
        170,
        211,
        19,
        16,
        31,
        63,
      ]
      accounts: [
        {
          name: 'relayer_config'
        },
        {
          name: 'relayer_authority'
        },
        {
          name: 'usdc_mint'
        },
        {
          name: 'onyc_mint'
        },
        {
          name: 'usdc_ata'
          writable: true
        },
        {
          name: 'onyc_ata'
          writable: true
        },
        {
          name: 'ntt_inbox_item'
          docs: [
            'NTT inbox-item PDA \u2014 seed material for the flow PDA.',
          ]
        },
        {
          name: 'outflight_flow'
          docs: [
            'The flow PDA created by `unlock_onyc`. Must be in `Claimed` status.',
          ]
          writable: true
        },
        {
          name: 'token_program'
        },
      ]
      args: []
    },
    {
      name: 'send_usdc_to_user'
      docs: [
        'Send the flow\'s USDC amount back to the FOGO user recorded in',
        'the `Flow` PDA. Consumes the PDA.',
      ]
      discriminator: [
        34,
        19,
        226,
        203,
        16,
        87,
        167,
        249,
      ]
      accounts: [
        {
          name: 'payer'
          writable: true
          signer: true
        },
        {
          name: 'relayer_config'
        },
        {
          name: 'relayer_authority'
        },
        {
          name: 'usdc_mint'
        },
        {
          name: 'usdc_ata'
          writable: true
        },
        {
          name: 'ntt_inbox_item'
          docs: [
            'Same NTT inbox-item PDA used at `unlock_onyc` time.',
          ]
        },
        {
          name: 'outflight_flow'
          docs: [
            'The one-shot receipt created by `unlock_onyc`. Closing it on',
            'success returns rent to the original payer and blocks replays.',
          ]
          writable: true
        },
        {
          name: 'rent_destination'
          docs: [
            'The original payer who created this flow PDA. Receives the rent refund.',
          ]
          writable: true
        },
        {
          name: 'token_program'
        },
      ]
      args: []
    },
    {
      name: 'update_fees'
      docs: [
        'Update the flat fee amounts for deposit and withdrawal flows.',
        'Authority-only.',
      ]
      discriminator: [
        225,
        27,
        13,
        6,
        69,
        84,
        172,
        191,
      ]
      accounts: [
        {
          name: 'authority'
          signer: true
        },
        {
          name: 'relayer_config'
          writable: true
        },
      ]
      args: [
        {
          name: 'deposit_fee_bps'
          type: 'u16'
        },
        {
          name: 'withdraw_fee_bps'
          type: 'u16'
        },
      ]
    },
    {
      name: 'withdraw_fees'
      docs: [
        'Withdraw accumulated fees from the relayer\'s token accounts to a',
        'destination wallet. Authority-only.',
      ]
      discriminator: [
        198,
        212,
        171,
        109,
        144,
        215,
        174,
        89,
      ]
      accounts: [
        {
          name: 'authority'
          signer: true
        },
        {
          name: 'relayer_config'
        },
        {
          name: 'relayer_authority'
        },
        {
          name: 'mint'
        },
        {
          name: 'from_ata'
          docs: [
            'Source: relayer authority\'s ATA for the given mint.',
          ]
          writable: true
        },
        {
          name: 'to_ata'
          docs: [
            'Destination: any token account for the same mint.',
          ]
          writable: true
        },
        {
          name: 'token_program'
        },
      ]
      args: [
        {
          name: 'amount'
          type: 'u64'
        },
      ]
    },
  ]
  accounts: [
    {
      name: 'Flow'
      discriminator: [
        126,
        151,
        86,
        177,
        58,
        153,
        167,
        203,
      ]
    },
    {
      name: 'RelayerConfig'
      discriminator: [
        116,
        239,
        42,
        132,
        218,
        154,
        194,
        20,
      ]
    },
  ]
  types: [
    {
      name: 'Flow'
      docs: [
        'One-shot receipt binding an inbound bridge message to a FOGO user wallet.',
        '',
        'Used by both deposit and withdrawal legs \u2014 direction is implicit in the',
        'PDA seed prefix (`FLOW_INBOUND_SEED` vs `FLOW_OUTBOUND_SEED`).',
        '',
        'Created by `claim_usdc` or `unlock_onyc` when the relayer processes an',
        'inbound Wormhole message. The `fogo_sender` field records the originating',
        'FOGO user\'s wallet (parsed from the VAA payload). Consumed by `lock_onyc`',
        'or `send_usdc_to_user`, which read `fogo_sender` as the outbound',
        'recipient.',
        '',
        'The `status` field tracks which pipeline step has completed, enabling',
        'resumability if a multi-step flow stalls. The `amount` field isolates',
        'each flow\'s capital so concurrent flows don\'t mix funds.',
        '',
        'PDA seeds: `[FLOW_*_SEED, bridge_claim_pda.key()]`, where',
        '`bridge_claim_pda` is the per-VAA claim account created by Wormhole',
        'Gateway or NTT. This delegates uniqueness and replay protection to the',
        'bridge program itself \u2014 no hashing needed.',
      ]
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'fogo_sender'
            docs: [
              'FOGO address of the user who originated the bridge message.',
              'Becomes the outbound Wormhole recipient on the return leg.',
            ]
            type: {
              array: [
                'u8',
                32,
              ]
            }
          },
          {
            name: 'status'
            docs: [
              'Current status in the pipeline.',
            ]
            type: {
              defined: {
                name: 'FlowStatus'
              }
            }
          },
          {
            name: 'amount'
            docs: [
              'Token amount for the current/next step.',
            ]
            type: 'u64'
          },
          {
            name: 'payer'
            docs: [
              'The payer who created this flow PDA (receives rent on close).',
            ]
            type: 'pubkey'
          },
          {
            name: 'bump'
            docs: [
              'PDA bump.',
            ]
            type: 'u8'
          },
        ]
      }
    },
    {
      name: 'FlowStatus'
      docs: [
        'Status of a flow through the relayer pipeline.',
      ]
      type: {
        kind: 'enum'
        variants: [
          {
            name: 'Claimed'
          },
          {
            name: 'Swapped'
          },
        ]
      }
    },
    {
      name: 'RelayerConfig'
      docs: [
        'Relayer configuration \u2014 the only long-lived state in this program.',
        '',
        'The `authority` is a cold/admin key used only for governance (e.g.',
        'updating config). All operational instructions are permissionless \u2014',
        'anyone can crank them because recipients are VAA-bound, amounts are',
        'flow-bound, and CPI targets are compile-time constants.',
      ]
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'authority'
            docs: [
              'Admin key for governance operations.',
            ]
            type: 'pubkey'
          },
          {
            name: 'usdc_mint'
            docs: [
              'USDC token mint on Solana.',
            ]
            type: 'pubkey'
          },
          {
            name: 'onyc_mint'
            docs: [
              'ONyc token mint on Solana.',
            ]
            type: 'pubkey'
          },
          {
            name: 'bump'
            docs: [
              'Bump seed for the config PDA.',
            ]
            type: 'u8'
          },
          {
            name: 'relayer_authority_bump'
            docs: [
              'Bump seed for the relayer authority PDA (needed for CPI invoke_signed).',
            ]
            type: 'u8'
          },
          {
            name: 'deposit_fee_bps'
            docs: [
              'Fee in basis points (1 bps = 0.01%) charged on each deposit flow (USDC \u2192 ONyc).',
            ]
            type: 'u16'
          },
          {
            name: 'withdraw_fee_bps'
            docs: [
              'Fee in basis points (1 bps = 0.01%) charged on each withdrawal flow (ONyc \u2192 USDC).',
            ]
            type: 'u16'
          },
        ]
      }
    },
  ]
}
