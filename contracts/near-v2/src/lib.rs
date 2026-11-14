mod agreement;
mod events;
mod ledger;

use agreement::{is_commitment, Agreement, AgreementStatus, AgreementV2};
use events::emit;
use ledger::{ClaimRecord, ClaimStatus, PositionLedger};
use near_sdk::{
    env, ext_contract,
    json_types::{U128, U64},
    near,
    serde_json::{json, Value},
    store::LookupMap,
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
};

const HOUR: u64 = 3600;
const DAY: u64 = 24 * HOUR;
const BUYER: u8 = 1;
const MERCHANT: u8 = 2;
const BOTH: u8 = BUYER | MERCHANT;

#[allow(dead_code)]
#[ext_contract(ext_ft)]
trait Token {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn pactpay_transfer_once(&mut self, claim_id: U64, receiver_id: AccountId, amount: U128);
}

#[allow(dead_code)]
#[ext_contract(ext_self)]
trait Callback {
    fn finish_claim_v2(&mut self, claim_id: U64, attempt_nonce: U64) -> bool;
}

#[near(serializers = [borsh, json])]
struct Position {
    buyer: AccountId,
    share: U128,
    accepted: bool,
    funded: bool,
    dispute_until: Option<U64>,
    extended: bool,
    extension_approvals: u8,
    evidence_revision: U64,
    evidence_commitment: Option<String>,
    proposal_version: U64,
    #[serde(skip)]
    agreement: Option<Agreement>,
    #[serde(skip)]
    claim_ids: Vec<U64>,
    unallocated: U128,
    retained: U128,
    has_allocation: bool,
}

#[near(serializers = [borsh, json])]
struct Booking {
    merchant: AccountId,
    terms_commitment: String,
    fund_until: U64,
    service_end: U64,
    captured: bool,
    positions: Vec<Position>,
}

#[near(serializers = [json])]
pub struct Share {
    buyer: AccountId,
    amount: U128,
}

#[near(serializers = [json])]
struct Contribution {
    booking: u64,
    position: u8,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Escrow {
    token: AccountId,
    next_id: u64,
    next_claim: u64,
    bookings: LookupMap<u64, Booking>,
    claims: LookupMap<u64, ClaimRecord>,
}

fn now() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

fn check_position_split(amount: u128, split: [u128; 2], retained: u128) {
    let sum = split[0]
        .checked_add(split[1])
        .and_then(|total| total.checked_add(retained));
    assert_eq!(sum, Some(amount), "Invalid allocation");
}

fn actor(merchant: &AccountId, buyer: &AccountId) -> u8 {
    let account = env::predecessor_account_id();
    if &account == buyer {
        BUYER
    } else {
        assert_eq!(&account, merchant, "Only booking participants may act");
        MERCHANT
    }
}

fn basic_event(event: &str, id: u64, index: u8) {
    emit(
        event,
        json!({"booking": id.to_string(), "position": index.to_string(),
        "actor": env::predecessor_account_id()}),
    );
}

fn agreement_event(event: &str, id: u64, index: u8, agreement: &Agreement, claim_ids: &[U64]) {
    emit(
        event,
        json!({
            "booking": id.to_string(), "position": index.to_string(),
            "actor": env::predecessor_account_id(), "version": agreement.proposal.version,
            "digest": agreement.digest, "status": agreement.status,
            "claim_ids": claim_ids, "approvals": agreement.approvals,
            "completion_evidence_root": agreement.completion_evidence_root,
            "objection_evidence_root": agreement.objection_evidence_root,
        }),
    );
}

fn claim_event(event: &str, claim: &ClaimRecord, token: &AccountId) {
    emit(
        event,
        json!({
            "booking": claim.booking.to_string(), "position": claim.position.to_string(),
            "actor": env::predecessor_account_id(), "version": claim.agreement_version,
            "claim_id": claim.claim_id, "recipient": claim.recipient, "amount": claim.amount,
            "status": claim.status, "attempt_nonce": claim.attempt_nonce, "attempt": claim.attempt_nonce,
            "token": token,
        }),
    );
}

#[near]
impl Escrow {
    #[init]
    pub fn new(token: AccountId) -> Self {
        Self {
            token,
            next_id: 0,
            next_claim: 0,
            bookings: LookupMap::new(&b"booking-v2"[..]),
            claims: LookupMap::new(&b"claim-v2"[..]),
        }
    }

