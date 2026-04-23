use anchor_lang::prelude::*;

#[error_code]
pub enum RelayerError {
    #[msg("VAA verification failed or VAA is invalid")]
    InvalidVaa,

    #[msg("remaining_accounts split point is out of range")]
    InvalidAccountSplit,

    #[msg("Relayer authority PDA not present in forwarded CPI accounts")]
    AuthorityNotInAccounts,

    #[msg("VAA payload is shorter than the expected fogo_sender field")]
    VaaPayloadTooShort,

    #[msg("Parsed fogo_sender is the zero address")]
    ZeroFogoSender,

    #[msg("Caller is not the authority")]
    UnauthorizedAuthority,

    #[msg("Flow is not in the expected status for this operation")]
    FlowStatusMismatch,

    #[msg("Post-CPI balance is less than pre-CPI balance")]
    BalanceUnderflow,

    #[msg("Bridge or swap produced zero tokens")]
    ZeroAmountFlow,

    #[msg("Fee basis points exceed maximum (10000 = 100%)")]
    FeeBpsTooHigh,

    #[msg("Fee computation overflow")]
    FeeOverflow,

    #[msg("NTT session authority PDA not found in remaining_accounts")]
    MissingSessionAuthority,

    #[msg("NTT ValidatedTransceiverMessage account is malformed or too short")]
    InvalidTransceiverMessage,

    #[msg("ntt_transceiver_message does not match the account consumed by the NTT redeem CPI")]
    TransceiverMessageMismatch,

    #[msg("ntt_inbox_item does not match the account consumed by the NTT CPIs")]
    InboxItemMismatch,

    #[msg("Destination token account does not match the ATA consumed by the NTT release CPI")]
    RecipientAtaMismatch,

    #[msg("posted_vaa does not match the VAA consumed by the Token Bridge CPI")]
    PostedVaaMismatch,

    #[msg("gateway_claim does not match the claim PDA consumed by the Token Bridge CPI")]
    GatewayClaimMismatch,

    #[msg("fee_vault must not alias the relayer's ONyc operating ATA")]
    FeeVaultAliasesUserAta,

    #[msg("No pending authority — nothing to accept")]
    NoPendingAuthority,

    #[msg("Signer does not match relayer_config.pending_authority")]
    PendingAuthorityMismatch,
}
