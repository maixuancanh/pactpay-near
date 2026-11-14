use near_sdk::{
    env, ext_contract,
    json_types::{U128, U64},
    near,
    store::LookupMap,
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
};

const HOUR: u64 = 3600;
const DAY: u64 = 24 * HOUR;

#[allow(dead_code)]
#[ext_contract(ext_ft)]
trait Token {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[allow(dead_code)]
#[ext_contract(ext_self)]
trait Callback {
    fn finish_claim(&mut self, id: u64, index: u8, refund: bool) -> bool;
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Claim {
    Unclaimed,
    Pending,
    Paid,
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
    proposal: Option<Proposal>,
    allocation: Option<[U128; 2]>,
    claims: [Claim; 2],
}

#[near(serializers = [borsh, json])]
struct Proposal {
    refund: U128,
    payout: U128,
    expires: U64,
    revision: U64,
    approvals: u8,
}

#[near(serializers = [borsh, json])]
struct Remedy {
    commitment: String,
    revision: U64,
    due: U64,
    refund: U128,
    payout: U128,
    approvals: u8,
    completed: bool,
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
    bookings: LookupMap<u64, Booking>,
}

fn now() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

fn validate_split(share: u128, refund: u128, payout: u128) -> bool {
    refund.checked_add(payout) == Some(share)
}

fn log_event(event: &str, id: u64, index: u8) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        near_sdk::serde_json::json!({
            "standard": "pactpay", "version": "1.0.0", "event": event,
            "data": [{"booking": id, "position": index}]
        })
    ));
}

#[near]
impl Escrow {
    #[init]
    pub fn new(token: AccountId) -> Self {
        Self {
            token,
            next_id: 0,
            bookings: LookupMap::new(b"b"),
        }
    }