    pub fn contract_version(&self) -> u8 {
        2
    }

    pub fn booking_storage_deposit(&self, positions: u8) -> U128 {
        assert!((1..=32).contains(&positions), "Invalid position count");
        // A position holds one bounded proposal and up to four claim records, plus keys and storage overhead.
        let reserved_bytes = 1024 + 4096 * u128::from(positions);
        U128(env::storage_byte_cost().as_yoctonear() * reserved_bytes)
    }

    #[payable]
    pub fn create_booking(
        &mut self,
        terms_commitment: String,
        fund_until: U64,
        service_end: U64,
        shares: Vec<Share>,
    ) -> u64 {
        assert!(is_commitment(&terms_commitment), "Invalid terms commitment");
        assert!(now() < fund_until.0 && fund_until.0 < service_end.0);
        assert!(service_end.0 < u64::MAX - 16 * DAY);
        let positions_count = u8::try_from(shares.len()).expect("Too many positions");
        assert!(
            env::attached_deposit().as_yoctonear()
                >= self.booking_storage_deposit(positions_count).0,
            "Insufficient booking storage deposit"
        );
        let merchant = env::predecessor_account_id();
        let mut seen = std::collections::BTreeSet::new();
        let positions = shares
            .into_iter()
            .map(|s| {
                assert!(s.amount.0 > 0 && s.buyer != merchant && seen.insert(s.buyer.clone()));
                Position {
                    buyer: s.buyer,
                    share: s.amount,
                    accepted: false,
                    funded: false,
                    dispute_until: None,
                    extended: false,
                    extension_approvals: 0,
                    evidence_revision: U64(0),
                    evidence_commitment: None,
                    proposal_version: U64(0),
                    agreement: None,
                    claim_ids: Vec::new(),
                    unallocated: U128(0),
                    retained: U128(0),
                    has_allocation: false,
                }
            })
            .collect();
        let id = self.next_id;
        self.next_id = id.checked_add(1).expect("Booking ID exhausted");
        self.bookings.insert(
            id,
            Booking {
                merchant,
                terms_commitment,
                fund_until,
                service_end,
                captured: false,
                positions,
            },
        );
        id
    }

    pub fn accept(&mut self, id: u64, index: u8, terms_commitment: String) {
        let booking = self.bookings.get_mut(&id).expect("Unknown booking");
        assert!(now() < booking.fund_until.0 && booking.terms_commitment == terms_commitment);
        let position = booking
            .positions
            .get_mut(index as usize)
            .expect("Unknown position");
        assert_eq!(env::predecessor_account_id(), position.buyer);
        position.accepted = true;
    }

    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        assert_eq!(env::predecessor_account_id(), self.token);
        let Ok(contribution) = near_sdk::serde_json::from_str::<Contribution>(&msg) else {
            return PromiseOrValue::Value(amount);
        };
        let Some(booking) = self.bookings.get_mut(&contribution.booking) else {
            return PromiseOrValue::Value(amount);
        };
        let Some(position) = booking.positions.get_mut(contribution.position as usize) else {
            return PromiseOrValue::Value(amount);
        };
        if now() >= booking.fund_until.0
            || !position.accepted
            || position.funded
            || position.buyer != sender_id
            || position.share.0 != amount.0
        {
            return PromiseOrValue::Value(amount);
        }
        position.funded = true;
        position.unallocated = amount;
        basic_event("funded", contribution.booking, contribution.position);
        PromiseOrValue::Value(U128(0))
    }

