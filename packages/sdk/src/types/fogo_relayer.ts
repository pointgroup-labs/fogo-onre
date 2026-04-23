/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/relayer.json`.
 */
export type Relayer = {
  "address": "onrenRKgX54qtWeK3cuaTBE71xx7dWMXn82ubH61vAp",
  "metadata": {
    "name": "relayer",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Fogo OnRe relayer — stateless PDA-custody relay between Wormhole Gateway, OnRe, and Wormhole NTT on Solana"
  },
  "docs": [
    "Stateless cross-chain relayer between FOGO and Solana (Phase 1 — no",
    "vault).",
    "",
    "All operational instructions are permissionless — anyone can crank any",
    "step. Safety comes from the Flow PDA design: each inbound Wormhole",
    "message (Gateway VAA or NTT VAA) carries the originating FOGO user's",
    "wallet in its payload. `claim_usdc` / `unlock_onyc` persist that wallet",
    "in a one-shot `Flow` PDA keyed by the bridge's per-VAA claim account",
    "pubkey; `lock_onyc` / `send_usdc_to_user` then consume that PDA to",
    "choose the outbound recipient. The Flow PDA also tracks status and",
    "amount, isolating concurrent flows and enabling resumability."
  ],
  "instructions": [
    {
      "name": "acceptAuthority",
      "docs": [
        "Two-step authority rotation, step two. Signer must equal",
        "`relayer_config.pending_authority`; on success that key",
        "atomically becomes `authority` and the pending slot clears.",
        "The current authority does NOT participate, by design — the",
        "two-step pattern lets two independent multisigs rotate",
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
          "docs": [
            "The proposed new authority. Must equal",
            "`relayer_config.pending_authority`."
          ],
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
      "name": "claimUsdc",
      "docs": [
        "Claim USDC bridged from a FOGO user via Wormhole Gateway. Creates",
        "a `Flow` receipt that binds the eventual bONyc return to that same",
        "user's FOGO wallet."
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
          "name": "redeemerAuthority",
          "docs": [
            "Redeemer PDA — signs the Token Bridge CPI and the post-CPI sweep."
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
                  101,
                  109,
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
            "Long-lived USDC ATA owned by the relayer authority PDA; the final",
            "destination of the claim. Populated by the post-CPI sweep."
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
          "name": "redeemerUsdcAta",
          "docs": [
            "Short-lived USDC intake ATA owned by the redeemer PDA. TB mints",
            "directly into this account during `CompleteWrappedWithPayload`;",
            "we then sweep the balance into `usdc_ata` in the same instruction."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "redeemerAuthority"
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
          "name": "postedVaa",
          "docs": [
            "Wormhole posted-VAA account. We read `fogo_sender` from its on-chain",
            "data (guardian-signed) rather than trusting an instruction argument."
          ]
        },
        {
          "name": "gatewayClaim",
          "docs": [
            "Wormhole Gateway's per-VAA claim PDA. Created by the Gateway CPI;",
            "we use its pubkey as unique seed material for the flow PDA."
          ]
        },
        {
          "name": "inflightFlow",
          "docs": [
            "One-shot flow receipt. `init` fails if a flow for this claim PDA",
            "already exists (double-claim protection)."
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
                "path": "gatewayClaim"
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
      "name": "configure",
      "docs": [
        "Update admin-mutable relayer config. Pass `None` for fee args you",
        "don't want to change; the `fee_vault` account is optional and",
        "only validated/written when supplied. `new_authority`:",
        "`Some(pk)` proposes `pk` as the next authority (writes",
        "`pending_authority`; current `authority` unchanged); `None`",
        "leaves the proposal slot alone; `Some(Pubkey::default())`",
        "cancels any in-flight proposal. Authority-only."
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
          "docs": [
            "Relayer authority PDA — owns `onyc_ata`. Re-derived here so the",
            "associated-token derivation on `onyc_ata` resolves and the",
            "anti-aliasing constraint can compare a fully-typed ATA pubkey."
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
            "The relayer's operating ONyc ATA — referenced solely to enforce",
            "`fee_vault != onyc_ata`. Not mutated."
          ],
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
            "New fee vault destination. `None` to leave the stored vault",
            "unchanged. When `Some`, must hold ONyc; the anti-aliasing check",
            "(`fee_vault != onyc_ata`) runs in the handler since Anchor's",
            "constraint-attribute expressions can't cleanly disambiguate",
            "`Option::as_ref` against `InterfaceAccount`'s `AsRef` impls."
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
        "One-time setup: create the relayer config PDA + USDC/ONyc ATAs",
        "owned by the relayer authority PDA."
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
          "docs": [
            "Deployer / authority — pays for account creation and becomes the",
            "admin key."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "relayerConfig",
          "docs": [
            "Relayer config PDA — stores mint references."
          ],
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
          "docs": [
            "Relayer authority PDA — owns the token accounts."
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
          "name": "redeemerAuthority",
          "docs": [
            "Redeemer PDA — serves as Token Bridge's payload-delivery signer in",
            "`CompleteWrappedWithPayload` AND as the owner of the short-lived USDC",
            "intake ATA (TB requires `redeemer.key == to.owner`)."
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
                  101,
                  109,
                  101,
                  114
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint",
          "docs": [
            "USDC token mint."
          ]
        },
        {
          "name": "onycMint",
          "docs": [
            "ONyc token mint."
          ]
        },
        {
          "name": "usdcAta",
          "docs": [
            "USDC associated token account owned by the relayer authority PDA."
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
            "ONyc associated token account owned by the relayer authority PDA."
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
          "name": "redeemerUsdcAta",
          "docs": [
            "Redeemer-owned USDC intake ATA. `claim_usdc` deposits bridged USDC",
            "here (TB mints into it during `CompleteWrappedWithPayload`) and",
            "immediately sweeps it into `usdc_ata` under the redeemer's signature."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "redeemerAuthority"
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
          "name": "feeVault",
          "docs": [
            "Single fee vault — any pre-existing ONyc token account, supplied by",
            "the deployer at init time. The anti-aliasing constraint prevents the",
            "caller from passing the relayer's own ONyc ATA, which would silently",
            "no-op every fee transfer (self-transfer) and let user funds and fees",
            "keep commingling — defeating the whole point of the vault split."
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
        "Lock the flow's ONyc amount via Wormhole NTT, sending bONyc back",
        "to the FOGO wallet recorded in the `Flow` PDA. Consumes the PDA."
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
          "name": "gatewayClaim",
          "docs": [
            "Same Gateway claim PDA used at `claim_usdc` time."
          ]
        },
        {
          "name": "inflightFlow",
          "docs": [
            "The one-shot receipt created by `claim_usdc`. `close = rent_destination`",
            "consumes the receipt so a second `lock_onyc` against the same flow",
            "is impossible."
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
                "path": "gatewayClaim"
              }
            ]
          }
        },
        {
          "name": "rentDestination",
          "docs": [
            "The original payer who created this flow PDA. Receives the rent refund."
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
      "name": "sendUsdcToUser",
      "docs": [
        "Send the flow's USDC amount back to the FOGO user recorded in",
        "the `Flow` PDA. Consumes the PDA."
      ],
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
          "name": "nttInboxItem",
          "docs": [
            "Same NTT inbox-item PDA used at `unlock_onyc` time."
          ]
        },
        {
          "name": "outflightFlow",
          "docs": [
            "The one-shot receipt created by `unlock_onyc`. Closing it on",
            "success returns rent to the original payer and blocks replays."
          ],
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
          "docs": [
            "The original payer who created this flow PDA. Receives the rent refund."
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
      "name": "swapOnycToUsdc",
      "docs": [
        "Swap the flow's ONyc amount into USDC via OnRe."
      ],
      "discriminator": [
        113,
        41,
        170,
        211,
        19,
        16,
        31,
        63
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
            "Single fee vault — receives the pre-swap withdrawal fee. Pinned by",
            "`has_one = fee_vault` on `relayer_config`. Can be any pre-existing",
            "ONyc token account (configured at `initialize` time)."
          ],
          "writable": true,
          "relations": [
            "relayerConfig"
          ]
        },
        {
          "name": "nttInboxItem",
          "docs": [
            "NTT inbox-item PDA — seed material for the flow PDA."
          ]
        },
        {
          "name": "outflightFlow",
          "docs": [
            "The flow PDA created by `unlock_onyc`. Must be in `Claimed` status."
          ],
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
        }
      ],
      "args": []
    },
    {
      "name": "swapUsdcToOnyc",
      "docs": [
        "Swap the flow's USDC amount into ONyc via OnRe."
      ],
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
            "Single fee vault — receives the post-swap deposit fee. Pinned by",
            "`has_one = fee_vault` on `relayer_config`. Can be any pre-existing",
            "ONyc token account (configured at `initialize` time); does not need",
            "to be relayer-owned."
          ],
          "writable": true,
          "relations": [
            "relayerConfig"
          ]
        },
        {
          "name": "gatewayClaim",
          "docs": [
            "Gateway claim PDA — seed material for the flow PDA."
          ]
        },
        {
          "name": "inflightFlow",
          "docs": [
            "The flow PDA created by `claim_usdc`. Must be in `Claimed` status."
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
                "path": "gatewayClaim"
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
      "name": "sweep",
      "docs": [
        "Authority-only escape hatch to extract stranded balances from the",
        "relayer-PDA-owned USDC/ONyc ATAs (pre-upgrade commingled fees,",
        "dust, accidental direct transfers, etc.). Operational flows always",
        "move exact `Flow.amount` so anything credited outside a tracked",
        "flow would otherwise be locked forever. See `sweep.rs` for the",
        "full trust-model rationale."
      ],
      "discriminator": [
        40,
        23,
        234,
        175,
        14,
        61,
        154,
        177
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
          "name": "mint",
          "docs": [
            "The mint of the tokens being swept. Constrained at runtime to be",
            "either `usdc_mint` or `onyc_mint` from `relayer_config`."
          ]
        },
        {
          "name": "from",
          "docs": [
            "Source — the relayer-authority-owned ATA for `mint`. The",
            "associated-token derivation pins this implicitly."
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
                "path": "mint"
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
          "name": "to",
          "docs": [
            "Destination — any token account holding `mint`. Authority's",
            "discretion (typically the configured `fee_vault` for ONyc, or a",
            "treasury account for USDC)."
          ],
          "writable": true
        },
        {
          "name": "tokenProgram"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "unlockOnyc",
      "docs": [
        "Release ONyc from NTT custody for an inbound withdrawal VAA, and",
        "record a `Flow` receipt binding the USDC return to the FOGO user",
        "who initiated the withdrawal."
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
            "NTT inbox-item PDA. Created by the NTT `redeem` CPI; we use its",
            "pubkey as unique seed material for the flow PDA."
          ]
        },
        {
          "name": "nttTransceiverMessage",
          "docs": [
            "NTT `ValidatedTransceiverMessage` for this inbound transfer — same",
            "account that the caller must pass to the `redeem` CPI in",
            "`remaining_accounts`. We parse `fogo_sender` directly from its",
            "already-validated bytes. The `owner` constraint pins the writer to",
            "the NTT program (which for OnRe's deployment is also the transceiver",
            "program), so nothing outside NTT can have crafted this data."
          ]
        },
        {
          "name": "outflightFlow",
          "docs": [
            "One-shot receipt PDA for the withdrawal leg. `init` fails on",
            "replay (same NTT inbox → same PDA → already exists)."
          ],
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
    },
    {
      "name": "usdcSwapped",
      "discriminator": [
        146,
        221,
        3,
        190,
        76,
        26,
        133,
        81
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "invalidVaa",
      "msg": "VAA verification failed or VAA is invalid"
    },
    {
      "code": 6001,
      "name": "invalidAccountSplit",
      "msg": "remaining_accounts split point is out of range"
    },
    {
      "code": 6002,
      "name": "authorityNotInAccounts",
      "msg": "Relayer authority PDA not present in forwarded CPI accounts"
    },
    {
      "code": 6003,
      "name": "vaaPayloadTooShort",
      "msg": "VAA payload is shorter than the expected fogo_sender field"
    },
    {
      "code": 6004,
      "name": "zeroFogoSender",
      "msg": "Parsed fogo_sender is the zero address"
    },
    {
      "code": 6005,
      "name": "unauthorizedAuthority",
      "msg": "Caller is not the authority"
    },
    {
      "code": 6006,
      "name": "flowStatusMismatch",
      "msg": "Flow is not in the expected status for this operation"
    },
    {
      "code": 6007,
      "name": "balanceUnderflow",
      "msg": "Post-CPI balance is less than pre-CPI balance"
    },
    {
      "code": 6008,
      "name": "zeroAmountFlow",
      "msg": "Bridge or swap produced zero tokens"
    },
    {
      "code": 6009,
      "name": "feeBpsTooHigh",
      "msg": "Fee basis points exceed maximum (10000 = 100%)"
    },
    {
      "code": 6010,
      "name": "feeOverflow",
      "msg": "Fee computation overflow"
    },
    {
      "code": 6011,
      "name": "missingSessionAuthority",
      "msg": "NTT session authority PDA not found in remaining_accounts"
    },
    {
      "code": 6012,
      "name": "invalidTransceiverMessage",
      "msg": "NTT ValidatedTransceiverMessage account is malformed or too short"
    },
    {
      "code": 6013,
      "name": "transceiverMessageMismatch",
      "msg": "ntt_transceiver_message does not match the account consumed by the NTT redeem CPI"
    },
    {
      "code": 6014,
      "name": "inboxItemMismatch",
      "msg": "ntt_inbox_item does not match the account consumed by the NTT CPIs"
    },
    {
      "code": 6015,
      "name": "recipientAtaMismatch",
      "msg": "Destination token account does not match the ATA consumed by the NTT release CPI"
    },
    {
      "code": 6016,
      "name": "postedVaaMismatch",
      "msg": "posted_vaa does not match the VAA consumed by the Token Bridge CPI"
    },
    {
      "code": 6017,
      "name": "gatewayClaimMismatch",
      "msg": "gateway_claim does not match the claim PDA consumed by the Token Bridge CPI"
    },
    {
      "code": 6018,
      "name": "feeVaultAliasesUserAta",
      "msg": "fee_vault must not alias the relayer's ONyc operating ATA"
    },
    {
      "code": 6019,
      "name": "noPendingAuthority",
      "msg": "No pending authority — nothing to accept"
    },
    {
      "code": 6020,
      "name": "pendingAuthorityMismatch",
      "msg": "Signer does not match relayer_config.pending_authority"
    }
  ],
  "types": [
    {
      "name": "flow",
      "docs": [
        "One-shot receipt binding an inbound bridge message to a FOGO user wallet.",
        "",
        "Used by both deposit and withdrawal legs — direction is implicit in the",
        "PDA seed prefix (`FLOW_INBOUND_SEED` vs `FLOW_OUTBOUND_SEED`).",
        "",
        "Created by `claim_usdc` or `unlock_onyc` when the relayer processes an",
        "inbound Wormhole message. The `fogo_sender` field records the originating",
        "FOGO user's wallet (parsed from the VAA payload). Consumed by `lock_onyc`",
        "or `send_usdc_to_user`, which read `fogo_sender` as the outbound",
        "recipient.",
        "",
        "The `status` field tracks which pipeline step has completed, enabling",
        "resumability if a multi-step flow stalls. The `amount` field isolates",
        "each flow's capital so concurrent flows don't mix funds.",
        "",
        "PDA seeds: `[FLOW_*_SEED, bridge_claim_pda.key()]`, where",
        "`bridge_claim_pda` is the per-VAA claim account created by Wormhole",
        "Gateway or NTT. This delegates uniqueness and replay protection to the",
        "bridge program itself — no hashing needed."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "fogoSender",
            "docs": [
              "FOGO address of the user who originated the bridge message.",
              "Becomes the outbound Wormhole recipient on the return leg."
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
            "docs": [
              "Current status in the pipeline."
            ],
            "type": {
              "defined": {
                "name": "flowStatus"
              }
            }
          },
          {
            "name": "amount",
            "docs": [
              "Token amount for the current/next step."
            ],
            "type": "u64"
          },
          {
            "name": "payer",
            "docs": [
              "The payer who created this flow PDA (receives rent on close)."
            ],
            "type": "pubkey"
          },
          {
            "name": "bump",
            "docs": [
              "PDA bump."
            ],
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "flowStatus",
      "docs": [
        "Status of a flow through the relayer pipeline."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "claimed"
          },
          {
            "name": "swapped"
          }
        ]
      }
    },
    {
      "name": "onycLocked",
      "docs": [
        "Emitted by `lock_onyc` after NTT locks the flow's ONyc amount and",
        "initiates the bONyc transfer back to FOGO."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "flow",
            "type": "pubkey"
          },
          {
            "name": "gatewayClaim",
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
      "docs": [
        "Emitted by `swap_usdc_to_onyc` after the OnRe swap completes and the",
        "post-swap deposit fee has been moved to the fee vault.",
        "",
        "`gross_amount` = ONyc received from OnRe (pre-fee).",
        "`fee_amount`   = deposit fee retained by the relayer (gross - net).",
        "`net_amount`   = ONyc recorded on the `Flow` PDA (== amount the eventual",
        "`lock_onyc` will ship back to FOGO)."
      ],
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
      "docs": [
        "Emitted by `unlock_onyc` after the NTT redeem + release CPIs land ONyc",
        "in the relayer ATA. No fee logic on this leg — fees are taken at",
        "`swap_onyc_to_usdc`."
      ],
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
      "name": "relayerConfig",
      "docs": [
        "Relayer configuration — the only long-lived state in this program.",
        "",
        "The `authority` is a cold/admin key used only for governance (e.g.",
        "updating config). All operational instructions are permissionless —",
        "anyone can crank them because recipients are VAA-bound, amounts are",
        "flow-bound, and CPI targets are compile-time constants."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "docs": [
              "Admin key for governance operations."
            ],
            "type": "pubkey"
          },
          {
            "name": "pendingAuthority",
            "docs": [
              "Pending admin key, set by `configure(new_authority=Some(pk))`.",
              "Becomes `authority` only after a separate `accept_authority`",
              "transaction signed by this key. `None` when no rotation is",
              "in flight. Two-step design accommodates multisig→multisig",
              "rotations where the two parties cannot atomically co-sign",
              "(e.g. two independent Squads vaults)."
            ],
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "usdcMint",
            "docs": [
              "USDC token mint on Solana."
            ],
            "type": "pubkey"
          },
          {
            "name": "onycMint",
            "docs": [
              "ONyc token mint on Solana."
            ],
            "type": "pubkey"
          },
          {
            "name": "feeVault",
            "docs": [
              "Single fee vault — PDA-addressed token account holding ALL",
              "accumulated fees (both deposit-leg and withdrawal-leg, denominated",
              "in ONyc)."
            ],
            "type": "pubkey"
          },
          {
            "name": "bump",
            "docs": [
              "Bump seed for the config PDA."
            ],
            "type": "u8"
          },
          {
            "name": "relayerAuthorityBump",
            "docs": [
              "Bump seed for the relayer authority PDA (needed for CPI invoke_signed)."
            ],
            "type": "u8"
          },
          {
            "name": "depositFeeBps",
            "docs": [
              "Fee in basis points (1 bps = 0.01%) charged on each deposit flow (USDC → ONyc)."
            ],
            "type": "u16"
          },
          {
            "name": "withdrawFeeBps",
            "docs": [
              "Fee in basis points (1 bps = 0.01%) charged on each withdrawal flow (ONyc → USDC)."
            ],
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "usdcClaimed",
      "docs": [
        "Emitted by `claim_usdc` after the Gateway CPI lands USDC in the relayer",
        "ATA. No fee logic on this leg — fees are taken at `swap_usdc_to_onyc`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "flow",
            "type": "pubkey"
          },
          {
            "name": "gatewayClaim",
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
      "docs": [
        "Emitted by `send_usdc_to_user` after the Gateway outbound transfer is",
        "submitted."
      ],
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
      "name": "usdcSwapped",
      "docs": [
        "Emitted by `swap_onyc_to_usdc` after the pre-swap fee has been moved",
        "to the fee vault and the OnRe swap completes.",
        "",
        "`gross_amount`  = ONyc input to the swap step (pre-fee, == flow.amount",
        "from `unlock_onyc`).",
        "`fee_amount`    = withdrawal fee in ONyc (taken pre-swap).",
        "`net_amount`    = ONyc actually swapped (gross - fee).",
        "`usdc_received` = USDC received from OnRe (recorded on the Flow PDA)."
      ],
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
          },
          {
            "name": "usdcReceived",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