    #[payable]
    pub fn create_booking(
        &mut self,
        terms_commitment: String,
        fund_until: U64,
        service_end: U64,
        shares: Vec<Share>,
    ) -> u64 {
        let merchant = env::predecessor_account_id();
        assert!(
            terms_commitment.len() == 64 && terms_commitment.bytes().all(|b| b.is_ascii_hexdigit())
        );
        assert!(now() < fund_until.0 && fund_until.0 < service_end.0);
        assert!(service_end.0 < u64::MAX - 16 * DAY);
        assert!((1..=32).contains(&shares.len()));
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
                    proposal: None,
                    allocation: None,
                    claims: [Claim::Unclaimed; 2],
                }
            })
            .collect::<Vec<_>>();
        // Covers the bounded initial state and future growth of every position.
        let reserved_bytes = 512 + 512 * positions.len() as u128;
        assert!(
            env::attached_deposit().as_yoctonear()
                >= env::storage_byte_cost().as_yoctonear() * reserved_bytes,
            "Insufficient booking storage deposit"
        );
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
        let b = self.bookings.get_mut(&id).expect("Unknown booking");
        assert!(now() < b.fund_until.0 && b.terms_commitment == terms_commitment);
        let p = &mut b.positions[index as usize];
        assert_eq!(env::predecessor_account_id(), p.buyer);
        p.accepted = true;
    }

    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        assert_eq!(env::predecessor_account_id(), self.token);
        let Ok(c) = near_sdk::serde_json::from_str::<Contribution>(&msg) else {
            return PromiseOrValue::Value(amount);
        };
        let Some(b) = self.bookings.get_mut(&c.booking) else {
            return PromiseOrValue::Value(amount);
        };
        let Some(p) = b.positions.get_mut(c.position as usize) else {
            return PromiseOrValue::Value(amount);
        };
        if now() >= b.fund_until.0
            || !p.accepted
            || p.funded
            || p.buyer != sender_id
            || p.share.0 != amount.0
        {
            return PromiseOrValue::Value(amount);
        }
        p.funded = true;
        log_event("funded", c.booking, c.position);
        PromiseOrValue::Value(U128(0))
    }

    pub fn capture(&mut self, id: u64) {
        let b = self.bookings.get_mut(&id).expect("Unknown booking");
        assert_eq!(env::predecessor_account_id(), b.merchant);
        assert!(!b.captured && now() < b.service_end.0 && b.positions.iter().all(|p| p.funded));
        b.captured = true;
    }

    pub fn open_dispute(&mut self, id: u64, index: u8) {
        let b = self.bookings.get_mut(&id).expect("Unknown booking");
        assert!(b.captured && now() >= b.service_end.0 && now() < b.service_end.0 + 48 * HOUR);
        let p = &mut b.positions[index as usize];
        assert_eq!(env::predecessor_account_id(), p.buyer);
        assert!(p.dispute_until.is_none() && p.allocation.is_none());
        p.dispute_until = Some(U64(now() + 7 * DAY));
        log_event("dispute_opened", id, index);
    }

    pub fn revise_evidence(&mut self, id: u64, index: u8, commitment: String) -> U64 {
        assert!(commitment.len() == 64 && commitment.bytes().all(|b| b.is_ascii_hexdigit()));
        let (p, _) = self.dispute_actor(id, index);
        p.evidence_revision.0 = p
            .evidence_revision
            .0
            .checked_add(1)
            .expect("Revision exhausted");
        p.evidence_commitment = Some(commitment);
        p.proposal = None;
        p.evidence_revision
    }

    pub fn approve_extension(&mut self, id: u64, index: u8) {
        let (p, actor) = self.dispute_actor(id, index);
        assert!(!p.extended);
        p.extension_approvals |= actor;
        if p.extension_approvals == 3 {
            p.extended = true;
            p.dispute_until = Some(U64(p.dispute_until.unwrap().0 + 7 * DAY));
        }
    }

    pub fn approve_resolution(
        &mut self,
        id: u64,
        index: u8,
        refund: U128,
        payout: U128,
        expires: U64,
        evidence_revision: U64,
        expected_proposal_version: U64,
    ) {
        let (p, actor) = self.dispute_actor(id, index);
        assert_eq!(evidence_revision.0, p.evidence_revision.0);
        assert_eq!(
            expected_proposal_version.0, p.proposal_version.0,
            "Proposal changed"
        );
        assert!(expires.0 > now() && expires.0 <= p.dispute_until.unwrap().0);
        assert!(
            validate_split(p.share.0, refund.0, payout.0),
            "Invalid allocation"
        );
        let matching = p.proposal.as_ref().filter(|old| {
            old.refund.0 == refund.0
                && old.payout.0 == payout.0
                && old.expires.0 == expires.0
                && old.revision.0 == evidence_revision.0
        });
        let approvals = matching.map_or(actor, |old| old.approvals | actor);
        p.proposal_version.0 = p
            .proposal_version
            .0
            .checked_add(1)
            .expect("Proposal version exhausted");
        p.proposal = Some(Proposal {
            refund,
            payout,
            expires,
            revision: evidence_revision,
            approvals,
        });
        if approvals == 3 {
            p.allocation = Some([refund, payout]);
            log_event("allocated", id, index);
        }
    }

    pub fn confirm_completion(&mut self, id: u64, index: u8) {
        let b = self.bookings.get_mut(&id).expect("Unknown booking");
        assert!(b.captured && now() >= b.service_end.0);
        let p = &mut b.positions[index as usize];
        assert_eq!(env::predecessor_account_id(), p.buyer);
        assert!(p.funded && p.allocation.is_none() && p.dispute_until.is_none());
        p.allocation = Some([U128(0), p.share]);
        log_event("allocated", id, index);
    }

    pub fn get_remedy(&self, id: u64, index: u8) -> near_sdk::serde_json::Value {
        let remedies = LookupMap::<(u64, u8), Remedy>::new(&b"remedy-v1"[..]);
        near_sdk::serde_json::to_value(remedies.get(&(id, index))).expect("Serialize remedy")
    }

    pub fn propose_remedy(&mut self, id: u64, index: u8, due: U64, refund: U128, payout: U128) {
        let (p, actor) = self.dispute_actor(id, index);
        assert!(now() < due.0 && due.0 <= p.dispute_until.unwrap().0);
        assert!(validate_split(p.share.0, refund.0, payout.0));
        let commitment = p.evidence_commitment.clone().expect("Commit the remedy evidence first");
        let mut remedies = LookupMap::<(u64, u8), Remedy>::new(&b"remedy-v1"[..]);
        assert!(remedies.get(&(id, index)).is_none_or(|old| old.due.0 <= now() || old.revision != p.evidence_revision),
            "A remedy is already open for this evidence");
        remedies.insert((id, index), Remedy {
            commitment, revision: p.evidence_revision, due, refund, payout,
            approvals: actor, completed: false,
        });
        log_event("remedy_proposed", id, index);
    }

    pub fn accept_remedy(&mut self, id: u64, index: u8, revision: U64, due: U64) {
        let (p, actor) = self.dispute_actor(id, index);
        let mut remedies = LookupMap::<(u64, u8), Remedy>::new(&b"remedy-v1"[..]);
        let remedy = remedies.get_mut(&(id, index)).expect("No remedy");
        assert!(now() < remedy.due.0 && remedy.due == due);
        assert!(remedy.revision == revision && revision == p.evidence_revision);
        assert_eq!(remedy.approvals & actor, 0, "Already approved");
        remedy.approvals |= actor;
        log_event("remedy_accepted", id, index);
    }

    pub fn complete_remedy(&mut self, id: u64, index: u8, revision: U64, due: U64) {
        let (p, actor) = self.dispute_actor(id, index);
        assert_eq!(actor, 1, "Only the buyer can confirm completion");
        let mut remedies = LookupMap::<(u64, u8), Remedy>::new(&b"remedy-v1"[..]);
        let remedy = remedies.get_mut(&(id, index)).expect("No remedy");
        assert!(now() < remedy.due.0 && remedy.due == due && remedy.approvals == 3);
        assert!(remedy.revision == revision && revision == p.evidence_revision);
        remedy.completed = true;
        p.allocation = Some([remedy.refund, remedy.payout]);
        log_event("remedy_completed", id, index);
        log_event("allocated", id, index);
    }

    pub fn settle(&mut self, id: u64, index: u8) {
        let b = self.bookings.get_mut(&id).expect("Unknown booking");
        let p = &mut b.positions[index as usize];
        assert!(p.funded && p.allocation.is_none());
        let refund = if !b.captured {
            assert!(
                now() >= b.service_end.0
                    || (now() >= b.fund_until.0 && b.positions.iter().any(|p| !p.funded)),
                "Funding or capture still open"
            );
            true
        } else if let Some(until) = p.dispute_until {
            assert!(now() >= until.0);
            true
        } else {
            assert!(now() >= b.service_end.0 + 48 * HOUR);
            false
        };
        let p = &mut b.positions[index as usize];
        p.allocation = Some(if refund {
            [p.share, U128(0)]
        } else {
            [U128(0), p.share]
        });
        log_event("allocated", id, index);
    }

    pub fn claim(&mut self, id: u64, index: u8, refund: bool) -> Promise {
        let b = self.bookings.get_mut(&id).expect("Unknown booking");
        let p = &mut b.positions[index as usize];
        let slot = usize::from(!refund);
        let recipient = if refund { &p.buyer } else { &b.merchant };
        assert_eq!(&env::predecessor_account_id(), recipient);
        let amount = p.allocation.expect("Not allocated")[slot];
        assert!(amount.0 > 0 && p.claims[slot] == Claim::Unclaimed);
        p.claims[slot] = Claim::Pending;
        ext_ft::ext(self.token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(15))
            .ft_transfer(recipient.clone(), amount, None)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(20))
                    .finish_claim(id, index, refund),
            )
    }

    #[private]
    pub fn finish_claim(&mut self, id: u64, index: u8, refund: bool) -> bool {
        let b = self.bookings.get_mut(&id).expect("Unknown booking");
        let status = &mut b.positions[index as usize].claims[usize::from(!refund)];
        assert_eq!(*status, Claim::Pending);
        let success = match env::promise_result_checked(0, 16) {
            Ok(_) | Err(near_sdk::PromiseError::TooLong(_)) => true,
            Err(near_sdk::PromiseError::Failed) => false,
            Err(_) => env::panic_str("Unknown transfer outcome"),
        };
        *status = if success {
            Claim::Paid
        } else {
            Claim::Unclaimed
        };
        log_event(if success { "paid" } else { "claim_failed" }, id, index);
        success
    }

    /// Testnet operator repair, after checking the finalized token transfer receipt.
    /// The operator can only close a pending claim, never authorize another transfer.
    pub fn record_reconciled_payout(
        &mut self,
        id: u64,
        index: u8,
        refund: bool,
        transfer_receipt: String,
    ) {
        assert_eq!(env::predecessor_account_id(), env::current_account_id());
        assert!(
            (32..=44).contains(&transfer_receipt.len())
                && transfer_receipt.bytes().all(|b| {
                    b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".contains(&b)
                })
        );
        let b = self.bookings.get_mut(&id).expect("Unknown booking");
        let p = b
            .positions
            .get_mut(index as usize)
            .expect("Unknown position");
        let slot = usize::from(!refund);
        assert_eq!(p.claims[slot], Claim::Pending, "Claim is not pending");
        p.claims[slot] = Claim::Paid;
        env::log_str(&format!(
            "EVENT_JSON:{}",
            near_sdk::serde_json::json!({
                "standard":"pactpay","version":"1.0.0","event":"claim_reconciled",
                "data":[{"booking":id,"position":index,"refund":refund,"transfer_receipt":transfer_receipt}]
            })
        ));
    }

    pub fn get_token(&self) -> AccountId {
        self.token.clone()
    }

    pub fn get_booking(&self, id: u64) -> Option<near_sdk::serde_json::Value> {
        self.bookings
            .get(&id)
            .map(|b| near_sdk::serde_json::to_value(b).expect("Serialize booking"))
    }
}

impl Escrow {
    fn dispute_actor(&mut self, id: u64, index: u8) -> (&mut Position, u8) {
        let b = self.bookings.get_mut(&id).expect("Unknown booking");
        let p = &mut b.positions[index as usize];
        let who = env::predecessor_account_id();
        let actor = if who == p.buyer {
            1
        } else {
            assert_eq!(who, b.merchant);
            2
        };
        assert!(p.allocation.is_none() && now() < p.dispute_until.expect("No dispute").0);
        (p, actor)
    }
}

#[cfg(test)]
mod tests {
    use super::validate_split;

    #[test]
    fn exact_allocation_and_overflow() {
        assert!(validate_split(20, 8, 12));
        assert!(!validate_split(20, 8, 13));
        assert!(!validate_split(0, u128::MAX, 1));
    }
}
