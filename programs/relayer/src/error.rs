use anchor_lang::prelude::*;

#[error_code]
pub enum RelayerError {
    #[msg("remaining_accounts split point is out of range")]
    InvalidAccountSplit,

    #[msg("Relayer authority PDA not present in forwarded CPI accounts")]
    AuthorityNotInAccounts,

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

    #[msg("Fee basis points exceed MAX_FEE_BPS")]
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

    #[msg("fee_vault must not alias the relayer's ONyc operating ATA")]
    FeeVaultAliasesUserAta,

    #[msg("No pending authority — nothing to accept")]
    NoPendingAuthority,

    #[msg("Signer does not match relayer_config.pending_authority")]
    PendingAuthorityMismatch,

    #[msg("OnRe RedemptionRequest PDA still exists — redemption_admin has not fulfilled yet")]
    RedemptionNotFulfilled,

    #[msg("Provided redemption_request account does not match tracker.redemption_request")]
    RedemptionRequestMismatch,

    #[msg("RedemptionTracker.flow does not match the bound Flow PDA")]
    RedemptionTrackerFlowMismatch,

    #[msg("PendingFee bundle has no inner leg set — invariant violation")]
    EmptyPendingFee,

    #[msg("Inbound NTT message did not originate from the FOGO peer chain")]
    WrongOriginChain,

    #[msg("Post-CPI ONyc balance dropped — OnRe consumed ONyc unexpectedly")]
    UnexpectedOnycConsumed,
}