    pub fn capture(&mut self, id: u64) {
        let booking = self.bookings.get_mut(&id).expect("Unknown booking");
        assert_eq!(env::predecessor_account_id(), booking.merchant);
        assert!(
            !booking.captured
                && now() < booking.service_end.0
                && booking.positions.iter().all(|p| p.funded)
        );
        booking.captured = true;
    }

    pub fn open_dispute(&mut self, id: u64, index: u8) {
        let booking = self.bookings.get_mut(&id).expect("Unknown booking");
        assert!(
            booking.captured
                && now() >= booking.service_end.0
                && now() < booking.service_end.0 + 48 * HOUR
        );
        let position = booking
            .positions
            .get_mut(index as usize)
            .expect("Unknown position");
        assert_eq!(env::predecessor_account_id(), position.buyer);
        assert!(position.dispute_until.is_none() && !position.has_allocation);
        position.dispute_until = Some(U64(now() + 7 * DAY));
        basic_event("dispute_opened", id, index);
    }

    pub fn revise_evidence(&mut self, id: u64, index: u8, commitment: String) -> U64 {
        assert!(is_commitment(&commitment), "Invalid evidence commitment");
        let (position, _) = self.dispute_actor(id, index);
        position.evidence_revision.0 = position
            .evidence_revision
            .0
            .checked_add(1)
            .expect("Revision exhausted");
        position.evidence_commitment = Some(commitment);
        if let Some(agreement) = position.agreement.as_mut() {
            if agreement.status == AgreementStatus::Proposed {
                agreement.status = AgreementStatus::Expired;
                agreement_event("agreement_expired", id, index, agreement, &[]);
            }
        }
        position.evidence_revision
    }

    pub fn approve_extension(&mut self, id: u64, index: u8) {
        let (position, actor) = self.dispute_actor(id, index);
        assert!(!position.extended && !position.has_allocation);
        position.extension_approvals |= actor;
        if position.extension_approvals == BOTH {
            position.extended = true;
            position.dispute_until = Some(U64(position.dispute_until.unwrap().0 + 7 * DAY));
        }
    }

    pub fn propose_agreement(&mut self, id: u64, index: u8, proposal: AgreementV2) {
        let booking = self.bookings.get_mut(&id).expect("Unknown booking");
        let position = booking
            .positions
            .get_mut(index as usize)
            .expect("Unknown position");
        let approval = actor(&booking.merchant, &position.buyer);
        let dispute_until = position.dispute_until.expect("No dispute").0;
        assert!(
            position.funded && !position.has_allocation,
            "Already allocated"
        );
        let version = position
            .proposal_version
            .0
            .checked_add(1)
            .expect("Proposal version exhausted");
        proposal.validate_commitments();
        assert_eq!(proposal.escrow, env::current_account_id());
        assert_eq!(proposal.booking, id.to_string());
        assert_eq!(proposal.position, index.to_string());
        assert_eq!(proposal.version, version.to_string(), "Proposal changed");
        assert_eq!(proposal.buyer, position.buyer);
        assert_eq!(proposal.merchant, booking.merchant);
        assert_eq!(proposal.token, self.token);
        assert_eq!(proposal.terms_commitment, booking.terms_commitment);
        assert_eq!(
            Some(proposal.evidence_root.as_str()),
            position.evidence_commitment.as_deref(),
            "Evidence changed"
        );
        let [accept_by, deliver_by, review_until] = proposal.deadlines();
        assert!(
            now() < accept_by
                && accept_by < deliver_by
                && deliver_by < review_until
                && review_until <= dispute_until,
            "Invalid agreement deadlines"
        );
        let (immediate, retained, success, fallback) = proposal.allocations();
        check_position_split(position.unallocated.0, immediate, retained);
        check_position_split(retained, success, 0);
        check_position_split(retained, fallback, 0);
        let agreement = Agreement {
            digest: proposal.digest(),
            proposal,
            approvals: approval,
            status: AgreementStatus::Proposed,
            completion_evidence_root: None,
            objection_evidence_root: None,
        };
        agreement_event("agreement_proposed", id, index, &agreement, &[]);
        position.agreement = Some(agreement);
        position.proposal_version = U64(version);
    }

