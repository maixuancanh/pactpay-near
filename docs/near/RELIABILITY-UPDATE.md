# Agreement previews, verification and recovery

This post-deadline update applies ideas from PortalDot winners to PactPay's existing escrow flow. It does not add a bridge, another token or autonomous payment authority.

## Review an agreement before signing

The Agreement tab shows three selectable outcomes: both parties agree, the buyer confirms the remedy, and the review deadline passes. Each displays the exact proposal amounts and recipients, including funds remaining in escrow. The preview distinguishes an allocation from a completed token transfer and labels completed or expired proposals as reference-only. Signing still checks fresh chain state, version, digest and expiry.

## Try seven altered proofs

The Verify page starts from the public synthetic Booking #5 proof. A reviewer can change the amount, recipient, booking reference, evidence root, approval reference, attestation nonce or payout receipt duplication. The page shows the original value, changed value, expected check and observed result. Missing evidence is Incomplete; a failed binding is Invalid; an unavailable RPC is not proof of invalidity. These actions do not sign or send transactions. Authorized opening material stays in the browser.

## Bound AI attempts

The authenticated case endpoint exposes the existing limit of three attempts per account and share per UTC day. Reading the budget does not consume it. Ticket reservations are atomic; provider failures may consume a reserved attempt. The UI asks before reserving, warns about repeated inputs in the current session, and shows remaining attempts and reset time. The inference response includes elapsed verification time and provider-reported token usage when available. This is not verified billing. The output limit remains 900 tokens.

## Recover history without retrying payments

[The replay and release-gate notes](STATEFUL-RECOVERY-GATE.md) document durable event identities, interruption and process-termination tests, and the standalone replay CLI. Replay reads finalized receipts and writes history; it cannot send a payout. Coverage is limited to supplied transaction references. A scheduler and complete chain discovery are not included.

On November 17, the CLI also replayed Booking #5's proposal, approval and two claim transactions from public finalized Testnet receipts. Running it again produced the same four events and left the durable file count unchanged at 12.

## Measured transaction cost

[The read-only Booking #5 cost record](workshop-ai-cost.json) measures four finalized transactions: proposal, approval and two payout claims. Their transaction and receipt outcomes burned 0.0021781632099668 NEAR in total. Attached deposits are excluded. This is not the full booking lifecycle cost, a storage estimate or a future fee quote. AI billing remains unmeasured.

Reproduce the measurement with `node scripts/near/case-cost.mjs`. It requires public Testnet RPC access, not a wallet.

The separate [sandbox comparison](sandbox-cost-2026-11-17.json) runs creation, acceptance, funding, capture, normal completion and claims with 1, 3 and 10 buyers. These are isolated sandbox measurements, not Testnet receipts or mainnet fee quotes.

| Buyers | Total gas (Tgas) | Signed transactions | Booking storage deposit (NEAR units) |
| --- | ---: | ---: | ---: |
| 1 | 23.8275 | 6 | 0.0512 |
| 3 | 63.2570 | 14 | 0.13312 |
| 10 | 206.3064 | 42 | 0.41984 |

Storage deposits are reserves, not gas burned. Setup, minting, token-registration gas, disputes and AI are excluded. Every measured share ended paid with zero pending claims, and the escrow token balance returned to zero. The benchmark makes no AI calls; it does not estimate AI cost by group size.

## Who is trusted for what

| Component | Responsibility and boundary |
| --- | --- |
| Buyer and merchant | Review evidence and approve the same agreement. AI cannot approve for either party. |
| NEAR escrow | Enforces signed allocations, deadlines, permissions and claim state. |
| Token contract | Executes transfers; finalized receipts and balances matter when callback state lags. |
| NEAR AI Cloud | Supplies attested inference and signed ciphertext. Portable independent verification of the plaintext response remains unavailable. |
| History service | Helps discover known references. Its database is not a substitute for finalized chain receipts. |
| Browser | Opens authorized evidence locally. Public synthetic demo opening material must not be reused for private cases. |

The [local sandbox gate](stateful-release-gate-2026-11-17.json) passed with a separately pinned deployed Testnet escrow WASM as the baseline and a newly built candidate. Their hashes differ, and [finalized code provenance](stateful-gate-code-sources.json) is recorded. It preserved funded state across redeployment, recovered a lost callback without paying twice, and rejected an intentionally corrupting migration. Nine comparisons also matched the UI projection to executed contract claims across immediate, success and fallback branches. The state fixtures were created in isolation; this is current-schema compatibility evidence, not a production-state migration or contract audit. The CI helper defaults to baseline and candidate built from the same source. Mainnet booking deposits through Intents remain deferred.

## Web release checks

Production deployment `dpl_94aLGgUTR45gMxTgFGCo1unKvEZB` was checked on the public PactPay domain on November 17. A browser selected all seven modified-proof cases, opened Booking #5 and switched through the three forecast branches. The desktop and 390px-wide checks reported no uncaught page errors or horizontal overflow. This read-only check does not substitute for signing a new agreement with two wallets.

The local frontend suite passed 45 tests. Backend checks cover the budget under concurrent requests, cost receipt validation, replay, and verifier rejection cases. Sandbox gate results are recorded separately in their manifest; a web build passing does not establish contract migration compatibility.
