/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/fogo_ntt_relayer.json`.
 */
export type FogoNttRelayer = {
  "address": "onrenRKgX54qtWeK3cuaTBE71xx7dWMXn82ubH61vAp",
  "metadata": {
    "name": "fogoNttRelayer",
    "version": "0.3.0",
    "spec": "0.1.0",
    "description": "Cross-chain Wormhole NTT relayer with stateless PDA custody",
    "repository": "https://github.com/pointgroup-labs/fogo-onre"
  },
  "docs": [
    "Cross-chain relayer for a configured base/asset token pair over Wormhole",
    "NTT. User-facing flows are permissionless; governance is config-gated."
  ],
  "instructions": [
    {
      "name": "acceptAdmin",
      "docs": [
        "The pending admin claims the global admin role (step 2)."
      ],
      "discriminator": [
        112,
        42,
        45,
        90,
        116,
        181,
        13,
        170
      ],
      "accounts": [
        {
          "name": "pendingAdmin",
          "signer": true
        },
        {
          "name": "globalConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
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
      "name": "acceptAuthority",
      "docs": [
        "Two-step rotation, step 2. Signer must equal `pending_authority`;",
        "current authority does not sign (lets independent multisigs rotate",
        "without atomic co-sign)."
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
          "name": "pairConfig",
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
              },
              {
                "kind": "account",
                "path": "pair_config.base_mint",
                "account": "pairConfig"
              },
              {
                "kind": "account",
                "path": "pair_config.asset_mint",
                "account": "pairConfig"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "bootstrap",
      "docs": [
        "One-time deploy bootstrap: create the global config + set the admin."
      ],
      "discriminator": [
        101,
        108,
        31,
        241,
        5,
        211,
        182,
        72
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "globalConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
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
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "configure",
      "docs": [
        "Authority-only. `None` args leave fields unchanged. Fee decreases",
        "apply instantly; increases stage for `FEE_TIMELOCK_SLOTS` (~2 days)",
        "then auto-promote on the next `configure` after the window."
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
            "pairConfig"
          ]
        },
        {
          "name": "pairConfig",
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
              },
              {
                "kind": "account",
                "path": "pair_config.base_mint",
                "account": "pairConfig"
              },
              {
                "kind": "account",
                "path": "assetMint"
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
          "name": "assetMint",
          "relations": [
            "pairConfig"
          ]
        },
        {
          "name": "assetAta",
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
                "path": "assetMint"
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
            "`None` leaves the stored vault unchanged."
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
        "Create a pair's config PDA + relayer-owned ATAs. Admin-gated. NTT",
        "program IDs are init-only safety pins."
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
          "name": "globalConfig",
          "docs": [
            "Admin gate: only `global_config.admin` may create pairs."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
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
          "name": "pairConfig",
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
              },
              {
                "kind": "account",
                "path": "baseMint"
              },
              {
                "kind": "account",
                "path": "assetMint"
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
          "name": "baseMint"
        },
        {
          "name": "assetMint"
        },
        {
          "name": "baseAta",
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
                "path": "baseMint"
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
          "name": "assetAta",
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
                "path": "assetMint"
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
            "Forbid `fee_vault == asset_ata` to prevent self-transfer no-ops",
            "that would commingle user funds with fees."
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
        },
        {
          "name": "nttBaseProgram",
          "type": "pubkey"
        },
        {
          "name": "nttAssetProgram",
          "type": "pubkey"
        },
        {
          "name": "intentPrograms",
          "type": {
            "array": [
              "pubkey",
              2
            ]
          }
        }
      ]
    },
    {
      "name": "receive",
      "docs": [
        "Redeem an inbound NTT VAA and create the `Flow` receipt. Direction",
        "selects the token side, NTT manager, and flow seed."
      ],
      "discriminator": [
        86,
        17,
        255,
        171,
        17,
        17,
        187,
        219
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "pairConfig",
          "docs": [
            "Pair-bound via an in-handler self-assert (only `recv_mint` is present",
            "here, so the config PDA can't be seed-checked in the Accounts struct)."
          ]
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
          "name": "recvMint",
          "docs": [
            "The received token's mint. Pinned in-handler to the direction-selected",
            "config mint (base for deposit, asset for withdraw)."
          ]
        },
        {
          "name": "recvAta",
          "docs": [
            "Sweep destination — long-lived relayer-authority ATA for recv_mint."
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
                "path": "recvMint"
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
          "name": "userWallet"
        },
        {
          "name": "userInboxAuthority",
          "docs": [
            "`[USER_INBOX_SEED, user_wallet, min_swap_out]`;",
            "owns and signs sweeps from user_inbox_ata."
          ]
        },
        {
          "name": "userInboxAta",
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
                "path": "recvMint"
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
          "name": "nttTransceiverMessage"
        },
        {
          "name": "nttProgram"
        },
        {
          "name": "flow",
          "writable": true
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
          "name": "direction",
          "type": {
            "defined": {
              "name": "direction"
            }
          }
        },
        {
          "name": "redeemAccountsLen",
          "type": "u8"
        },
        {
          "name": "minSwapOut",
          "type": "u64"
        }
      ]
    },
    {
      "name": "refund",
      "docs": [
        "Permissionless timeout refund. For a stale `Received` flow, sends the",
        "original token back to `flow.recipient` via NTT, then closes the flow."
      ],
      "discriminator": [
        2,
        96,
        183,
        251,
        63,
        208,
        46,
        46
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "pairConfig",
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
              },
              {
                "kind": "account",
                "path": "baseMint"
              },
              {
                "kind": "account",
                "path": "assetMint"
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
          "name": "baseMint",
          "relations": [
            "pairConfig"
          ]
        },
        {
          "name": "assetMint",
          "relations": [
            "pairConfig"
          ]
        },
        {
          "name": "baseAta",
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
                "path": "baseMint"
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
          "name": "assetAta",
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
                "path": "assetMint"
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
          "name": "flow",
          "writable": true
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
      "name": "send",
      "docs": [
        "Route-agnostic outbound send. Routes on `flow.direction`: deposit",
        "pushes asset out, withdraw pushes base out, each via NTT `transfer_lock`",
        "+ atomic `release_wormhole_outbound`.",
        "`transfer_lock_account_count` splits `remaining_accounts` between the",
        "two NTT CPIs."
      ],
      "discriminator": [
        102,
        251,
        20,
        187,
        65,
        75,
        12,
        69
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "pairConfig",
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
              },
              {
                "kind": "account",
                "path": "baseMint"
              },
              {
                "kind": "account",
                "path": "assetMint"
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
          "name": "baseMint",
          "relations": [
            "pairConfig"
          ]
        },
        {
          "name": "assetMint",
          "relations": [
            "pairConfig"
          ]
        },
        {
          "name": "baseAta",
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
                "path": "baseMint"
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
          "name": "assetAta",
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
                "path": "assetMint"
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
          "name": "flow",
          "writable": true
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
      "name": "setAdmin",
      "docs": [
        "Propose a new global admin (step 1 of two-step rotation)."
      ],
      "discriminator": [
        251,
        163,
        0,
        52,
        91,
        194,
        187,
        92
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "globalConfig"
          ]
        },
        {
          "name": "globalConfig",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
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
      "args": [
        {
          "name": "newAdmin",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "swap",
      "docs": [
        "Permissionless, route-agnostic swap. Routes on `flow.direction`:",
        "deposit swaps base→asset (fee from the asset output), withdraw swaps",
        "asset→base (fee from the asset input)."
      ],
      "discriminator": [
        248,
        198,
        158,
        145,
        225,
        117,
        135,
        200
      ],
      "accounts": [
        {
          "name": "pairConfig",
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
              },
              {
                "kind": "account",
                "path": "baseMint"
              },
              {
                "kind": "account",
                "path": "assetMint"
              }
            ]
          }
        },
        {
          "name": "relayerAuthority",
          "docs": [
            "and swap CPI. Reach bounded by the post-CPI ATA assertions."
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
          "name": "baseMint",
          "relations": [
            "pairConfig"
          ]
        },
        {
          "name": "assetMint",
          "relations": [
            "pairConfig"
          ]
        },
        {
          "name": "baseAta",
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
                "path": "baseMint"
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
          "name": "assetAta",
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
                "path": "assetMint"
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
            "Fee destination — always denominated in the asset token."
          ],
          "writable": true,
          "relations": [
            "pairConfig"
          ]
        },
        {
          "name": "nttInboxItem"
        },
        {
          "name": "flow",
          "writable": true
        },
        {
          "name": "swapProgram",
          "docs": [
            "delegation, not program identity."
          ]
        },
        {
          "name": "swapDelegate",
          "docs": [
            "`relayer_authority` as a sentinel for owner-signed routers."
          ]
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "swapIxData",
          "type": "bytes"
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
      "name": "globalConfig",
      "discriminator": [
        149,
        8,
        156,
        202,
        160,
        252,
        176,
        217
      ]
    },
    {
      "name": "pairConfig",
      "discriminator": [
        119,
        167,
        13,
        129,
        136,
        228,
        151,
        77
      ]
    }
  ],
  "events": [
    {
      "name": "received",
      "discriminator": [
        64,
        93,
        61,
        227,
        221,
        171,
        20,
        177
      ]
    },
    {
      "name": "refunded",
      "discriminator": [
        35,
        103,
        149,
        246,
        196,
        123,
        221,
        99
      ]
    },
    {
      "name": "sent",
      "discriminator": [
        230,
        90,
        111,
        254,
        186,
        174,
        45,
        74
      ]
    },
    {
      "name": "swapped",
      "discriminator": [
        217,
        52,
        52,
        83,
        147,
        135,
        96,
        109
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
      "msg": "fee_vault must not alias the relayer's asset ATA"
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
      "name": "emptyPendingFee",
      "msg": "PendingFee bundle has no inner leg set — invariant violation"
    },
    {
      "code": 6018,
      "name": "wrongOriginChain",
      "msg": "Inbound NTT message did not originate from the FOGO peer chain"
    },
    {
      "code": 6019,
      "name": "userInboxAuthorityMismatch",
      "msg": "user_inbox_ata's authority does not match the [user_inbox, user_wallet] PDA"
    },
    {
      "code": 6020,
      "name": "unexpectedFogoSender",
      "msg": "NTT VAA's NttManagerMessage.sender is not the intent_transfer setter PDA — deposit must originate via \\\n         intent_transfer"
    },
    {
      "code": 6021,
      "name": "invalidInboxItem",
      "msg": "ntt_inbox_item account is missing, too short, or has the wrong discriminator"
    },
    {
      "code": 6022,
      "name": "insufficientInboxBalance",
      "msg": "user_inbox_ata balance is below the NTT-recorded inbox_item.amount — inbox was not credited as expected"
    },
    {
      "code": 6023,
      "name": "pendingAuthorityIsCurrent",
      "msg": "Proposed pending_authority equals the current authority — self-rotate is rejected"
    },
    {
      "code": 6024,
      "name": "ataAuthorityTampered",
      "msg": "Relayer ATA authority/delegate/close_authority was mutated by the swap CPI"
    },
    {
      "code": 6025,
      "name": "inputConsumedMismatch",
      "msg": "swap consumed an input amount different from the flow amount"
    },
    {
      "code": 6026,
      "name": "outputBelowFloor",
      "msg": "swap output fell below the user-signed min_swap_out floor"
    },
    {
      "code": 6027,
      "name": "swapAccountNotAllowed",
      "msg": "a swap account aliases relayer custody (fee_vault/config/flow or a relayer_authority-owned token account)"
    },
    {
      "code": 6028,
      "name": "relayerAuthorityTampered",
      "msg": "swap CPI drained, reassigned, or reallocated the relayer_authority PDA"
    },
    {
      "code": 6029,
      "name": "badNttProgram",
      "msg": "ntt_program / transceiver owner does not match the direction-selected NTT manager"
    },
    {
      "code": 6030,
      "name": "badReceiveMint",
      "msg": "recv_mint does not match the direction-selected config mint"
    },
    {
      "code": 6031,
      "name": "refundTooEarly",
      "msg": "refund attempted before received_slot + REFUND_TIMEOUT_SLOTS"
    },
    {
      "code": 6032,
      "name": "zeroMinSwapOut",
      "msg": "min_swap_out must be > 0 — a zero floor would leave the swap unprotected"
    },
    {
      "code": 6033,
      "name": "badConfig",
      "msg": "pair_config PDA does not match the pair-derived address"
    },
    {
      "code": 6034,
      "name": "arithmeticOverflow",
      "msg": "arithmetic overflow"
    },
    {
      "code": 6035,
      "name": "unauthorizedAdmin",
      "msg": "only the relayer admin may create pairs"
    },
    {
      "code": 6036,
      "name": "noPendingAdmin",
      "msg": "no pending admin to accept"
    },
    {
      "code": 6037,
      "name": "pendingAdminMismatch",
      "msg": "signer does not match the pending admin"
    },
    {
      "code": 6038,
      "name": "pendingAdminIsCurrent",
      "msg": "proposed admin equals the current admin"
    }
  ],
  "types": [
    {
      "name": "direction",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "deposit"
          },
          {
            "name": "withdraw"
          }
        ]
      }
    },
    {
      "name": "flow",
      "docs": [
        "One-shot receipt binding an inbound bridge message to a FOGO wallet.",
        "Replay protection lives in the per-VAA NTT claim account. Field set",
        "is byte-stable — older PDAs must keep deserializing."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "recipient",
            "docs": [
              "Originator on FOGO; outbound recipient on the return leg. Both legs are",
              "SVM, so this is a pubkey; the NTT wire ABI takes its raw bytes."
            ],
            "type": "pubkey"
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
          },
          {
            "name": "direction",
            "docs": [
              "`Direction::Deposit` or `Direction::Withdraw`. Persisted at receive,",
              "read by `swap`/`send` to select fee side and NTT manager."
            ],
            "type": {
              "defined": {
                "name": "direction"
              }
            }
          },
          {
            "name": "minSwapOut",
            "docs": [
              "User-signed swap floor (output-token atomic units), bound via the",
              "min-bearing inbox PDA. `swap` enforces `out_received >= min_swap_out`."
            ],
            "type": "u64"
          },
          {
            "name": "receivedSlot",
            "docs": [
              "`Clock::slot` at receive; `refund` timeout anchor."
            ],
            "type": "u64"
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
            "name": "received"
          },
          {
            "name": "swapped"
          }
        ]
      }
    },
    {
      "name": "globalConfig",
      "docs": [
        "Global singleton (PDA `[GlobalConfig::SEED]`)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          },
          {
            "name": "pendingAdmin",
            "docs": [
              "Two-step rotation target: `set_admin` proposes, `accept_admin` promotes."
            ],
            "type": {
              "option": "pubkey"
            }
          }
        ]
      }
    },
    {
      "name": "pairConfig",
      "docs": [
        "Config for one token pair (PDA `[PairConfig::SEED, base_mint, asset_mint]`).",
        "`authority` only gates governance; user flows are permissionless."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "baseMint",
            "type": "pubkey"
          },
          {
            "name": "assetMint",
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
            "name": "nttBaseProgram",
            "type": "pubkey"
          },
          {
            "name": "nttAssetProgram",
            "type": "pubkey"
          },
          {
            "name": "intentPrograms",
            "docs": [
              "Programs allowed to originate inbound VAAs. `receive` derives each",
              "entry's setter PDA and matches the VAA sender; both slots are equally",
              "authoritative (no primary/fallback), changeable only by a fresh init."
            ],
            "type": {
              "array": [
                "pubkey",
                2
              ]
            }
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
            "name": "reserved",
            "docs": [
              "Headroom for future fixed-size fields without another migration."
            ],
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          },
          {
            "name": "pendingAuthority",
            "docs": [
              "Promoted to `authority` by `accept_authority` (two-step handoff)."
            ],
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "pendingFee",
            "docs": [
              "Staged fee *increase*, auto-promoted on next `configure` once",
              "`ready_slot` elapses. Decreases bypass this."
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
              "MAX-extended on later raises so a follow-up never shortens the window."
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "received",
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
            "name": "recipient",
            "type": "pubkey"
          },
          {
            "name": "direction",
            "type": {
              "defined": {
                "name": "direction"
              }
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
      "name": "refunded",
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
            "name": "recipient",
            "type": "pubkey"
          },
          {
            "name": "direction",
            "type": {
              "defined": {
                "name": "direction"
              }
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
      "name": "sent",
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
            "name": "recipient",
            "type": "pubkey"
          },
          {
            "name": "direction",
            "type": {
              "defined": {
                "name": "direction"
              }
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
      "name": "swapped",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "flow",
            "type": "pubkey"
          },
          {
            "name": "direction",
            "type": {
              "defined": {
                "name": "direction"
              }
            }
          },
          {
            "name": "grossIn",
            "type": "u64"
          },
          {
            "name": "fee",
            "type": "u64"
          },
          {
            "name": "netOut",
            "type": "u64"
          },
          {
            "name": "floor",
            "type": "u64"
          },
          {
            "name": "swapProgram",
            "type": "pubkey"
          }
        ]
      }
    }
  ]
};