    pub fn approve_agreement(&mut self, id: u64, index: u8, version: U64, digest: String) {
        let booking = self.bookings.get_mut(&id).expect("Unknown booking");
        let position = booking
            .positions
            .get_mut(index as usize)
            .expect("Unknown position");
        let approval = actor(&booking.merchant, &position.buyer);
        let agreement = position.agreement.as_mut().expect("No agreement");
        agreement.matches(version.0, Some(&digest));
        assert!(
            agreement.status == AgreementStatus::Proposed && !position.has_allocation,
            "Agreement not proposed"
        );
        assert!(
            now() < agreement.proposal.deadlines()[0],
            "Approval deadline passed"
        );
        assert_eq!(agreement.approvals & approval, 0, "Already approved");
        assert_eq!(
            Some(agreement.proposal.evidence_root.as_str()),
            position.evidence_commitment.as_deref(),
            "Evidence changed"
        );
        agreement.approvals |= approval;
        agreement.status = AgreementStatus::Active;
        let (immediate, retained, _, _) = agreement.proposal.allocations();
        position.unallocated = U128(0);
        position.retained = U128(retained);
        position.has_allocation = true;
        let claim_ids = Self::allocate(
            &mut self.claims,
            &mut self.next_claim,
            &self.token,
            (id, index),
            version,
            [&position.buyer, &booking.merchant],
            immediate,
        );
        agreement_event("agreement_activated", id, index, agreement, &claim_ids);
        position.claim_ids.extend(claim_ids);
    }

    pub fn submit_completion(&mut self, id: u64, index: u8, version: U64, evidence_root: String) {
        assert!(
            is_commitment(&evidence_root),
            "Invalid completion commitment"
        );
        let booking = self.bookings.get_mut(&id).expect("Unknown booking");
        assert_eq!(env::predecessor_account_id(), booking.merchant);
        let agreement = booking.positions[index as usize]
            .agreement
            .as_mut()
            .expect("No agreement");
        agreement.matches(version.0, None);
        assert!(
            agreement.status == AgreementStatus::Active
                && now() < agreement.proposal.deadlines()[1],
            "Completion unavailable"
        );
        agreement.completion_evidence_root = Some(evidence_root);
        agreement.status = AgreementStatus::CompletionSubmitted;
        agreement_event("agreement_completion_submitted", id, index, agreement, &[]);
    }

    pub fn object_agreement(&mut self, id: u64, index: u8, version: U64, evidence_root: String) {
        assert!(
            is_commitment(&evidence_root),
            "Invalid objection commitment"
        );
        let booking = self.bookings.get_mut(&id).expect("Unknown booking");
        let position = &mut booking.positions[index as usize];
        assert_eq!(env::predecessor_account_id(), position.buyer);
        let agreement = position.agreement.as_mut().expect("No agreement");
        agreement.matches(version.0, None);
        assert!(
            agreement.status == AgreementStatus::CompletionSubmitted
                && now() < agreement.proposal.deadlines()[2],
            "Objection unavailable"
        );
        agreement.objection_evidence_root = Some(evidence_root);
        agreement_event("agreement_objected", id, index, agreement, &[]);
    }

    pub fn confirm_agreement_completion(
        &mut self,
        id: u64,
        index: u8,
        version: U64,
        digest: String,
    ) {
        self.resolve_agreement(id, index, version, Some(&digest));
    }

    pub fn settle_agreement(&mut self, id: u64, index: u8, version: U64) {
        self.resolve_agreement(id, index, version, None);
    }

