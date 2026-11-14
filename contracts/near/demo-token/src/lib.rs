use near_contract_standards::fungible_token::{
    metadata::{FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC},
    FungibleToken,
};
use near_sdk::{env,json_types::{U128,U64}, near, AccountId, NearToken, PanicOnDefault, PromiseOrValue};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct DemoToken {
    token: FungibleToken,
}

#[near]
impl DemoToken {
    #[init]
    pub fn new(owner_id: AccountId, supply: U128) -> Self {
        let mut token = FungibleToken::new(b"t");
        token.internal_register_account(&owner_id);
        token.internal_deposit(&owner_id, supply.0);
        Self { token }
    }

    #[private]
    pub fn enable_payout_escrow(&mut self, escrow: AccountId) {
        env::storage_write(&Self::escrow_key(&escrow), b"1");
    }

    pub fn payout_enabled(&self, escrow: AccountId) -> bool {
        env::storage_has_key(&Self::escrow_key(&escrow))
    }

    #[payable]
    pub fn pactpay_transfer_once(&mut self, claim_id: U64, receiver_id: AccountId, amount: U128) {
        near_sdk::assert_one_yocto();
        let escrow = env::predecessor_account_id();
        assert!(self.payout_enabled(escrow.clone()), "Escrow not enabled");
        let mut key=Self::escrow_key(&escrow);
        key.push(b':');
        key.extend_from_slice(&claim_id.0.to_le_bytes());
        let mut value=amount.0.to_le_bytes().to_vec();
        value.extend_from_slice(receiver_id.as_bytes());
        if let Some(previous)=env::storage_read(&key) {
            assert_eq!(previous,value,"Payout parameters changed");
        } else {
            self.token.internal_transfer(&escrow,&receiver_id,amount.0,None);
            env::storage_write(&key,&value);
        }
        env::log_str(&format!("EVENT_JSON:{}",near_sdk::serde_json::json!({
            "standard":"pactpay_token","version":"1.0.0","event":"payout_recorded",
            "data":[{"escrow":escrow,"claim_id":claim_id,"recipient":receiver_id,"amount":amount}],
        })));
    }

    fn escrow_key(escrow: &AccountId) -> Vec<u8> {
        [b"pactpay:v2:payout:".as_slice(),escrow.as_bytes()].concat()
    }
}

near_contract_standards::impl_fungible_token_core!(DemoToken, token);
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};

#[near]
impl StorageManagement for DemoToken {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for DemoToken {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.into(),
            name: "PactPay Demo Token".into(),
            symbol: "PDEMO".into(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 0,
        }
    }
}
