/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/fogo_onre_relayer.json`.
 */
export type FogoOnreRelayer = {
  "address": "onrenRKgX54qtWeK3cuaTBE71xx7dWMXn82ubH61vAp",
  "metadata": {
    "name": "fogoOnreRelayer",
    "version": "0.1.2",
    "spec": "0.1.0",
    "description": "Fogo OnRe relayer — stateless PDA-custody bridge between OnRe and Wormhole NTT on Solana",
    "repository": "https://github.com/pointgroup-labs/fogo-onre"
  },
  "docs": [
    "On-chain relayer for OnRe's cross-chain yield product.",
    "",
    "OnRe issues ONyc, a tokenized reinsurance position on Solana. This",
    "program lets FOGO users hold that yield exposure without leaving",
    "FOGO: USDC.s on FOGO ↔ ONyc on Solana, both legs over Wormhole NTT."
  ],
  "instructions": [
    {
      "name": "acceptAuthority",
      "docs": [
        "Two-step rotation, step two. Signer must equal",
        "`relayer_config.pending_authority`. Current authority does NOT",
        "participate — by design, so two independent multisigs can rotate",
        "without atomic cross-multisig coordination."
      ],
      "discriminator": [
        107,
        86,
        198,
        91,
        33,
        12,
        107,
        160
      ],
      "accounts": [
        {
          "name": "pendingAuthority",
          "signer": true
        },
        {
          "name": "relayerConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
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
                  103
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "cancelRedemptionOnyc",
      "docs": [
        "Authority-only escape hatch. Aborts an in-flight OnRe redemption",
        "(returns ONyc to `onyc_ata`, rolls flow back to `Claimed`, frees",
        "the singleton). Authority-gated to prevent the",
        "request→cancel→request fee-griefing loop a permissionless cancel",
        "would enable."
      ],
      "discriminator": [
        173,
        168,
        252,
        110,
        16,
        149,
        112,
        62
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "relayerConfig"
          ]
        },
        {
          "name": "relayerConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
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
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "relayerAuthority",
          "docs": [
            "inside `redemption_request` (OnRe enforces this), so the unlocked",
            "ONyc returns to its `onyc_ata`."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              }
            ]
          }
        },
        {
          "name": "onycMint",
          "relations": [
            "relayerConfig"
          ]
        },
        {
          "name": "onycAta",
          "docs": [
            "Receives the unlocked ONyc back from OnRe's redemption vault."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "relayerAuthority"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "onycMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
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
                89
              ]
            }
          }
        },
        {
          "name": "nttInboxItem"
        },
        {
          "name": "outflightFlow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  117,
                  116,
                  102,
                  108,
                  105,
                  103,
                  104,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "nttInboxItem"
              }
            ]
          }
        },
        {
          "name": "redemptionTracker",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
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
                  114
                ]
              }
            ]
          }
        },
        {
          "name": "payerForClose",
          "docs": [
            "init-time payer always gets rent back."
          ],
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": []
    },
    {
      "name": "claimRedemptionUsdc",
      "discriminator": [
        171,
        90,
        50,
        244,
        156,
        19,
        211,
        106
      ],
      "accounts": [
        {
          "name": "cranker",
          "docs": [
            "Receives rent from the closed `redemption_tracker`. Need not equal",
            "`tracker.payer` — close-target is pinned by `payer_for_close` below."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "relayerConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
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
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "relayerAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "relations": [
            "relayerConfig"
          ]
        },
        {
          "name": "usdcAta",
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "relayerAuthority"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "usdcMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
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
                89
              ]
            }
          }
        },
        {
          "name": "nttInboxItem"
        },
        {
          "name": "outflightFlow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  117,
                  116,
                  102,
                  108,
                  105,
                  103,
                  104,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "nttInboxItem"
              }
            ]
          }
        },
        {
          "name": "redemptionTracker",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
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
                  114
                ]
              }
            ]
          }
        },
        {
          "name": "payerForClose",
          "writable": true
        },
        {
          "name": "redemptionRequest",
          "docs": [
            "it has been closed by OnRe's `fulfill_redemption_request`."
          ]
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": []
    },
    {
      "name": "claimUsdc",
      "docs": [
        "Redeem bridged USDC.s from FOGO via NTT and create an inflight `Flow`",
        "receipt binding the eventual ONyc return to the originator's FOGO",
        "wallet."
      ],
      "discriminator": [
        43,
        131,
        9,
        102,
        229,
        140,
        91,
        141
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "relayerConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
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
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "relayerAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "relations": [
            "relayerConfig"
          ]
        },
        {
          "name": "usdcAta",
          "docs": [
            "Sweep destination — long-lived relayer-authority USDC ATA."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "relayerAuthority"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "usdcMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
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
                89
              ]
            }
          }
        },
        {
          "name": "userWallet",
          "docs": [
            "Originating FOGO wallet (same pubkey on Solana — keys are chain-agnostic).",
            "Cranker-supplied; pinned by the `user_inbox_authority` PDA derivation",
            "below + the NTT release ATA-authority check chain. See handler doc."
          ]
        },
        {
          "name": "userInboxAuthority",
          "docs": [
            "Per-user inbox PDA. Owns `user_inbox_ata`; signs the sweep."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  115,
                  101,
                  114,
                  95,
                  105,
                  110,
                  98,
                  111,
                  120
                ]
              },
              {
                "kind": "account",
                "path": "userWallet"
              }
            ]
          }
        },
        {
          "name": "userInboxAta",
          "docs": [
            "Per-user inbox USDC ATA. NTT release_inbound deposits here; the",
            "sweep transfers exactly `flow.amount` out into `usdc_ata`.",
            "`init_if_needed` is NOT used here — the FOGO `bridge_ntt_tokens`",
            "arg `pay_destination_ata_rent: true` causes the Wormhole",
            "executor to create the ATA on first delivery."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "userInboxAuthority"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "usdcMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
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
                89
              ]
            }
          }
        },
        {
          "name": "nttInboxItem",
          "docs": [
            "Per-VAA NTT inbox-item PDA — its pubkey seeds the flow PDA.",
            "We deliberately do NOT put `#[account(owner = NTT_USDC_PROGRAM_ID)]`",
            "here: on a fresh claim the account doesn't exist yet (the NTT",
            "redeem CPI inside the handler creates it), so Anchor's",
            "pre-handler owner constraint would fail every first-time claim.",
            "The owner check is enforced inside the handler's",
            "`inbox_already_released` skip branch — the *only* path where",
            "no NTT CPI runs and forgery is therefore possible."
          ]
        },
        {
          "name": "nttTransceiverMessage",
          "docs": [
            "`owner = NTT_USDC_PROGRAM_ID` pins the writer; nothing outside NTT can",
            "have crafted this data."
          ]
        },
        {
          "name": "inflightFlow",
          "docs": [
            "`init` blocks double-claims against the same NTT inbox item."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  102,
                  108,
                  105,
                  103,
                  104,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "nttInboxItem"
              }
            ]
          }
        },
        {
          "name": "redemptionTracker",
          "docs": [
            "Withdraw-chain mutex gate. `SystemAccount` asserts",
            "`owner == system_program::ID`, true iff the singleton",
            "`RedemptionTracker` PDA does NOT currently exist — pausing deposit",
            "USDC inflows so they can't pollute `claim_redemption_usdc`'s",
            "snapshot/delta math."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
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
                  114
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "redeemAccountsLen",
          "type": "u8"
        }
      ]
    },
    {
      "name": "configure",
      "docs": [
        "Authority-only. `None` args leave the corresponding field unchanged.",
        "Fee decreases apply instantly; increases stage into `pending_fee`",
        "for `FEE_TIMELOCK_SLOTS` (~2 days), auto-promoted on the next",
        "`configure` call after the window elapses."
      ],
      "discriminator": [
        245,
        7,
        108,
        117,
        95,
        196,
        54,
        217
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true,
          "relations": [
            "relayerConfig"
          ]
        },
        {
          "name": "relayerConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
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
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "relayerAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              }
            ]
          }
        },
        {
          "name": "onycMint",
          "relations": [
            "relayerConfig"
          ]
        },
        {
          "name": "onycAta",
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "relayerAuthority"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "onycMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
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
                89
              ]
            }
          }
        },
        {
          "name": "feeVault",
          "docs": [
            "`None` leaves the stored vault unchanged; anti-aliasing check runs",
            "in the handler."
          ],
          "optional": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "depositFeeBps",
          "type": {
            "option": "u16"
          }
        },
        {
          "name": "withdrawFeeBps",
          "type": {
            "option": "u16"
          }
        },
        {
          "name": "newAuthority",
          "type": {
            "option": "pubkey"
          }
        }
      ]
    },
    {
      "name": "initialize",
      "docs": [
        "One-time setup: create config PDA + relayer-authority-owned ATAs."
      ],
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "relayerConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
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
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "relayerAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "onycMint"
        },
        {
          "name": "usdcAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "relayerAuthority"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "usdcMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
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
                89
              ]
            }
          }
        },
        {
          "name": "onycAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "relayerAuthority"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "onycMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
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
                89
              ]
            }
          }
        },
        {
          "name": "feeVault",
          "docs": [
            "Anti-aliasing constraint: forbidding `fee_vault == onyc_ata`",
            "prevents silent self-transfer no-ops that would commingle user",
            "funds with fees and defeat the vault split."
          ]
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "depositFeeBps",
          "type": "u16"
        },
        {
          "name": "withdrawFeeBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "lockOnyc",
      "docs": [
        "Lock ONyc via NTT and atomically publish the outbound Wormhole VAA,",
        "sending ONyc to `flow.fogo_sender`. Closes the PDA.",
        "",
        "`transfer_lock_account_count` is the boundary index in",
        "`remaining_accounts` between the `transfer_lock` (14 entries) and",
        "`release_wormhole_outbound` (15 entries) account lists."
      ],
      "discriminator": [
        4,
        104,
        99,
        210,
        97,
        143,
        190,
        63
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "relayerConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
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
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "relayerAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              }
            ]
          }
        },
        {
          "name": "onycMint",
          "relations": [
            "relayerConfig"
          ]
        },
        {
          "name": "onycAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "relayerAuthority"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "onycMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
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
                89
              ]
            }
          }
        },
        {
          "name": "nttInboxItem"
        },
        {
          "name": "inflightFlow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  102,
                  108,
                  105,
                  103,
                  104,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "nttInboxItem"
              }
            ]
          }
        },
        {
          "name": "rentDestination",
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "transferLockAccountCount",
          "type": "u8"
        }
      ]
    },
    {
      "name": "requestRedemptionOnyc",
      "docs": [
        "Forward flow's ONyc to OnRe via `create_redemption_request` and",
        "init the singleton tracker. Fee taken pre-CPI."
      ],
      "discriminator": [
        117,
        2,
        5,
        175,
        6,
        12,
        151,
        176
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "relayerConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
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
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "relayerAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "relations": [
            "relayerConfig"
          ]
        },
        {
          "name": "onycMint",
          "relations": [
            "relayerConfig"
          ]
        },
        {
          "name": "usdcAta",
          "docs": [
            "Pre-balance snapshot source for the `claim_redemption_usdc` delta.",
            "Boxed for stack budget."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "relayerAuthority"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "usdcMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
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
                89
              ]
            }
          }
        },
        {
          "name": "onycAta",
          "docs": [
            "Source of the fee transfer; OnRe's CPI also pulls from here. Boxed",
            "for stack budget."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "relayerAuthority"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "onycMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
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
                89
              ]
            }
          }
        },
        {
          "name": "feeVault",
          "writable": true,
          "relations": [
            "relayerConfig"
          ]
        },
        {
          "name": "nttInboxItem"
        },
        {
          "name": "outflightFlow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  117,
                  116,
                  102,
                  108,
                  105,
                  103,
                  104,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "nttInboxItem"
              }
            ]
          }
        },
        {
          "name": "redemptionTracker",
          "docs": [
            "Singleton init — fails if any prior redemption is still in flight.",
            "On-chain mutex that makes the ATA-delta math safe."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
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
                  114
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "sendUsdcToUser",
      "discriminator": [
        34,
        19,
        226,
        203,
        16,
        87,
        167,
        249
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "relayerConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
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
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "relayerAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "relations": [
            "relayerConfig"
          ]
        },
        {
          "name": "usdcAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "relayerAuthority"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "usdcMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
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
                89
              ]
            }
          }
        },
        {
          "name": "nttInboxItem"
        },
        {
          "name": "outflightFlow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  117,
                  116,
                  102,
                  108,
                  105,
                  103,
                  104,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "nttInboxItem"
              }
            ]
          }
        },
        {
          "name": "rentDestination",
          "writable": true
        },
        {
          "name": "redemptionTracker",
          "docs": [
            "Singleton redemption tracker slot — must NOT currently exist. While",
            "any `RedemptionTracker` is alive, a sibling flow may be mid-redemption",
            "with its pre-balance snapshot pinned against this `usdc_ata`. A",
            "concurrent outflow here would poison that delta, causing",
            "`BalanceUnderflow` or silent user under-credit. Stuck redemptions",
            "are covered by `cancel_redemption_onyc` — deliberate",
            "correctness-over-latency trade."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
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
                  114
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": []
    },
    {
      "name": "swapUsdcToOnyc",
      "discriminator": [
        88,
        26,
        182,
        123,
        92,
        54,
        57,
        55
      ],
      "accounts": [
        {
          "name": "relayerConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
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
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "relayerAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "relations": [
            "relayerConfig"
          ]
        },
        {
          "name": "onycMint",
          "relations": [
            "relayerConfig"
          ]
        },
        {
          "name": "usdcAta",
          "docs": [
            "Boxed for stack budget."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "relayerAuthority"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "usdcMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
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
                89
              ]
            }
          }
        },
        {
          "name": "onycAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "relayerAuthority"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "onycMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
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
                89
              ]
            }
          }
        },
        {
          "name": "feeVault",
          "writable": true,
          "relations": [
            "relayerConfig"
          ]
        },
        {
          "name": "redemptionTracker",
          "docs": [
            "Withdraw-chain mutex gate. While a withdraw redemption is in flight",
            "this fails, pausing deposits so `claim_redemption_usdc`'s",
            "snapshot/delta math stays correct."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
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
                  114
                ]
              }
            ]
          }
        },
        {
          "name": "nttInboxItem"
        },
        {
          "name": "inflightFlow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  110,
                  102,
                  108,
                  105,
                  103,
                  104,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "nttInboxItem"
              }
            ]
          }
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": []
    },
    {
      "name": "unlockOnyc",
      "docs": [
        "Release ONyc from NTT custody and record a `Flow` receipt for the",
        "withdrawal initiator."
      ],
      "discriminator": [
        225,
        208,
        126,
        107,
        209,
        43,
        111,
        166
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "relayerConfig",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
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
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "relayerAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              }
            ]
          }
        },
        {
          "name": "onycMint",
          "relations": [
            "relayerConfig"
          ]
        },
        {
          "name": "onycAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "relayerAuthority"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "onycMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
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
                89
              ]
            }
          }
        },
        {
          "name": "nttInboxItem",
          "docs": [
            "Per-VAA NTT inbox-item PDA — its pubkey seeds the flow PDA."
          ]
        },
        {
          "name": "nttTransceiverMessage",
          "docs": [
            "`owner = NTT_ONYC_PROGRAM_ID` pins the writer; nothing outside NTT can",
            "have crafted this data."
          ]
        },
        {
          "name": "outflightFlow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  117,
                  116,
                  102,
                  108,
                  105,
                  103,
                  104,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "nttInboxItem"
              }
            ]
          }
        },
        {
          "name": "tokenProgram"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "redeemAccountsLen",
          "type": "u8"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "flow",
      "discriminator": [
        126,
        151,
        86,
        177,
        58,
        153,
        167,
        203
      ]
    },
    {
      "name": "redemptionTracker",
      "discriminator": [
        1,
        150,
        121,
        192,
        138,
        107,
        94,
        3
      ]
    },
    {
      "name": "relayerConfig",
      "discriminator": [
        116,
        239,
        42,
        132,
        218,
        154,
        194,
        20
      ]
    }
  ],
  "events": [
    {
      "name": "onycLocked",
      "discriminator": [
        204,
        229,
        7,
        145,
        121,
        187,
        201,
        215
      ]
    },
    {
      "name": "onycSwapped",
      "discriminator": [
        220,
        205,
        135,
        206,
        94,
        131,
        34,
        57
      ]
    },
    {
      "name": "onycUnlocked",
      "discriminator": [
        66,
        7,
        6,
        253,
        214,
        174,
        42,
        160
      ]
    },
    {
      "name": "redemptionCancelled",
      "discriminator": [
        22,
        106,
        118,
        26,
        83,
        110,
        71,
        174
      ]
    },
    {
      "name": "redemptionClaimed",
      "discriminator": [
        107,
        251,
        199,
        213,
        59,
        173,
        53,
        189
      ]
    },
    {
      "name": "redemptionRequested",
      "discriminator": [
        245,
        155,
        98,
        131,
        210,
        25,
        137,
        146
      ]
    },
    {
      "name": "usdcClaimed",
      "discriminator": [
        213,
        24,
        255,
        203,
        163,
        162,
        154,
        137
      ]
    },
    {
      "name": "usdcSentToUser",
      "discriminator": [
        175,
        37,
        177,
        185,
        231,
        238,
        242,
        73
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "invalidAccountSplit",
      "msg": "remaining_accounts split point is out of range"
    },
    {
      "code": 6001,
      "name": "authorityNotInAccounts",
      "msg": "Relayer authority PDA not present in forwarded CPI accounts"
    },
    {
      "code": 6002,
      "name": "zeroFogoSender",
      "msg": "Parsed fogo_sender is the zero address"
    },
    {
      "code": 6003,
      "name": "unauthorizedAuthority",
      "msg": "Caller is not the authority"
    },
    {
      "code": 6004,
      "name": "flowStatusMismatch",
      "msg": "Flow is not in the expected status for this operation"
    },
    {
      "code": 6005,
      "name": "balanceUnderflow",
      "msg": "Post-CPI balance is less than pre-CPI balance"
    },
    {
      "code": 6006,
      "name": "zeroAmountFlow",
      "msg": "Bridge or swap produced zero tokens"
    },
    {
      "code": 6007,
      "name": "feeBpsTooHigh",
      "msg": "Fee basis points exceed MAX_FEE_BPS"
    },
    {
      "code": 6008,
      "name": "feeOverflow",
      "msg": "Fee computation overflow"
    },
    {
      "code": 6009,
      "name": "missingSessionAuthority",
      "msg": "NTT session authority PDA not found in remaining_accounts"
    },
    {
      "code": 6010,
      "name": "invalidTransceiverMessage",
      "msg": "NTT ValidatedTransceiverMessage account is malformed or too short"
    },
    {
      "code": 6011,
      "name": "transceiverMessageMismatch",
      "msg": "ntt_transceiver_message does not match the account consumed by the NTT redeem CPI"
    },
    {
      "code": 6012,
      "name": "inboxItemMismatch",
      "msg": "ntt_inbox_item does not match the account consumed by the NTT CPIs"
    },
    {
      "code": 6013,
      "name": "recipientAtaMismatch",
      "msg": "Destination token account does not match the ATA consumed by the NTT release CPI"
    },
    {
      "code": 6014,
      "name": "feeVaultAliasesUserAta",
      "msg": "fee_vault must not alias the relayer's ONyc operating ATA"
    },
    {
      "code": 6015,
      "name": "noPendingAuthority",
      "msg": "No pending authority — nothing to accept"
    },
    {
      "code": 6016,
      "name": "pendingAuthorityMismatch",
      "msg": "Signer does not match relayer_config.pending_authority"
    },
    {
      "code": 6017,
      "name": "redemptionNotFulfilled",
      "msg": "OnRe RedemptionRequest PDA still exists — redemption_admin has not fulfilled yet"
    },
    {
      "code": 6018,
      "name": "redemptionRequestMismatch",
      "msg": "Provided redemption_request account does not match tracker.redemption_request"
    },
    {
      "code": 6019,
      "name": "redemptionTrackerFlowMismatch",
      "msg": "RedemptionTracker.flow does not match the bound Flow PDA"
    },
    {
      "code": 6020,
      "name": "emptyPendingFee",
      "msg": "PendingFee bundle has no inner leg set — invariant violation"
    },
    {
      "code": 6021,
      "name": "wrongOriginChain",
      "msg": "Inbound NTT message did not originate from the FOGO peer chain"
    },
    {
      "code": 6022,
      "name": "unexpectedOnycConsumed",
      "msg": "Post-CPI ONyc balance dropped — OnRe consumed ONyc unexpectedly"
    },
    {
      "code": 6023,
      "name": "userInboxAuthorityMismatch",
      "msg": "user_inbox_ata's authority does not match the [user_inbox, user_wallet] PDA"
    },
    {
      "code": 6024,
      "name": "unexpectedFogoSender",
      "msg": "NTT VAA's NttManagerMessage.sender is not the intent_transfer setter PDA — deposit must originate via intent_transfer"
    },
    {
      "code": 6025,
      "name": "invalidInboxItem",
      "msg": "ntt_inbox_item account is missing, too short, or has the wrong discriminator"
    },
    {
      "code": 6026,
      "name": "insufficientInboxBalance",
      "msg": "user_inbox_ata balance is below the NTT-recorded inbox_item.amount — inbox was not credited as expected"
    },
    {
      "code": 6027,
      "name": "pendingAuthorityIsCurrent",
      "msg": "Proposed pending_authority equals the current authority — self-rotate is rejected"
    }
  ],
  "types": [
    {
      "name": "flow",
      "docs": [
        "One-shot receipt binding an inbound bridge message to a FOGO wallet.",
        "Seeds: `[FLOW_*_SEED, bridge_claim_pda.key()]`. Replay protection",
        "lives in the per-VAA claim account from NTT. Field set is",
        "byte-stable — older PDAs must keep deserializing."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "fogoSender",
            "docs": [
              "Originator on FOGO; becomes the outbound recipient on the return leg."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "flowStatus"
              }
            }
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "payer",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "flowStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "claimed"
          },
          {
            "name": "swapped"
          },
          {
            "name": "redemptionPending"
          }
        ]
      }
    },
    {
      "name": "onycLocked",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "flow",
            "type": "pubkey"
          },
          {
            "name": "nttInboxItem",
            "type": "pubkey"
          },
          {
            "name": "fogoSender",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "onycSwapped",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "flow",
            "type": "pubkey"
          },
          {
            "name": "grossAmount",
            "type": "u64"
          },
          {
            "name": "feeAmount",
            "type": "u64"
          },
          {
            "name": "netAmount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "onycUnlocked",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "flow",
            "type": "pubkey"
          },
          {
            "name": "nttInboxItem",
            "type": "pubkey"
          },
          {
            "name": "fogoSender",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "pendingFee",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "depositFeeBps",
            "type": {
              "option": "u16"
            }
          },
          {
            "name": "withdrawFeeBps",
            "type": {
              "option": "u16"
            }
          },
          {
            "name": "readySlot",
            "docs": [
              "`now + FEE_TIMELOCK_SLOTS` at proposal time, MAX-extended on any",
              "later raise so a follow-up never shortens the window."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "redemptionCancelled",
      "docs": [
        "`returned_onyc_amount` is re-recorded on the flow as `flow.amount`",
        "with status rolled back to `Claimed`. The withdraw fee originally",
        "taken by `request_redemption_onyc` is NOT refunded by this path."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "flow",
            "type": "pubkey"
          },
          {
            "name": "redemptionRequest",
            "type": "pubkey"
          },
          {
            "name": "returnedOnycAmount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "redemptionClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "flow",
            "type": "pubkey"
          },
          {
            "name": "redemptionRequest",
            "type": "pubkey"
          },
          {
            "name": "onycAmountIn",
            "type": "u64"
          },
          {
            "name": "usdcReceived",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "redemptionRequested",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "flow",
            "type": "pubkey"
          },
          {
            "name": "redemptionRequest",
            "type": "pubkey"
          },
          {
            "name": "grossAmount",
            "type": "u64"
          },
          {
            "name": "feeAmount",
            "type": "u64"
          },
          {
            "name": "netAmount",
            "type": "u64"
          },
          {
            "name": "usdcAtaPreBalance",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "redemptionTracker",
      "docs": [
        "Singleton mutex for the in-flight withdraw-chain redemption.",
        "Seeds: `[REDEMPTION_TRACKER_SEED]`. `init` here fails if another",
        "redemption is mid-flight, blocking the USDC-delta race."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "flow",
            "docs": [
              "Outbound `Flow` this tracker is bound to."
            ],
            "type": "pubkey"
          },
          {
            "name": "redemptionRequest",
            "docs": [
              "OnRe `RedemptionRequest` PDA we created. Polled for closure as",
              "the fulfillment signal."
            ],
            "type": "pubkey"
          },
          {
            "name": "usdcAtaPreBalance",
            "docs": [
              "Relayer USDC ATA balance *before* `create_redemption_request`.",
              "`claim_redemption_usdc` uses the post-fulfillment delta vs this."
            ],
            "type": "u64"
          },
          {
            "name": "onycAmountIn",
            "docs": [
              "Audit-trail only — net-of-fee ONyc sent to OnRe."
            ],
            "type": "u64"
          },
          {
            "name": "payer",
            "docs": [
              "Pays for init, receives rent on close."
            ],
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "relayerConfig",
      "docs": [
        "Long-lived program state. `authority` gates governance only; flow",
        "instructions are permissionless."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "usdcMint",
            "type": "pubkey"
          },
          {
            "name": "onycMint",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "feeVault",
            "type": "pubkey"
          },
          {
            "name": "depositFeeBps",
            "type": "u16"
          },
          {
            "name": "withdrawFeeBps",
            "type": "u16"
          },
          {
            "name": "relayerAuthorityBump",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "pendingAuthority",
            "docs": [
              "Two-step rotation lets multisig→multisig handoffs work without",
              "atomic co-sign. Promoted to `authority` by `accept_authority`."
            ],
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "pendingFee",
            "docs": [
              "Staged fee *increase*, auto-promoted on the next `configure` once",
              "`ready_slot` elapses. Decreases bypass this. `Some` ⟹ at least one",
              "inner leg is `Some` (collapsed otherwise)."
            ],
            "type": {
              "option": {
                "defined": {
                  "name": "pendingFee"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "usdcClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "flow",
            "type": "pubkey"
          },
          {
            "name": "nttInboxItem",
            "type": "pubkey"
          },
          {
            "name": "fogoSender",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "usdcSentToUser",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "flow",
            "type": "pubkey"
          },
          {
            "name": "nttInboxItem",
            "type": "pubkey"
          },
          {
            "name": "fogoSender",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    }
  ],
  "constants": [
    {
      "name": "intentTransferProgramId",
      "docs": [
        "FOGO `intent_transfer` program ID. Pinned so `claim_usdc` can require",
        "that any incoming VAA was originated by intent_transfer (its singleton",
        "`intent_transfer_setter` PDA is the NTT message sender for every",
        "intent-driven bridge). Without this pin, a direct NTT bridge that",
        "happens to target a user's inbox PDA would also satisfy the deposit",
        "flow — annoying rather than dangerous, but the pin enforces the",
        "intended deposit path."
      ],
      "type": "pubkey",
      "value": "Xfry4dW9m42ncAqm8LyEnyS5V6xu5DSJTMRQLiGkARD"
    },
    {
      "name": "nttOnycProgramId",
      "type": "pubkey",
      "value": "nttpna5vXW7BN2Aa4AfTbkCncJWTEoBsnWvjS87Xgsd"
    },
    {
      "name": "nttUsdcProgramId",
      "type": "pubkey",
      "value": "nttu74CdAmsErx5daJVCQNoDZujswFrskMzonoZSdGk"
    },
    {
      "name": "onreProgramId",
      "type": "pubkey",
      "value": "onreuGhHHgVzMWSkj2oQDLDtvvGvoepBPkqyaubFcwe"
    },
    {
      "name": "wormholeCoreProgramId",
      "docs": [
        "Wormhole Core Bridge program id (mainnet). Pinned for documentation /",
        "future use by handlers that need to assert the wormhole-program account",
        "the release CPI receives. The release CPI itself is dispatched via",
        "`remaining_accounts`, so this constant isn't directly read by `lock_onyc`",
        "— it exists so off-chain tooling and any future on-chain assertion share",
        "one source of truth."
      ],
      "type": "pubkey",
      "value": "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth"
    }
  ]
};
