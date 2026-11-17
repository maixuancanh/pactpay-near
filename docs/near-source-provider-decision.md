# Source verification for a delivery receipt

PactPay can attach one issuer-signed `access-granted` receipt to an authorized agreement export. The receipt commits to the recipient, agreement scope, validity window and exact evidence excerpt by entry hash and SHA-256 digest of its UTF-8 text. Verification happens locally after the agreement commitment and the excerpt opening are checked. The public proof excludes the receipt and private fields.

A receipt establishes that the configured issuer signed a statement about access. It conveys neither proof of customer satisfaction nor proof that the recipient opened the recording. Evidence that describes a recording is signed as an excerpt, not as the recording file. Each receipt has one event ID scoped to an agreement, recipient and excerpt. Offline recipients can reverify the same receipt. Integrations that ingest receipts to trigger a side effect would need durable deduplication of issuer plus event ID.

Configure `VITE_NEAR_SOURCE_ISSUERS` as a JSON array of trusted public keys selected by the operator. Each item has `id`, `keyId`, `label` and `publicKey`. Public keys are base64url without padding of the 32-byte raw Ed25519 key. Keep private signing keys at the actual delivery service. If PactPay operates the service, configure its label as `PactPay delivery service`. An unknown issuer remains **Unavailable**, including when a proof file carries its own key.

The delivery service constructs the structured receipt per `lib/near-source-proof.d.mts`. It signs `sourceReceiptMessage(payload, entryHash)` and encodes the 64-byte signature as unpadded base64url. Use Unix seconds for validity fields. Import the JSON in the authorized export and select its corresponding opened excerpt. The verifier checks validity against the current viewing device's clock. For historical re-verification beyond that interval, a trusted timestamp policy would need its own design.

The local tests use generated keys and synthetic delivery data. The application has no real issuer enrolled or confirmed hosted access-grant flow. Onboarding an actual recording delivery service and checking a signed event against its advertised issuer key are required for production acceptance.

## HTTPS evidence option

Reclaim exposes custom HTTPS providers with configured request and extraction patterns and verifies a signed provider claim against the correct configuration. A suitable recording provider must expose a stable authenticated access-status endpoint with recipient, artifact identity and provable freshness. The server can bind a one-time session to the booking/position/version and reject unrelated provider endpoints, recipient mismatches and expired results. A caller-supplied context string alone proves no provider-side relationship. [Reclaim JavaScript SDK](https://github.com/reclaimprotocol/reclaim-js-sdk) · [Reclaim proof verification guidance](https://letters.reclaimprotocol.org/how-to-verify)

Candidate evaluation should check authenticated access endpoint coverage, permitted visible fields, redaction and signed provider configuration. Share only evidence required to prove the grant, excluding download URLs with access tokens. Provider coverage, operating cost and a real compatible endpoint remain unconfirmed. No zkTLS dependency is enabled.
