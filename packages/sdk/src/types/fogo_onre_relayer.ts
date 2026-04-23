/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/relayer.json`.
 */
export type Relayer = {
  address: 'onrenRKgX54qtWeK3cuaTBE71xx7dWMXn82ubH61vAp'
  metadata: {
    name: 'relayer'
    version: '0.1.0'
    spec: '0.1.0'
    description: 'Fogo OnRe relayer — stateless PDA-custody relay between Wormhole Gateway, OnRe, and Wormhole NTT on Solana'
  }
  docs: [
    'Stateless cross-chain relayer between FOGO and Solana.',
    '',
    'All operational instructions are permissionless. Safety comes from the',
    'Flow PDA design: each inbound Wormhole message carries the originating',
    'FOGO user\'s wallet in its payload. `claim_usdc` / `unlock_onyc` persist',
    'that wallet in a one-shot `Flow` PDA keyed by the bridge\'s per-VAA claim',
    'account; `lock_onyc` / `send_usdc_to_user` consume the PDA to choose the',
    'outbound recipient. A stolen operator key cannot redirect outbound',
    'transfers — the claim PDA is CPI-created by the bridge program and',
    'unforgeable.',
  ]
  instructions: [
    {
      name: 'acceptAuthority'
      docs: [
        'Two-step rotation, step two. Signer must equal',
        '`relayer_config.pending_authority`. The current authority does NOT',
        'participate — by design, so two independent multisigs can rotate',
        'without atomic cross-multisig coordination.',
      ]
      discriminator: [
        107,
        86,
        198,
        91,
        33,
        12,
        107,
        160,
      ]
      accounts: [
        {
          name: 'pendingAuthority'
          docs: [
            'Must equal `relayer_config.pending_authority`.',
          ]
          signer: true
        },
        {
          name: 'relayerConfig'
          writable: true
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                ]
              },
            ]
          }
        },
      ]
      args: []
    },
    {
      name: 'cancelRedemptionOnyc'
      docs: [
        'Authority-only escape hatch. Aborts an in-flight OnRe redemption',
        '(returns ONyc to `onyc_ata`, rolls flow back to `Claimed`, frees',
        'the singleton). Authority-gated to prevent the',
        'request→cancel→request fee-griefing loop a permissionless cancel',
        'would enable. See `cancel_redemption_onyc.rs` for stuck-redemption',
        'scenarios.',
      ]
      discriminator: [
        173,
        168,
        252,
        110,
        16,
        149,
        112,
        62,
      ]
      accounts: [
        {
          name: 'authority'
          signer: true
          relations: [
            'relayerConfig',
          ]
        },
        {
          name: 'relayerConfig'
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                ]
              },
            ]
          }
        },
        {
          name: 'relayerAuthority'
          docs: [
            'in `invoke_relayer_signed`. Must be the redeemer recorded inside',
            '`redemption_request` (OnRe\'s cancel constraint enforces this), so',
            'the unlocked ONyc returns to its ATA (`onyc_ata`).',
          ]
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
                ]
              },
            ]
          }
        },
        {
          name: 'onycMint'
          relations: [
            'relayerConfig',
          ]
        },
        {
          name: 'onycAta'
          docs: [
            'Pinned by `has_one = onyc_mint` and ATA derivation. Receives the',
            'unlocked ONyc back from OnRe\'s redemption vault. Already exists',
            '(created in `initialize`), so OnRe\'s `init_if_needed` on the',
            'equivalent slot inside the CPI is a no-op and `signer` (us) does',
            'not actually pay rent.',
          ]
          writable: true
          pda: {
            seeds: [
              {
                kind: 'account'
                path: 'relayerAuthority'
              },
              {
                kind: 'account'
                path: 'tokenProgram'
              },
              {
                kind: 'account'
                path: 'onycMint'
              },
            ]
            program: {
              kind: 'const'
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89,
              ]
            }
          }
        },
        {
          name: 'nttInboxItem'
        },
        {
          name: 'outflightFlow'
          writable: true
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  111,
                  117,
                  116,
                  102,
                  108,
                  105,
                  103,
                  104,
                  116,
                ]
              },
              {
                kind: 'account'
                path: 'nttInboxItem'
              },
            ]
          }
        },
        {
          name: 'redemptionTracker'
          docs: [
            'Singleton; closes to its original payer (recorded in `tracker.payer`).',
            '`tracker.flow == outflight_flow.key()` is verified in the handler.',
          ]
          writable: true
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  100,
                  101,
                  109,
                  112,
                  116,
                  105,
                  111,
                  110,
                  95,
                  116,
                  114,
                  97,
                  99,
                  107,
                  101,
                  114,
                ]
              },
            ]
          }
        },
        {
          name: 'payerForClose'
          docs: [
            'payer recorded in the tracker is who gets the rent back — same',
            'invariant as `claim_redemption_usdc`\'s close path so a cancelled-',
            'then-reclaimed flow never has rent diverted.',
          ]
          writable: true
        },
        {
          name: 'tokenProgram'
        },
      ]
      args: []
    },
    {
      name: 'claimRedemptionUsdc'
      docs: [
        'Once OnRe\'s `redemption_admin` has fulfilled (signal: their',
        '`RedemptionRequest` PDA is closed), book the USDC delta onto the',
        'flow and close the singleton. Caller-permissionless.',
      ]
      discriminator: [
        171,
        90,
        50,
        244,
        156,
        19,
        211,
        106,
      ]
      accounts: [
        {
          name: 'cranker'
          docs: [
            'Receives rent from the closed `redemption_tracker`. Need not be the',
            'same key as `tracker.payer` — the close-target is pinned by the',
            '`close = payer_for_close` constraint to `tracker.payer`, see below.',
            'The cranker pays tx fees.',
          ]
          writable: true
          signer: true
        },
        {
          name: 'relayerConfig'
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                ]
              },
            ]
          }
        },
        {
          name: 'relayerAuthority'
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
                ]
              },
            ]
          }
        },
        {
          name: 'usdcMint'
          relations: [
            'relayerConfig',
          ]
        },
        {
          name: 'usdcAta'
          pda: {
            seeds: [
              {
                kind: 'account'
                path: 'relayerAuthority'
              },
              {
                kind: 'account'
                path: 'tokenProgram'
              },
              {
                kind: 'account'
                path: 'usdcMint'
              },
            ]
            program: {
              kind: 'const'
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89,
              ]
            }
          }
        },
        {
          name: 'nttInboxItem'
        },
        {
          name: 'outflightFlow'
          writable: true
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  111,
                  117,
                  116,
                  102,
                  108,
                  105,
                  103,
                  104,
                  116,
                ]
              },
              {
                kind: 'account'
                path: 'nttInboxItem'
              },
            ]
          }
        },
        {
          name: 'redemptionTracker'
          docs: [
            'Singleton, closes to its original payer (recorded in `tracker.payer`).',
            '`tracker.flow == outflight_flow.key()` is verified in the handler.',
          ]
          writable: true
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  100,
                  101,
                  109,
                  112,
                  116,
                  105,
                  111,
                  110,
                  95,
                  116,
                  114,
                  97,
                  99,
                  107,
                  101,
                  114,
                ]
              },
            ]
          }
        },
        {
          name: 'payerForClose'
          docs: [
            'payer recorded in the tracker is who gets the rent back.',
          ]
          writable: true
        },
        {
          name: 'redemptionRequest'
          docs: [
            'it has been closed by OnRe\'s `fulfill_redemption_request`.',
          ]
        },
        {
          name: 'tokenProgram'
        },
      ]
      args: []
    },
    {
      name: 'claimUsdc'
      docs: [
        'Claim bridged USDC and create an inflight `Flow` receipt binding the',
        'eventual bONyc return to the originator\'s FOGO wallet.',
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
          name: 'relayerConfig'
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                ]
              },
            ]
          }
        },
        {
          name: 'relayerAuthority'
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
                ]
              },
            ]
          }
        },
        {
          name: 'redeemerAuthority'
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  100,
                  101,
                  101,
                  109,
                  101,
                  114,
                ]
              },
            ]
          }
        },
        {
          name: 'usdcMint'
          relations: [
            'relayerConfig',
          ]
        },
        {
          name: 'usdcAta'
          docs: [
            'Long-lived authority-owned USDC sink. `claim_usdc` sweeps bridged',
            'USDC here; downstream `swap_usdc_to_onyc` reads from the same ATA.',
            'Boxed for stack-budget headroom (see `swap_usdc_to_onyc` for the',
            'same rationale).',
          ]
          writable: true
          pda: {
            seeds: [
              {
                kind: 'account'
                path: 'relayerAuthority'
              },
              {
                kind: 'account'
                path: 'tokenProgram'
              },
              {
                kind: 'account'
                path: 'usdcMint'
              },
            ]
            program: {
              kind: 'const'
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89,
              ]
            }
          }
        },
        {
          name: 'redeemerUsdcAta'
          docs: [
            'Short-lived intake ATA — TB mints into it during the CPI; we sweep',
            'to `usdc_ata` in the same instruction.',
          ]
          writable: true
          pda: {
            seeds: [
              {
                kind: 'account'
                path: 'redeemerAuthority'
              },
              {
                kind: 'account'
                path: 'tokenProgram'
              },
              {
                kind: 'account'
                path: 'usdcMint'
              },
            ]
            program: {
              kind: 'const'
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89,
              ]
            }
          }
        },
        {
          name: 'redemptionTracker'
          docs: [
            'Withdraw-chain mutex gate. `SystemAccount` asserts',
            '`owner == system_program::ID`, which is true iff the singleton',
            '`RedemptionTracker` PDA does NOT currently exist. While a withdraw',
            'redemption is in flight the tracker is `init`\'d (program-owned) and',
            'this constraint fails — pausing deposit USDC inflows so they can\'t',
            'pollute `claim_redemption_usdc`\'s snapshot/delta math.',
          ]
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  100,
                  101,
                  109,
                  112,
                  116,
                  105,
                  111,
                  110,
                  95,
                  116,
                  114,
                  97,
                  99,
                  107,
                  101,
                  114,
                ]
              },
            ]
          }
        },
        {
          name: 'postedVaa'
          docs: [
            '`fogo_sender` is read from on-chain (guardian-signed) data, not args.',
          ]
        },
        {
          name: 'gatewayClaim'
          docs: [
            'Per-VAA Gateway claim PDA — its pubkey seeds the flow PDA.',
          ]
        },
        {
          name: 'inflightFlow'
          docs: [
            '`init` blocks double-claims against the same gateway claim PDA.',
          ]
          writable: true
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  105,
                  110,
                  102,
                  108,
                  105,
                  103,
                  104,
                  116,
                ]
              },
              {
                kind: 'account'
                path: 'gatewayClaim'
              },
            ]
          }
        },
        {
          name: 'tokenProgram'
        },
        {
          name: 'systemProgram'
          address: '11111111111111111111111111111111'
        },
      ]
      args: []
    },
    {
      name: 'configure'
      docs: [
        'Authority-only. `None` args leave the corresponding field unchanged.',
        '`new_authority`: `Some(pk)` proposes; `Some(default())` cancels;',
        '`None` leaves the proposal slot alone. Acceptance happens in',
        '`accept_authority`.',
      ]
      discriminator: [
        245,
        7,
        108,
        117,
        95,
        196,
        54,
        217,
      ]
      accounts: [
        {
          name: 'authority'
          signer: true
          relations: [
            'relayerConfig',
          ]
        },
        {
          name: 'relayerConfig'
          writable: true
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                ]
              },
            ]
          }
        },
        {
          name: 'relayerAuthority'
          docs: [
            'Re-derived so the associated-token derivation on `onyc_ata` resolves',
            'for the anti-aliasing constraint.',
          ]
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
                ]
              },
            ]
          }
        },
        {
          name: 'onycMint'
          relations: [
            'relayerConfig',
          ]
        },
        {
          name: 'onycAta'
          docs: [
            'Referenced solely to enforce `fee_vault != onyc_ata`.',
          ]
          pda: {
            seeds: [
              {
                kind: 'account'
                path: 'relayerAuthority'
              },
              {
                kind: 'account'
                path: 'tokenProgram'
              },
              {
                kind: 'account'
                path: 'onycMint'
              },
            ]
            program: {
              kind: 'const'
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89,
              ]
            }
          }
        },
        {
          name: 'feeVault'
          docs: [
            '`None` leaves the stored vault unchanged. The anti-aliasing check',
            'runs in the handler — Anchor constraint exprs can\'t disambiguate',
            '`Option::as_ref` against `InterfaceAccount`\'s `AsRef` impls.',
          ]
          optional: true
        },
        {
          name: 'tokenProgram'
        },
      ]
      args: [
        {
          name: 'depositFeeBps'
          type: {
            option: 'u16'
          }
        },
        {
          name: 'withdrawFeeBps'
          type: {
            option: 'u16'
          }
        },
        {
          name: 'newAuthority'
          type: {
            option: 'pubkey'
          }
        },
      ]
    },
    {
      name: 'initialize'
      docs: [
        'One-time setup: create config PDA + relayer-authority-owned ATAs.',
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
          writable: true
          signer: true
        },
        {
          name: 'relayerConfig'
          writable: true
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                ]
              },
            ]
          }
        },
        {
          name: 'relayerAuthority'
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
                ]
              },
            ]
          }
        },
        {
          name: 'redeemerAuthority'
          docs: [
            'Serves as TB\'s payload-delivery signer in `CompleteWrappedWithPayload`',
            'AND owns the short-lived USDC intake ATA (TB requires',
            '`redeemer.key == to.owner`).',
          ]
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  100,
                  101,
                  101,
                  109,
                  101,
                  114,
                ]
              },
            ]
          }
        },
        {
          name: 'usdcMint'
        },
        {
          name: 'onycMint'
        },
        {
          name: 'usdcAta'
          writable: true
          pda: {
            seeds: [
              {
                kind: 'account'
                path: 'relayerAuthority'
              },
              {
                kind: 'account'
                path: 'tokenProgram'
              },
              {
                kind: 'account'
                path: 'usdcMint'
              },
            ]
            program: {
              kind: 'const'
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89,
              ]
            }
          }
        },
        {
          name: 'onycAta'
          writable: true
          pda: {
            seeds: [
              {
                kind: 'account'
                path: 'relayerAuthority'
              },
              {
                kind: 'account'
                path: 'tokenProgram'
              },
              {
                kind: 'account'
                path: 'onycMint'
              },
            ]
            program: {
              kind: 'const'
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89,
              ]
            }
          }
        },
        {
          name: 'redeemerUsdcAta'
          docs: [
            '`claim_usdc` mints into this ATA via TB then immediately sweeps it',
            'to `usdc_ata` under the redeemer\'s signature.',
          ]
          writable: true
          pda: {
            seeds: [
              {
                kind: 'account'
                path: 'redeemerAuthority'
              },
              {
                kind: 'account'
                path: 'tokenProgram'
              },
              {
                kind: 'account'
                path: 'usdcMint'
              },
            ]
            program: {
              kind: 'const'
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89,
              ]
            }
          }
        },
        {
          name: 'feeVault'
          docs: [
            'Anti-aliasing constraint: forbidding `fee_vault == onyc_ata`',
            'prevents silent self-transfer no-ops that would commingle user',
            'funds with fees and defeat the vault split.',
          ]
        },
        {
          name: 'tokenProgram'
        },
        {
          name: 'associatedTokenProgram'
          address: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
        },
        {
          name: 'systemProgram'
          address: '11111111111111111111111111111111'
        },
      ]
      args: [
        {
          name: 'depositFeeBps'
          type: 'u16'
        },
        {
          name: 'withdrawFeeBps'
          type: 'u16'
        },
      ]
    },
    {
      name: 'lockOnyc'
      docs: [
        'Lock ONyc via NTT, sending bONyc to `flow.fogo_sender`. Closes the PDA.',
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
          name: 'relayerConfig'
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                ]
              },
            ]
          }
        },
        {
          name: 'relayerAuthority'
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
                ]
              },
            ]
          }
        },
        {
          name: 'onycMint'
          relations: [
            'relayerConfig',
          ]
        },
        {
          name: 'onycAta'
          writable: true
          pda: {
            seeds: [
              {
                kind: 'account'
                path: 'relayerAuthority'
              },
              {
                kind: 'account'
                path: 'tokenProgram'
              },
              {
                kind: 'account'
                path: 'onycMint'
              },
            ]
            program: {
              kind: 'const'
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89,
              ]
            }
          }
        },
        {
          name: 'gatewayClaim'
        },
        {
          name: 'inflightFlow'
          docs: [
            '`close = rent_destination` blocks any second `lock_onyc` against this flow.',
          ]
          writable: true
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  105,
                  110,
                  102,
                  108,
                  105,
                  103,
                  104,
                  116,
                ]
              },
              {
                kind: 'account'
                path: 'gatewayClaim'
              },
            ]
          }
        },
        {
          name: 'rentDestination'
          writable: true
        },
        {
          name: 'tokenProgram'
        },
      ]
      args: []
    },
    {
      name: 'requestRedemptionOnyc'
      docs: [
        'Forward flow\'s ONyc to OnRe via `create_redemption_request` and',
        'init the singleton tracker. Caller-permissionless. Fee taken pre-CPI.',
        'Replaces the deleted `swap_onyc_to_usdc` because OnRe\'s withdraw',
        'side is asymmetric — see `docs/WITHDRAW_REDESIGN.md`.',
      ]
      discriminator: [
        117,
        2,
        5,
        175,
        6,
        12,
        151,
        176,
      ]
      accounts: [
        {
          name: 'payer'
          writable: true
          signer: true
        },
        {
          name: 'relayerConfig'
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                ]
              },
            ]
          }
        },
        {
          name: 'relayerAuthority'
          docs: [
            '`invoke_relayer_signed` for the OnRe CPI.',
          ]
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
                ]
              },
            ]
          }
        },
        {
          name: 'usdcMint'
          relations: [
            'relayerConfig',
          ]
        },
        {
          name: 'onycMint'
          relations: [
            'relayerConfig',
          ]
        },
        {
          name: 'usdcAta'
          docs: [
            'Pre-balance snapshot source for the `claim_redemption_usdc` delta.',
            'Boxed: total stack budget for `try_accounts` overflows the eBPF',
            '4 KiB cap when every `InterfaceAccount<TokenAccount>` is inline.',
          ]
          writable: true
          pda: {
            seeds: [
              {
                kind: 'account'
                path: 'relayerAuthority'
              },
              {
                kind: 'account'
                path: 'tokenProgram'
              },
              {
                kind: 'account'
                path: 'usdcMint'
              },
            ]
            program: {
              kind: 'const'
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89,
              ]
            }
          }
        },
        {
          name: 'onycAta'
          docs: [
            'Source of the fee transfer; OnRe\'s CPI also pulls from here via the',
            '`redeemer_token_account` slot in `remaining_accounts`. Boxed for',
            'the same stack-budget reason as `usdc_ata`.',
          ]
          writable: true
          pda: {
            seeds: [
              {
                kind: 'account'
                path: 'relayerAuthority'
              },
              {
                kind: 'account'
                path: 'tokenProgram'
              },
              {
                kind: 'account'
                path: 'onycMint'
              },
            ]
            program: {
              kind: 'const'
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89,
              ]
            }
          }
        },
        {
          name: 'feeVault'
          writable: true
          relations: [
            'relayerConfig',
          ]
        },
        {
          name: 'nttInboxItem'
        },
        {
          name: 'outflightFlow'
          docs: [
            'Created by `unlock_onyc`; must be in `Claimed` status.',
          ]
          writable: true
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  111,
                  117,
                  116,
                  102,
                  108,
                  105,
                  103,
                  104,
                  116,
                ]
              },
              {
                kind: 'account'
                path: 'nttInboxItem'
              },
            ]
          }
        },
        {
          name: 'redemptionTracker'
          docs: [
            'Singleton init — fails if any prior redemption is still in flight.',
            'This is the on-chain mutex that makes the ATA-delta math safe.',
          ]
          writable: true
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  100,
                  101,
                  109,
                  112,
                  116,
                  105,
                  111,
                  110,
                  95,
                  116,
                  114,
                  97,
                  99,
                  107,
                  101,
                  114,
                ]
              },
            ]
          }
        },
        {
          name: 'tokenProgram'
        },
        {
          name: 'systemProgram'
          address: '11111111111111111111111111111111'
        },
      ]
      args: []
    },
    {
      name: 'sendUsdcToUser'
      docs: [
        'Send USDC to `flow.fogo_sender` and close the PDA.',
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
          name: 'relayerConfig'
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                ]
              },
            ]
          }
        },
        {
          name: 'relayerAuthority'
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
                ]
              },
            ]
          }
        },
        {
          name: 'usdcMint'
          relations: [
            'relayerConfig',
          ]
        },
        {
          name: 'usdcAta'
          writable: true
          pda: {
            seeds: [
              {
                kind: 'account'
                path: 'relayerAuthority'
              },
              {
                kind: 'account'
                path: 'tokenProgram'
              },
              {
                kind: 'account'
                path: 'usdcMint'
              },
            ]
            program: {
              kind: 'const'
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89,
              ]
            }
          }
        },
        {
          name: 'nttInboxItem'
          docs: [
            'Same NTT inbox-item PDA used at `unlock_onyc` time.',
          ]
        },
        {
          name: 'outflightFlow'
          docs: [
            'Closing on success returns rent to the original payer and blocks replays.',
          ]
          writable: true
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  111,
                  117,
                  116,
                  102,
                  108,
                  105,
                  103,
                  104,
                  116,
                ]
              },
              {
                kind: 'account'
                path: 'nttInboxItem'
              },
            ]
          }
        },
        {
          name: 'rentDestination'
          writable: true
        },
        {
          name: 'redemptionTracker'
          docs: [
            'Singleton redemption tracker slot — must NOT currently exist. Gating',
            '`send_usdc_to_user` on this closes the outflow race in the withdraw-',
            'chain delta math: while any `RedemptionTracker` is alive, a sibling',
            'flow may be mid-redemption with its pre-balance snapshot pinned',
            'against this very `usdc_ata`. A concurrent outflow here would poison',
            'that delta (`B.redeemed − A.amount` instead of `B.redeemed`),',
            'causing `BalanceUnderflow` or silent user under-credit.',
            '',
            '`SystemAccount` asserts `owner == system_program::ID`. Combined with',
            'the seed pinning, this passes iff the PDA either never existed or',
            'was closed (by `claim_redemption_usdc` / `cancel_redemption_onyc`)',
            'and fails when a redemption is mid-flight — exactly the invariant',
            '`claim_redemption_usdc`\'s snapshot→reload math needs.',
            '',
            'Liveness note: already-`Swapped` flows wait on the pending redemption',
            'to complete. Stuck redemptions are covered by',
            '`cancel_redemption_onyc`. This is a deliberate correctness-over-',
            'latency trade.',
          ]
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  100,
                  101,
                  109,
                  112,
                  116,
                  105,
                  111,
                  110,
                  95,
                  116,
                  114,
                  97,
                  99,
                  107,
                  101,
                  114,
                ]
              },
            ]
          }
        },
        {
          name: 'tokenProgram'
        },
      ]
      args: []
    },
    {
      name: 'swapUsdcToOnyc'
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
          name: 'relayerConfig'
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                ]
              },
            ]
          }
        },
        {
          name: 'relayerAuthority'
          docs: [
            'and the post-swap fee transfer.',
          ]
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
                ]
              },
            ]
          }
        },
        {
          name: 'usdcMint'
          relations: [
            'relayerConfig',
          ]
        },
        {
          name: 'onycMint'
          relations: [
            'relayerConfig',
          ]
        },
        {
          name: 'usdcAta'
          docs: [
            'USDC source for OnRe `take_offer_permissionless`. Owned by',
            '`relayer_authority`; OnRe enforces `user_token_in_account.authority',
            '== user`, satisfied because the relayer authority signs the CPI as',
            '`user`. Boxed for stack budget.',
          ]
          writable: true
          pda: {
            seeds: [
              {
                kind: 'account'
                path: 'relayerAuthority'
              },
              {
                kind: 'account'
                path: 'tokenProgram'
              },
              {
                kind: 'account'
                path: 'usdcMint'
              },
            ]
            program: {
              kind: 'const'
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89,
              ]
            }
          }
        },
        {
          name: 'onycAta'
          docs: [
            'ONyc destination for the swap; also the source of the post-swap fee',
            'transfer. Same authority story as `usdc_ata`.',
          ]
          writable: true
          pda: {
            seeds: [
              {
                kind: 'account'
                path: 'relayerAuthority'
              },
              {
                kind: 'account'
                path: 'tokenProgram'
              },
              {
                kind: 'account'
                path: 'onycMint'
              },
            ]
            program: {
              kind: 'const'
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89,
              ]
            }
          }
        },
        {
          name: 'feeVault'
          docs: [
            'Pinned by `has_one = fee_vault`. Any pre-existing ONyc account; need',
            'not be relayer-owned.',
          ]
          writable: true
          relations: [
            'relayerConfig',
          ]
        },
        {
          name: 'redemptionTracker'
          docs: [
            'Withdraw-chain mutex gate. `SystemAccount` asserts',
            '`owner == system_program::ID`, true iff the singleton',
            '`RedemptionTracker` PDA does NOT currently exist. While a withdraw',
            'redemption is in flight this fails, pausing deposits so the',
            'snapshot/delta math in `claim_redemption_usdc` stays correct.',
          ]
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  100,
                  101,
                  109,
                  112,
                  116,
                  105,
                  111,
                  110,
                  95,
                  116,
                  114,
                  97,
                  99,
                  107,
                  101,
                  114,
                ]
              },
            ]
          }
        },
        {
          name: 'gatewayClaim'
        },
        {
          name: 'inflightFlow'
          docs: [
            'Created by `claim_usdc`; must be in `Claimed` status.',
          ]
          writable: true
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  105,
                  110,
                  102,
                  108,
                  105,
                  103,
                  104,
                  116,
                ]
              },
              {
                kind: 'account'
                path: 'gatewayClaim'
              },
            ]
          }
        },
        {
          name: 'tokenProgram'
        },
      ]
      args: []
    },
    {
      name: 'sweep'
      docs: [
        'Authority-only escape hatch for stranded balances on the',
        'PDA-owned ATAs (commingled fees, dust, accidental transfers).',
        'See `sweep.rs` for the trust-model rationale.',
      ]
      discriminator: [
        40,
        23,
        234,
        175,
        14,
        61,
        154,
        177,
      ]
      accounts: [
        {
          name: 'authority'
          signer: true
          relations: [
            'relayerConfig',
          ]
        },
        {
          name: 'relayerConfig'
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                ]
              },
            ]
          }
        },
        {
          name: 'relayerAuthority'
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
                ]
              },
            ]
          }
        },
        {
          name: 'mint'
          docs: [
            'Runtime-constrained to `usdc_mint` or `onyc_mint` from config.',
          ]
        },
        {
          name: 'from'
          docs: [
            'Source — relayer-authority-owned ATA for `mint` (ATA derivation pins).',
          ]
          writable: true
          pda: {
            seeds: [
              {
                kind: 'account'
                path: 'relayerAuthority'
              },
              {
                kind: 'account'
                path: 'tokenProgram'
              },
              {
                kind: 'account'
                path: 'mint'
              },
            ]
            program: {
              kind: 'const'
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89,
              ]
            }
          }
        },
        {
          name: 'to'
          docs: [
            'Authority\'s discretion (typically `fee_vault` for ONyc, treasury for USDC).',
          ]
          writable: true
        },
        {
          name: 'tokenProgram'
        },
      ]
      args: [
        {
          name: 'amount'
          type: 'u64'
        },
      ]
    },
    {
      name: 'unlockOnyc'
      docs: [
        'Release ONyc from NTT custody and record a `Flow` receipt for the',
        'withdrawal initiator.',
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
          name: 'relayerConfig'
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
                  95,
                  99,
                  111,
                  110,
                  102,
                  105,
                  103,
                ]
              },
            ]
          }
        },
        {
          name: 'relayerAuthority'
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114,
                ]
              },
            ]
          }
        },
        {
          name: 'onycMint'
          relations: [
            'relayerConfig',
          ]
        },
        {
          name: 'onycAta'
          writable: true
          pda: {
            seeds: [
              {
                kind: 'account'
                path: 'relayerAuthority'
              },
              {
                kind: 'account'
                path: 'tokenProgram'
              },
              {
                kind: 'account'
                path: 'onycMint'
              },
            ]
            program: {
              kind: 'const'
              value: [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89,
              ]
            }
          }
        },
        {
          name: 'nttInboxItem'
          docs: [
            'Per-VAA NTT inbox-item PDA — its pubkey seeds the flow PDA.',
          ]
        },
        {
          name: 'nttTransceiverMessage'
          docs: [
            '`fogo_sender` is parsed from this already-validated bytes. `owner`',
            'pins the writer to NTT (== transceiver in OnRe\'s deployment), so',
            'nothing outside NTT can have crafted this data.',
          ]
        },
        {
          name: 'outflightFlow'
          docs: [
            '`init` blocks replay (same NTT inbox → same PDA → already exists).',
          ]
          writable: true
          pda: {
            seeds: [
              {
                kind: 'const'
                value: [
                  111,
                  117,
                  116,
                  102,
                  108,
                  105,
                  103,
                  104,
                  116,
                ]
              },
              {
                kind: 'account'
                path: 'nttInboxItem'
              },
            ]
          }
        },
        {
          name: 'tokenProgram'
        },
        {
          name: 'systemProgram'
          address: '11111111111111111111111111111111'
        },
      ]
      args: [
        {
          name: 'redeemAccountsLen'
          type: 'u8'
        },
      ]
    },
  ]
  accounts: [
    {
      name: 'flow'
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
      name: 'redemptionTracker'
      discriminator: [
        1,
        150,
        121,
        192,
        138,
        107,
        94,
        3,
      ]
    },
    {
      name: 'relayerConfig'
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
  events: [
    {
      name: 'onycLocked'
      discriminator: [
        204,
        229,
        7,
        145,
        121,
        187,
        201,
        215,
      ]
    },
    {
      name: 'onycSwapped'
      discriminator: [
        220,
        205,
        135,
        206,
        94,
        131,
        34,
        57,
      ]
    },
    {
      name: 'onycUnlocked'
      discriminator: [
        66,
        7,
        6,
        253,
        214,
        174,
        42,
        160,
      ]
    },
    {
      name: 'redemptionCancelled'
      discriminator: [
        22,
        106,
        118,
        26,
        83,
        110,
        71,
        174,
      ]
    },
    {
      name: 'redemptionClaimed'
      discriminator: [
        107,
        251,
        199,
        213,
        59,
        173,
        53,
        189,
      ]
    },
    {
      name: 'redemptionRequested'
      discriminator: [
        245,
        155,
        98,
        131,
        210,
        25,
        137,
        146,
      ]
    },
    {
      name: 'usdcClaimed'
      discriminator: [
        213,
        24,
        255,
        203,
        163,
        162,
        154,
        137,
      ]
    },
    {
      name: 'usdcSentToUser'
      discriminator: [
        175,
        37,
        177,
        185,
        231,
        238,
        242,
        73,
      ]
    },
    {
      name: 'usdcSwapped'
      discriminator: [
        146,
        221,
        3,
        190,
        76,
        26,
        133,
        81,
      ]
    },
  ]
  errors: [
    {
      code: 6000
      name: 'invalidVaa'
      msg: 'VAA verification failed or VAA is invalid'
    },
    {
      code: 6001
      name: 'invalidAccountSplit'
      msg: 'remaining_accounts split point is out of range'
    },
    {
      code: 6002
      name: 'authorityNotInAccounts'
      msg: 'Relayer authority PDA not present in forwarded CPI accounts'
    },
    {
      code: 6003
      name: 'vaaPayloadTooShort'
      msg: 'VAA payload is shorter than the expected fogo_sender field'
    },
    {
      code: 6004
      name: 'zeroFogoSender'
      msg: 'Parsed fogo_sender is the zero address'
    },
    {
      code: 6005
      name: 'unauthorizedAuthority'
      msg: 'Caller is not the authority'
    },
    {
      code: 6006
      name: 'flowStatusMismatch'
      msg: 'Flow is not in the expected status for this operation'
    },
    {
      code: 6007
      name: 'balanceUnderflow'
      msg: 'Post-CPI balance is less than pre-CPI balance'
    },
    {
      code: 6008
      name: 'zeroAmountFlow'
      msg: 'Bridge or swap produced zero tokens'
    },
    {
      code: 6009
      name: 'feeBpsTooHigh'
      msg: 'Fee basis points exceed maximum (10000 = 100%)'
    },
    {
      code: 6010
      name: 'feeOverflow'
      msg: 'Fee computation overflow'
    },
    {
      code: 6011
      name: 'missingSessionAuthority'
      msg: 'NTT session authority PDA not found in remaining_accounts'
    },
    {
      code: 6012
      name: 'invalidTransceiverMessage'
      msg: 'NTT ValidatedTransceiverMessage account is malformed or too short'
    },
    {
      code: 6013
      name: 'transceiverMessageMismatch'
      msg: 'ntt_transceiver_message does not match the account consumed by the NTT redeem CPI'
    },
    {
      code: 6014
      name: 'inboxItemMismatch'
      msg: 'ntt_inbox_item does not match the account consumed by the NTT CPIs'
    },
    {
      code: 6015
      name: 'recipientAtaMismatch'
      msg: 'Destination token account does not match the ATA consumed by the NTT release CPI'
    },
    {
      code: 6016
      name: 'postedVaaMismatch'
      msg: 'posted_vaa does not match the VAA consumed by the Token Bridge CPI'
    },
    {
      code: 6017
      name: 'gatewayClaimMismatch'
      msg: 'gateway_claim does not match the claim PDA consumed by the Token Bridge CPI'
    },
    {
      code: 6018
      name: 'feeVaultAliasesUserAta'
      msg: 'fee_vault must not alias the relayer\'s ONyc operating ATA'
    },
    {
      code: 6019
      name: 'noPendingAuthority'
      msg: 'No pending authority — nothing to accept'
    },
    {
      code: 6020
      name: 'pendingAuthorityMismatch'
      msg: 'Signer does not match relayer_config.pending_authority'
    },
    {
      code: 6021
      name: 'redemptionNotFulfilled'
      msg: 'OnRe RedemptionRequest PDA still exists — redemption_admin has not fulfilled yet'
    },
    {
      code: 6022
      name: 'redemptionRequestMismatch'
      msg: 'Provided redemption_request account does not match tracker.redemption_request'
    },
    {
      code: 6023
      name: 'redemptionTrackerFlowMismatch'
      msg: 'RedemptionTracker.flow does not match the bound Flow PDA'
    },
    {
      code: 6024
      name: 'missingRedemptionState'
      msg: 'RedemptionTracker missing or unexpected for this flow status'
    },
  ]
  types: [
    {
      name: 'flow'
      docs: [
        'One-shot receipt binding an inbound bridge message to a FOGO user wallet.',
        'Used by both legs — direction is implicit in the seed prefix',
        '(`FLOW_INBOUND_SEED` vs `FLOW_OUTBOUND_SEED`).',
        '',
        'PDA seeds: `[FLOW_*_SEED, bridge_claim_pda.key()]`. Uniqueness and replay',
        'protection are delegated to the per-VAA claim account created by Wormhole',
        'Gateway / NTT — no hashing needed here.',
        '',
        '**Field set is byte-stable across the withdraw redesign**. Withdraw-chain',
        'redemption tracking lives in the sidecar `RedemptionTracker` PDA below',
        'rather than as new fields here, to preserve compatibility with any',
        'already-allocated `Flow` PDAs.',
      ]
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'fogoSender'
            docs: [
              'Originator on FOGO; becomes the outbound recipient on the return leg.',
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
            type: {
              defined: {
                name: 'flowStatus'
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
              'Receives rent on close.',
            ]
            type: 'pubkey'
          },
          {
            name: 'bump'
            type: 'u8'
          },
        ]
      }
    },
    {
      name: 'flowStatus'
      type: {
        kind: 'enum'
        variants: [
          {
            name: 'claimed'
          },
          {
            name: 'swapped'
          },
          {
            name: 'redemptionPending'
          },
        ]
      }
    },
    {
      name: 'onycLocked'
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'flow'
            type: 'pubkey'
          },
          {
            name: 'gatewayClaim'
            type: 'pubkey'
          },
          {
            name: 'fogoSender'
            type: {
              array: [
                'u8',
                32,
              ]
            }
          },
          {
            name: 'amount'
            type: 'u64'
          },
        ]
      }
    },
    {
      name: 'onycSwapped'
      docs: [
        '`gross_amount` = ONyc received from OnRe; `fee_amount` = deposit fee',
        'retained; `net_amount` = ONyc recorded on Flow (== amount the eventual',
        '`lock_onyc` ships back to FOGO).',
      ]
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'flow'
            type: 'pubkey'
          },
          {
            name: 'grossAmount'
            type: 'u64'
          },
          {
            name: 'feeAmount'
            type: 'u64'
          },
          {
            name: 'netAmount'
            type: 'u64'
          },
        ]
      }
    },
    {
      name: 'onycUnlocked'
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'flow'
            type: 'pubkey'
          },
          {
            name: 'nttInboxItem'
            type: 'pubkey'
          },
          {
            name: 'fogoSender'
            type: {
              array: [
                'u8',
                32,
              ]
            }
          },
          {
            name: 'amount'
            type: 'u64'
          },
        ]
      }
    },
    {
      name: 'redemptionCancelled'
      docs: [
        'Withdraw chain — emitted by `cancel_redemption_onyc` when the authority',
        'aborts an in-flight OnRe redemption (e.g. stuck `redemption_admin`,',
        'kill-switch, KYC issue). `returned_onyc_amount` is the ONyc that OnRe',
        'has unlocked back into the relayer\'s `onyc_ata` and is now re-recorded',
        'on the flow as `flow.amount` with status rolled back to `Claimed`.',
        'Note: the withdraw fee taken by `request_redemption_onyc` is NOT',
        'refunded by this path — operator off-chain reconciliation handles dust.',
      ]
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'flow'
            type: 'pubkey'
          },
          {
            name: 'redemptionRequest'
            type: 'pubkey'
          },
          {
            name: 'returnedOnycAmount'
            type: 'u64'
          },
        ]
      }
    },
    {
      name: 'redemptionClaimed'
      docs: [
        'Withdraw chain — emitted by `claim_redemption_usdc` after OnRe has',
        'fulfilled and we\'ve recorded the USDC delta on the flow. `usdc_received`',
        'is the post-fulfillment ATA delta and the amount `send_usdc_to_user`',
        'will ship back to FOGO.',
      ]
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'flow'
            type: 'pubkey'
          },
          {
            name: 'redemptionRequest'
            type: 'pubkey'
          },
          {
            name: 'onycAmountIn'
            type: 'u64'
          },
          {
            name: 'usdcReceived'
            type: 'u64'
          },
        ]
      }
    },
    {
      name: 'redemptionRequested'
      docs: [
        'Withdraw chain — emitted by `request_redemption_onyc` when ONyc has been',
        'forwarded to OnRe and the singleton tracker is initialised.',
        '`redemption_request` is the OnRe `RedemptionRequest` PDA we\'ll poll.',
      ]
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'flow'
            type: 'pubkey'
          },
          {
            name: 'redemptionRequest'
            type: 'pubkey'
          },
          {
            name: 'grossAmount'
            type: 'u64'
          },
          {
            name: 'feeAmount'
            type: 'u64'
          },
          {
            name: 'netAmount'
            type: 'u64'
          },
          {
            name: 'usdcAtaPreBalance'
            type: 'u64'
          },
        ]
      }
    },
    {
      name: 'redemptionTracker'
      docs: [
        'Singleton sidecar PDA tracking the in-flight withdraw-chain redemption.',
        '',
        'PDA seeds: `[REDEMPTION_TRACKER_SEED]` (no per-flow discriminator —',
        'only one withdraw redemption may be in flight across the whole program',
        'at a time). The PDA\'s existence is the in-flight mutex: `init` in',
        '`request_redemption_onyc` fails if another redemption is mid-flight,',
        'preventing the USDC-delta race where two flows would otherwise read the',
        'combined balance change as their own.',
        '',
        'Created by `request_redemption_onyc`; closed by `claim_redemption_usdc`',
        '(rent → `payer`). Never exists on the deposit chain.',
        '',
        'See `docs/WITHDRAW_REDESIGN.md` §2.2.',
      ]
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'flow'
            docs: [
              'Outbound `Flow` PDA this tracker is bound to. Pinned by',
              '`claim_redemption_usdc` via `tracker.flow == flow.key()`.',
            ]
            type: 'pubkey'
          },
          {
            name: 'redemptionRequest'
            docs: [
              'OnRe `RedemptionRequest` PDA we created. The relayer polls for its',
              'closure as the fulfillment signal — when this account no longer',
              'exists on chain, OnRe\'s `redemption_admin` has fulfilled.',
            ]
            type: 'pubkey'
          },
          {
            name: 'usdcAtaPreBalance'
            docs: [
              'Relayer\'s USDC ATA balance snapshotted *before*',
              '`create_redemption_request` fires. `claim_redemption_usdc` computes',
              'the post-fulfillment delta against this. Safe under the singleton',
              'constraint above — no sibling redemption can pollute the delta.',
            ]
            type: 'u64'
          },
          {
            name: 'onycAmountIn'
            docs: [
              'ONyc amount net-of-fee that we sent to OnRe. Audit-trail field;',
              'not consumed by `claim_redemption_usdc` today, but emitted in events.',
            ]
            type: 'u64'
          },
          {
            name: 'payer'
            docs: [
              'Pays for init, receives rent on close. Set to whoever called',
              '`request_redemption_onyc`; may differ from the `claim_redemption_usdc`',
              'caller.',
            ]
            type: 'pubkey'
          },
          {
            name: 'bump'
            type: 'u8'
          },
        ]
      }
    },
    {
      name: 'relayerConfig'
      docs: [
        'The only long-lived state in this program.',
        '',
        '`authority` is a cold/admin key used only for governance. All operational',
        'instructions are permissionless — recipients are VAA-bound, amounts are',
        'flow-bound, and CPI targets are compile-time constants.',
      ]
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'authority'
            type: 'pubkey'
          },
          {
            name: 'pendingAuthority'
            docs: [
              'Two-step rotation accommodates multisig→multisig handoffs where the two',
              'parties cannot atomically co-sign (e.g. two independent Squads vaults).',
              '`None` when no rotation is in flight; set by `configure(new_authority)`,',
              'promoted to `authority` by a separate `accept_authority` tx from this key.',
            ]
            type: {
              option: 'pubkey'
            }
          },
          {
            name: 'usdcMint'
            type: 'pubkey'
          },
          {
            name: 'onycMint'
            type: 'pubkey'
          },
          {
            name: 'feeVault'
            docs: [
              'Single PDA-addressed token account holding ALL accumulated fees from',
              'both legs (denominated in ONyc).',
            ]
            type: 'pubkey'
          },
          {
            name: 'bump'
            type: 'u8'
          },
          {
            name: 'relayerAuthorityBump'
            type: 'u8'
          },
          {
            name: 'depositFeeBps'
            docs: [
              'Deposit-leg fee in bps (1 bps = 0.01%).',
            ]
            type: 'u16'
          },
          {
            name: 'withdrawFeeBps'
            docs: [
              'Withdrawal-leg fee in bps.',
            ]
            type: 'u16'
          },
        ]
      }
    },
    {
      name: 'usdcClaimed'
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'flow'
            type: 'pubkey'
          },
          {
            name: 'gatewayClaim'
            type: 'pubkey'
          },
          {
            name: 'fogoSender'
            type: {
              array: [
                'u8',
                32,
              ]
            }
          },
          {
            name: 'amount'
            type: 'u64'
          },
        ]
      }
    },
    {
      name: 'usdcSentToUser'
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'flow'
            type: 'pubkey'
          },
          {
            name: 'nttInboxItem'
            type: 'pubkey'
          },
          {
            name: 'fogoSender'
            type: {
              array: [
                'u8',
                32,
              ]
            }
          },
          {
            name: 'amount'
            type: 'u64'
          },
        ]
      }
    },
    {
      name: 'usdcSwapped'
      docs: [
        '`gross_amount` = ONyc input (== flow.amount from `unlock_onyc`);',
        '`fee_amount` = withdrawal fee taken pre-swap; `net_amount` = ONyc',
        'actually swapped; `usdc_received` = USDC recorded on Flow.',
      ]
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'flow'
            type: 'pubkey'
          },
          {
            name: 'grossAmount'
            type: 'u64'
          },
          {
            name: 'feeAmount'
            type: 'u64'
          },
          {
            name: 'netAmount'
            type: 'u64'
          },
          {
            name: 'usdcReceived'
            type: 'u64'
          },
        ]
      }
    },
  ]
}
