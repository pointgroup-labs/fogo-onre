//! Extracts `fogo_sender` from a Portal TB `TransferWithPayload` message
//! embedded in a Wormhole posted-VAA account. Reads on-chain account data
//! rather than operator-supplied args — otherwise a compromised operator
//! could redirect outbound transfers.
//!
//! ## PostedVAA account layout (Wormhole core bridge, Solitaire)
//!
//! | Offset | Size | Field                    |
//! |--------|------|--------------------------|
//! | 0      | 3    | Tag: "msg" or "msu"      |
//! | 3      | 1    | vaa_version              |
//! | 4      | 1    | consistency_level         |
//! | 5      | 4    | vaa_time                 |
//! | 9      | 32   | vaa_signature_account    |
//! | 41     | 4    | submission_time          |
//! | 45     | 4    | nonce                    |
//! | 49     | 8    | sequence                 |
//! | 57     | 2    | emitter_chain            |
//! | 59     | 32   | emitter_address          |
//! | 91     | 4    | payload length (Borsh u32)|
//! | 95     | ..   | payload bytes            |
//!
//! ## Token Bridge transfer-with-payload (payload_id = 3)
//!
//! | Offset | Size | Field              |
//! |--------|------|--------------------|
//! | 0      | 1    | payload_id (= 3)   |
//! | 1      | 32   | amount (u256 BE)   |
//! | 33     | 32   | token_address      |
//! | 65     | 2    | token_chain        |
//! | 67     | 32   | to                 |
//! | 99     | 2    | to_chain           |
//! | 101    | 32   | from_address       |
//! | 133    | ..   | additional_payload |

use anchor_lang::prelude::*;

use crate::error::RelayerError;

/// Solitaire tag (3) + fixed header + Borsh `Vec<u8>` length prefix (4).
const POSTED_VAA_PAYLOAD_OFFSET: usize = 95;
/// TB transfer-with-payload header size (before `additional_payload`).
const TRANSFER_HEADER_SIZE: usize = 133;
const PAYLOAD_ID_TRANSFER_WITH_PAYLOAD: u8 = 3;

/// Returns `fogo_sender` — the trailing 32 bytes of `additional_payload`,
/// which the FOGO client appends to every TB TransferWithPayload.
pub fn parse_fogo_sender_from_posted_vaa(account_data: &[u8]) -> Result<[u8; 32]> {
    require!(
        account_data.len() >= POSTED_VAA_PAYLOAD_OFFSET,
        RelayerError::VaaPayloadTooShort
    );

    let tag = &account_data[..3];
    require!(tag == b"msg" || tag == b"msu", RelayerError::InvalidVaa);

    let payload_len_bytes: [u8; 4] = account_data[91..95]
        .try_into()
        .map_err(|_| error!(RelayerError::VaaPayloadTooShort))?;
    let payload_len = u32::from_le_bytes(payload_len_bytes) as usize;

    let payload_end = POSTED_VAA_PAYLOAD_OFFSET
        .checked_add(payload_len)
        .ok_or_else(|| error!(RelayerError::VaaPayloadTooShort))?;
    require!(
        account_data.len() >= payload_end,
        RelayerError::VaaPayloadTooShort
    );

    let payload = &account_data[POSTED_VAA_PAYLOAD_OFFSET..payload_end];

    require!(
        payload.len() >= TRANSFER_HEADER_SIZE,
        RelayerError::VaaPayloadTooShort
    );
    require!(
        payload[0] == PAYLOAD_ID_TRANSFER_WITH_PAYLOAD,
        RelayerError::InvalidVaa
    );

    let additional_payload = &payload[TRANSFER_HEADER_SIZE..];
    require!(
        additional_payload.len() >= 32,
        RelayerError::VaaPayloadTooShort
    );

    let mut fogo_sender = [0u8; 32];
    fogo_sender.copy_from_slice(&additional_payload[additional_payload.len() - 32..]);

    require!(fogo_sender != [0u8; 32], RelayerError::ZeroFogoSender);

    Ok(fogo_sender)
}
