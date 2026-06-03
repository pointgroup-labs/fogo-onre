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

    #[msg("PendingFee bundle has no inner leg set — invariant violation")]
    EmptyPendingFee,

    #[msg("Inbound NTT message did not originate from the FOGO peer chain")]
    WrongOriginChain,

    #[msg("user_inbox_ata's authority does not match the [user_inbox, user_wallet] PDA")]
    UserInboxAuthorityMismatch,

    #[msg(
        "NTT VAA's NttManagerMessage.sender is not the intent_transfer setter PDA — deposit must originate via \
         intent_transfer"
    )]
    UnexpectedFogoSender,

    #[msg("ntt_inbox_item account is missing, too short, or has the wrong discriminator")]
    InvalidInboxItem,

    #[msg("user_inbox_ata balance is below the NTT-recorded inbox_item.amount — inbox was not credited as expected")]
    InsufficientInboxBalance,

    #[msg("Proposed pending_authority equals the current authority — self-rotate is rejected")]
    PendingAuthorityIsCurrent,

    #[msg("No active OnRe pricing vector for the current clock")]
    OnreNoActiveVector,

    #[msg("Overflow in OnRe NAV computation")]
    OnreNavOverflow,

    #[msg("OnRe Offer account data is shorter than the pinned layout")]
    OnreOfferTooShort,

    #[msg("OnRe Offer token_in_mint does not match relayer_config.base_mint")]
    OnreOfferTokenInMintMismatch,

    #[msg("OnRe Offer token_out_mint does not match relayer_config.asset_mint")]
    OnreOfferTokenOutMintMismatch,

    #[msg(
        "onre_offer account owner is not the OnRe program — handler refuses to read a foreign account as a pricing \
         oracle"
    )]
    OnreOfferOwnerMismatch,

    #[msg("onre_offer address does not match the deposit Offer PDA derived from (usdc_mint, onyc_mint)")]
    OnreOfferAddressMismatch,

    #[msg("MAX_SLIPPAGE_BPS is misconfigured (> 10_000) — refusing to compute a zero floor")]
    OnreInvalidSlippageBps,

    #[msg("Configured slippage_bps exceeds MAX_SLIPPAGE_BPS ceiling")]
    SlippageBpsTooHigh,

    #[msg("Relayer ATA authority/delegate/close_authority was mutated by the swap CPI")]
    AtaAuthorityTampered,

    #[msg("price_oracle account does not match relayer_config.price_oracle (or it is unset)")]
    BadPriceOracle,

    #[msg("swap consumed an input amount different from the flow amount")]
    InputConsumedMismatch,

    #[msg("swap output fell below the NAV-anchored slippage floor")]
    OutputBelowFloor,

    #[msg("a swap account aliases relayer custody (fee_vault/config/flow or a relayer_authority-owned token account)")]
    SwapAccountNotAllowed,

    #[msg("swap CPI drained, reassigned, or reallocated the relayer_authority PDA")]
    RelayerAuthorityTampered,

    #[msg("ntt_program / transceiver owner does not match the direction-selected NTT manager")]
    BadNttProgram,

    #[msg("recv_mint does not match the direction-selected config mint")]
    BadReceiveMint,
}