    pub fn confirm_completion(&mut self, id: u64, index: u8) {
        let booking = self.bookings.get(&id).expect("Unknown booking");
        assert!(booking.captured && now() >= booking.service_end.0);
        let position = &booking.positions[index as usize];
        assert_eq!(env::predecessor_account_id(), position.buyer);
        assert!(position.funded && !position.has_allocation && position.dispute_until.is_none());
        self.allocate_legacy_policy(id, index, false);
    }

    pub fn settle(&mut self, id: u64, index: u8) {
        let booking = self.bookings.get(&id).expect("Unknown booking");
        let position = &booking.positions[index as usize];
        assert!(
            position.funded && !position.has_allocation,
            "Already allocated or unfunded"
        );
        let refund = if !booking.captured {
            assert!(
                now() >= booking.service_end.0
                    || (now() >= booking.fund_until.0
                        && booking.positions.iter().any(|p| !p.funded)),
                "Funding or capture still open"
            );
            true
        } else if let Some(until) = position.dispute_until {
            assert!(now() >= until.0, "Dispute still open");
            true
        } else {
            assert!(now() >= booking.service_end.0 + 48 * HOUR);
            false
        };
        self.allocate_legacy_policy(id, index, refund);
    }

    pub fn claim_v2(&mut self, claim_id: U64) -> Promise {
        assert!(!self.is_retryable_claim(claim_id), "Use the retryable payout method");
        let claim = self.claims.get_mut(&claim_id.0).expect("Unknown claim");
        assert_eq!(env::predecessor_account_id(), claim.recipient);
        assert_eq!(claim.status, ClaimStatus::Available, "Claim unavailable");
        claim.attempt_nonce.0 = claim
            .attempt_nonce
            .0
            .checked_add(1)
            .expect("Attempt exhausted");
        claim.status = ClaimStatus::Pending;
        claim_event("claim_pending", claim, &self.token);
        ext_ft::ext(self.token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(15))
            .ft_transfer(claim.recipient.clone(), claim.amount, None)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(20))
                    .finish_claim_v2(claim_id, claim.attempt_nonce),
            )
    }

    pub fn is_retryable_claim(&self, claim_id: U64) -> bool {
        env::storage_has_key(&Self::retryable_key(claim_id))
    }

    pub fn claim_retryable_v2(&mut self, claim_id: U64) -> Promise {
        let retryable = self.is_retryable_claim(claim_id);
        let claim = self.claims.get_mut(&claim_id.0).expect("Unknown claim");
        assert_eq!(env::predecessor_account_id(), claim.recipient);
        assert!(claim.status == ClaimStatus::Available ||
            (retryable && claim.status == ClaimStatus::Pending), "Claim unavailable");
        env::storage_write(&Self::retryable_key(claim_id), b"1");
        claim.attempt_nonce.0 = claim.attempt_nonce.0.checked_add(1).expect("Attempt exhausted");
        claim.status = ClaimStatus::Pending;
        claim_event("claim_pending", claim, &self.token);
        ext_ft::ext(self.token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(25))
            .pactpay_transfer_once(claim_id, claim.recipient.clone(), claim.amount)
            .then(ext_self::ext(env::current_account_id())
                .with_static_gas(Gas::from_tgas(20))
                .finish_claim_v2(claim_id, claim.attempt_nonce))
    }

    fn retryable_key(claim_id: U64) -> Vec<u8> {
        [b"pactpay:v2:retryable:".as_slice(), &claim_id.0.to_le_bytes()].concat()
    }

    #[private]
    pub fn finish_claim_v2(&mut self, claim_id: U64, attempt_nonce: U64) -> bool {
        let claim = self.claims.get_mut(&claim_id.0).expect("Unknown claim");
        if claim.status != ClaimStatus::Pending
            || claim.attempt_nonce != attempt_nonce
            || env::promise_results_count() != 1
        {
            return false;
        }
        let success = match env::promise_result_checked(0, 16) {
            Ok(_) | Err(near_sdk::PromiseError::TooLong(_)) => true,
            Err(near_sdk::PromiseError::Failed) => false,
            Err(_) => return false,
        };

        // This opt-in test build simulates losing the callback after an actual token transfer.
        if cfg!(feature = "sandbox-callback-fault") {
            env::panic_str("Injected Sandbox callback failure");
        }
        claim.status = if success {
            ClaimStatus::Paid
        } else {
            ClaimStatus::Available
        };
        claim_event(
            if success {
                "claim_paid"
            } else {
                "claim_failed"
            },
            claim,
            &self.token,
        );
        success
    }

    pub fn get_token(&self) -> AccountId {
        self.token.clone()
    }

    /// Testnet operator attestation after independent checks of finalized receipts.
    /// This only records a payout. It cannot send a token transfer.
    #[private]
    pub fn reconcile_paid_claim_v2(
        &mut self,
        claim_id: U64,
        attempt_nonce: U64,
        transfer_receipt: String,
    ) {
        self.reconcile_claim_outcome(claim_id, attempt_nonce, transfer_receipt, true);
    }

    #[private]
    pub fn reconcile_failed_claim_v2(
        &mut self,
        claim_id: U64,
        attempt_nonce: U64,
        transfer_receipt: String,
    ) {
        self.reconcile_claim_outcome(claim_id, attempt_nonce, transfer_receipt, false);
    }

    fn reconcile_claim_outcome(&mut self, claim_id: U64, attempt_nonce: U64, transfer_receipt: String, paid: bool) {
        assert!(!self.is_retryable_claim(claim_id), "Recipient can retry this payout");
        assert!(
            (32..=44).contains(&transfer_receipt.len())
                && transfer_receipt.bytes().all(|c|
                    b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".contains(&c)),
            "Invalid transfer receipt"
        );
        let claim = self.claims.get_mut(&claim_id.0).expect("Unknown claim");
        assert_eq!(claim.status, ClaimStatus::Pending, "Claim is not pending");
        assert_eq!(claim.attempt_nonce, attempt_nonce, "Claim attempt changed");
        let key = [b"pactpay-v2-reconciled:".as_slice(), transfer_receipt.as_bytes()].concat();
        assert!(!env::storage_write(&key, &claim_id.0.to_le_bytes()), "Transfer receipt already recorded");
        claim.status = if paid { ClaimStatus::Paid } else { ClaimStatus::Available };
        claim_event(if paid { "claim_reconciled" } else { "claim_reopened" }, claim, &self.token);
        emit("reconciliation_receipt", json!({
            "claim_id": claim_id, "attempt_nonce": attempt_nonce, "transfer_receipt": transfer_receipt,
        }));
    }

    pub fn get_booking(&self, id: u64) -> Option<Value> {
        self.bookings
            .get(&id)
            .map(|booking| near_sdk::serde_json::to_value(booking).expect("Serialize booking"))
    }

    pub fn get_agreement(&self, id: u64, index: u8) -> Option<Value> {
        let agreement = self
            .bookings
            .get(&id)?
            .positions
            .get(index as usize)?
            .agreement
            .as_ref()?;
        let mut view = near_sdk::serde_json::to_value(agreement).expect("Serialize agreement");
        if agreement.status == AgreementStatus::Proposed
            && now() >= agreement.proposal.deadlines()[0]
        {
            view["status"] = json!(AgreementStatus::Expired);
        }
        Some(view)
    }

    pub fn get_claims(
        &self,
        id: u64,
        index: u8,
        from_index: Option<u8>,
        limit: Option<u8>,
    ) -> Vec<&ClaimRecord> {
        self.position(id, index)
            .claim_ids
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(4) as usize)
            .map(|claim_id| self.claims.get(&claim_id.0).expect("Missing claim"))
            .collect()
    }

    pub fn get_position_ledger(&self, id: u64, index: u8) -> PositionLedger {
        let position = self.position(id, index);
        let mut ledger = PositionLedger {
            funded: if position.funded {
                position.share
            } else {
                U128(0)
            },
            unallocated: position.unallocated,
            retained: position.retained,
            available: U128(0),
            pending: U128(0),
            paid: U128(0),
        };
        for claim in self.get_claims(id, index, None, None) {
            ledger.add(claim);
        }
        ledger
    }
}

