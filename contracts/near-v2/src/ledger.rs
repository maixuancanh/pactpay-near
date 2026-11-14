use near_sdk::{
    json_types::{U128, U64},
    near, AccountId,
};

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ClaimStatus {
    Available,
    Pending,
    Paid,
}

#[near(serializers = [borsh, json])]
pub struct ClaimRecord {
    pub claim_id: U64,
    pub agreement_version: U64,
    pub recipient: AccountId,
    pub amount: U128,
    pub status: ClaimStatus,
    pub attempt_nonce: U64,
    #[serde(skip)]
    pub(crate) booking: u64,
    #[serde(skip)]
    pub(crate) position: u8,
}

#[near(serializers = [json])]
pub struct PositionLedger {
    pub funded: U128,
    pub unallocated: U128,
    pub retained: U128,
    pub available: U128,
    pub pending: U128,
    pub paid: U128,
}

impl PositionLedger {
    pub(crate) fn add(&mut self, claim: &ClaimRecord) {
        let bucket = match claim.status {
            ClaimStatus::Available => &mut self.available,
            ClaimStatus::Pending => &mut self.pending,
            ClaimStatus::Paid => &mut self.paid,
        };
        bucket.0 = bucket
            .0
            .checked_add(claim.amount.0)
            .expect("Ledger overflow");
    }
}
