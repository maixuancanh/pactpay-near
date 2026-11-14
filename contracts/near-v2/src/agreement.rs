use near_sdk::{
    env, near,
    serde_json::{json, to_vec},
    AccountId,
};

pub(crate) fn is_commitment(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn decimal<T: std::str::FromStr>(value: &str) -> T {
    assert!(
        !value.is_empty()
            && value.bytes().all(|b| b.is_ascii_digit())
            && (value.len() == 1 || !value.starts_with('0')),
        "Noncanonical decimal"
    );
    value.parse().ok().expect("Decimal out of range")
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgreementV2 {
    pub schema: String,
    pub network: String,
    pub escrow: AccountId,
    pub booking: String,
    pub position: String,
    pub version: String,
    pub buyer: AccountId,
    pub merchant: AccountId,
    pub token: AccountId,
    pub terms_commitment: String,
    pub evidence_root: String,
    pub private_terms_commitment: String,
    pub assessment_digest: Option<String>,
    pub immediate_buyer: String,
    pub immediate_merchant: String,
    pub retained: String,
    pub success_buyer: String,
    pub success_merchant: String,
    pub fallback_buyer: String,
    pub fallback_merchant: String,
    pub accept_by: String,
    pub deliver_by: String,
    pub review_until: String,
    pub salt: String,
}

impl AgreementV2 {
    pub(crate) fn digest(&self) -> String {
        let wire = json!([
            self.schema,
            self.network,
            self.escrow,
            self.booking,
            self.position,
            self.version,
            self.buyer,
            self.merchant,
            self.token,
            self.terms_commitment,
            self.evidence_root,
            self.private_terms_commitment,
            self.assessment_digest,
            self.immediate_buyer,
            self.immediate_merchant,
            self.retained,
            self.success_buyer,
            self.success_merchant,
            self.fallback_buyer,
            self.fallback_merchant,
            self.accept_by,
            self.deliver_by,
            self.review_until,
            self.salt,
        ]);
        env::sha256_array(&to_vec(&wire).expect("Serialize agreement"))
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    pub(crate) fn validate_commitments(&self) {
        assert_eq!(self.schema, "pactpay.resolution.v2");
        assert_eq!(self.network, "testnet");
        assert!(
            [
                &self.terms_commitment,
                &self.evidence_root,
                &self.private_terms_commitment,
                &self.salt
            ]
            .into_iter()
            .all(|value| is_commitment(value))
                && self.assessment_digest.as_deref().is_none_or(is_commitment),
            "Invalid commitment"
        );
    }

    pub(crate) fn deadlines(&self) -> [u64; 3] {
        [
            decimal(&self.accept_by),
            decimal(&self.deliver_by),
            decimal(&self.review_until),
        ]
    }

    pub(crate) fn allocations(&self) -> ([u128; 2], u128, [u128; 2], [u128; 2]) {
        (
            [
                decimal(&self.immediate_buyer),
                decimal(&self.immediate_merchant),
            ],
            decimal(&self.retained),
            [
                decimal(&self.success_buyer),
                decimal(&self.success_merchant),
            ],
            [
                decimal(&self.fallback_buyer),
                decimal(&self.fallback_merchant),
            ],
        )
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgreementStatus {
    Proposed,
    Expired,
    Active,
    CompletionSubmitted,
    Completed,
    FallbackAllocated,
}

impl AgreementStatus {
    pub(crate) fn is_running(self) -> bool {
        matches!(self, Self::Active | Self::CompletionSubmitted)
    }
}

#[near(serializers = [borsh, json])]
pub struct Agreement {
    pub proposal: AgreementV2,
    pub digest: String,
    pub status: AgreementStatus,
    pub approvals: u8,
    pub completion_evidence_root: Option<String>,
    pub objection_evidence_root: Option<String>,
}

impl Agreement {
    pub(crate) fn matches(&self, version: u64, digest: Option<&str>) {
        assert_eq!(
            self.proposal.version,
            version.to_string(),
            "Proposal changed"
        );
        if let Some(digest) = digest {
            assert_eq!(self.digest, digest, "Proposal changed");
        }
    }
}