impl Escrow {
    fn position(&self, id: u64, index: u8) -> &Position {
        self.bookings
            .get(&id)
            .expect("Unknown booking")
            .positions
            .get(index as usize)
            .expect("Unknown position")
    }

    fn dispute_actor(&mut self, id: u64, index: u8) -> (&mut Position, u8) {
        let booking = self.bookings.get_mut(&id).expect("Unknown booking");
        let position = booking
            .positions
            .get_mut(index as usize)
            .expect("Unknown position");
        let role = actor(&booking.merchant, &position.buyer);
        assert!(
            now() < position.dispute_until.expect("No dispute").0,
            "Dispute closed"
        );
        (position, role)
    }

    fn allocate(
        claims: &mut LookupMap<u64, ClaimRecord>,
        next_claim: &mut u64,
        token: &AccountId,
        (booking, position): (u64, u8),
        agreement_version: U64,
        recipients: [&AccountId; 2],
        split: [u128; 2],
    ) -> Vec<U64> {
        let mut claim_ids = Vec::with_capacity(2);
        for (recipient, amount) in recipients.into_iter().zip(split) {
            if amount == 0 {
                continue;
            }
            let id = *next_claim;
            *next_claim = id.checked_add(1).expect("Claim ID exhausted");
            let claim = ClaimRecord {
                claim_id: U64(id),
                agreement_version,
                recipient: recipient.clone(),
                amount: U128(amount),
                status: ClaimStatus::Available,
                attempt_nonce: U64(0),
                booking,
                position,
            };
            claim_event("claim_allocated", &claim, token);
            claims.insert(id, claim);
            claim_ids.push(U64(id));
        }
        claim_ids
    }

