use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_lang::Discriminator;

use crate::constants::{CONFIG_SEED, DEFAULT_SLIPPAGE_BPS};
use crate::error::RelayerError;
use crate::state::{RelayerConfig, RelayerConfigV0};

/// One-shot, authority-gated upgrade of the launch `RelayerConfig` to the
/// `slippage_bps`-bearing layout. `slippage_bps` was appended after mainnet
/// launch, so the live account is 2 bytes short and every typed load fails
/// until this runs. Reads the old layout raw, tops up rent, grows the
/// account, and rewrites it with `slippage_bps = DEFAULT_SLIPPAGE_BPS`.
/// Idempotent: reverts once the account already carries the new field.
pub fn handler(ctx: Context<MigrateConfig>) -> Result<()> {
    let config = ctx.accounts.relayer_config.to_account_info();
    let new_len = 8 + RelayerConfig::INIT_SPACE;

    let old = {
        let data = config.try_borrow_data()?;
        require!(
            data.len() >= 8 && data[..8] == *RelayerConfig::DISCRIMINATOR,
            RelayerError::ConfigMigrationFailed
        );
        require!(data.len() < new_len, RelayerError::ConfigAlreadyMigrated);
        RelayerConfigV0::deserialize(&mut &data[8..])
            .map_err(|_| error!(RelayerError::ConfigMigrationFailed))?
    };

    require_keys_eq!(
        ctx.accounts.authority.key(),
        old.authority,
        RelayerError::UnauthorizedAuthority
    );

    let needed = Rent::get()?.minimum_balance(new_len);
    let delta = needed.saturating_sub(config.lamports());
    if delta > 0 {
        transfer(
            CpiContext::new(
                *ctx.accounts.system_program.key,
                Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: config.clone(),
                },
            ),
            delta,
        )?;
    }

    config.resize(new_len)?;

    let migrated = RelayerConfig {
        usdc_mint: old.usdc_mint,
        onyc_mint: old.onyc_mint,
        authority: old.authority,
        fee_vault: old.fee_vault,
        deposit_fee_bps: old.deposit_fee_bps,
        withdraw_fee_bps: old.withdraw_fee_bps,
        relayer_authority_bump: old.relayer_authority_bump,
        bump: old.bump,
        reserved: [0u8; 128],
        pending_authority: old.pending_authority,
        pending_fee: old.pending_fee,
        slippage_bps: DEFAULT_SLIPPAGE_BPS,
    };
    migrated.validate()?;

    let mut data = config.try_borrow_mut_data()?;
    let mut writer = &mut data[..];
    migrated.try_serialize(&mut writer)?;

    msg!(
        "Relayer config migrated. slippage_bps: {}.",
        DEFAULT_SLIPPAGE_BPS
    );
    Ok(())
}

#[derive(Accounts)]
pub struct MigrateConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: config PDA pinned by seeds; deserialized manually in the old
    /// layout, then realloc'd and rewritten. `authority == old.authority`
    /// is enforced in the handler.
    #[account(mut, seeds = [CONFIG_SEED], bump, owner = crate::ID)]
    pub relayer_config: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}
