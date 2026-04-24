//! Wormhole NTT outbound-transfer wire format. Lives next to the struct
//! that defines it instead of being open-coded in handler scratch buffers.

use anchor_lang::prelude::*;

use crate::constants::{NTT_PROGRAM_ID, NTT_SESSION_AUTHORITY_SEED};

/// `transfer_lock` / `transfer_burn` args. Identical Borsh layout for both
/// Locking and Burning modes — only the discriminator differs.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct NttTransferArgs {
    pub amount: u64,
    pub recipient_chain: u16,
    pub recipient_address: [u8; 32],
    pub should_queue: bool,
}

// Big-endian packed size for the session-authority hash domain.
const NTT_TRANSFER_ARGS_PACKED_SIZE: usize = 8 + 2 + 32 + 1;

impl NttTransferArgs {
    /// NTT's big-endian packed form, used as the keccak pre-image for the
    /// session-authority PDA.
    fn pack_be(&self) -> [u8; NTT_TRANSFER_ARGS_PACKED_SIZE] {
        let mut buf = [0u8; NTT_TRANSFER_ARGS_PACKED_SIZE];
        buf[0..8].copy_from_slice(&self.amount.to_be_bytes());
        buf[8..10].copy_from_slice(&self.recipient_chain.to_be_bytes());
        buf[10..42].copy_from_slice(&self.recipient_address);
        buf[42] = u8::from(self.should_queue);
        buf
    }

    /// keccak256(amount_be || chain_be || recipient || should_queue) —
    /// matches NTT's session-authority binding digest.
    pub fn args_hash(&self) -> [u8; 32] {
        solana_keccak_hasher::hash(&self.pack_be()).to_bytes()
    }
}

/// Returns `(session_authority, bump)` for the given (sender, args).
pub fn derive_session_authority(sender: &Pubkey, args: &NttTransferArgs) -> (Pubkey, u8) {
    let hash = args.args_hash();
    Pubkey::find_program_address(
        &[NTT_SESSION_AUTHORITY_SEED, sender.as_ref(), hash.as_ref()],
        &NTT_PROGRAM_ID,
    )
}

/// Unit struct — `redeem` reads everything from the already-validated
/// `ValidatedTransceiverMessage` account written by the transceiver's
/// earlier `receive_message`.
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct NttRedeemArgs {}

/// `revert_on_delay = false` lets the CPI succeed even when NTT's rate
/// limiter delays the release.
#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct NttReleaseInboundArgs {
    pub revert_on_delay: bool,
}

/// Anchor disc = `sha256("account:ValidatedTransceiverMessage")[..8]`.
pub const VALIDATED_TRANSCEIVER_MESSAGE_DISC: [u8; 8] =
    [0x61, 0x00, 0x70, 0x7D, 0x6B, 0xDC, 0x25, 0xB5];

/// Offset of `NttManagerMessage.sender` in
/// `ValidatedTransceiverMessage<NativeTokenTransfer<_>>`:
///   disc(8) + from_chain(2) + source_ntt_manager(32)
///     + recipient_ntt_manager(32) + NttManagerMessage.id(32) = 106.
///     The next 32 bytes are the originating FOGO user wallet.
pub const TRANSCEIVER_MESSAGE_SENDER_OFFSET: usize = 106;