    fn allocate_legacy_policy(&mut self, id: u64, index: u8, refund: bool) {
        let booking = self.bookings.get_mut(&id).expect("Unknown booking");
        let position = &mut booking.positions[index as usize];
        let amount = position.unallocated.0;
        let split = if refund { [amount, 0] } else { [0, amount] };
        position.unallocated = U128(0);
        position.has_allocation = true;
        position.claim_ids = Self::allocate(
            &mut self.claims,
            &mut self.next_claim,
            &self.token,
            (id, index),
            U64(0),
            [&position.buyer, &booking.merchant],
            split,
        );
    }

    fn resolve_agreement(&mut self, id: u64, index: u8, version: U64, digest: Option<&str>) {
        let booking = self.bookings.get_mut(&id).expect("Unknown booking");
        let position = &mut booking.positions[index as usize];
        let agreement = position.agreement.as_mut().expect("No agreement");
        agreement.matches(version.0, digest);
        assert!(agreement.status.is_running(), "Agreement is not active");
        let review_until = agreement.proposal.deadlines()[2];
        let (_, _, success, fallback) = agreement.proposal.allocations();
        let (status, split, event) = if digest.is_some() {
            assert_eq!(env::predecessor_account_id(), position.buyer);
            assert!(
                agreement.status == AgreementStatus::CompletionSubmitted && now() < review_until,
                "Confirmation unavailable"
            );
            (AgreementStatus::Completed, success, "agreement_completed")
        } else {
            assert!(now() >= review_until, "Review still open");
            (
                AgreementStatus::FallbackAllocated,
                fallback,
                "agreement_fallback_allocated",
            )
        };
        check_position_split(position.retained.0, split, 0);
        position.retained = U128(0);
        agreement.status = status;
        let claim_ids = Self::allocate(
            &mut self.claims,
            &mut self.next_claim,
            &self.token,
            (id, index),
            version,
            [&position.buyer, &booking.merchant],
            split,
        );
        agreement_event(event, id, index, agreement, &claim_ids);
        position.claim_ids.extend(claim_ids);
    }
}
