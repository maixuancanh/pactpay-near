# PactPay

PactPay helps groups book a service, agree on each person's share, and pay through an escrow contract on NEAR. Each share has its own outcome. If a buyer disputes part of a service, the merchant and buyer can release the portion they agree on and hold the rest until a remedy is confirmed.

[Open PactPay](https://pactpay-near-testnet-web.vercel.app/) · [Inspect Booking #2](https://pactpay-near-testnet-web.vercel.app/booking?booking=2&escrow=escrow-v2.pactpay-530c506b.testnet) · [Open the proof verifier](https://pactpay-near-testnet-web.vercel.app/verify)

The public demo runs on **NEAR Testnet** and uses **PDEMO**, a test token with no monetary value.

## Review in two minutes

1. Open [Verify](https://pactpay-near-testnet-web.vercel.app/verify) and select **Verify sample booking**. The public sample is Booking #0, a scripted Testnet settlement with receipts.
2. Select the modified sample to see the verifier reject an altered amount. Both checks are read-only.
3. Open [Booking #2](https://pactpay-near-testnet-web.vercel.app/booking?booking=2&escrow=escrow-v2.pactpay-530c506b.testnet) for the two-wallet demo. The receipt links below show the 12 and 8 PDEMO payouts.

Run the public sample check locally after `npm ci`:

```sh
node scripts/near/verify-resolution-case.mjs public/pactpay-v2-sample-proof.json
node scripts/near/verify-resolution-case.mjs public/pactpay-v2-sample-proof.json --check-modified-sample
```

This uses public Testnet RPC data and requires no wallet or API key. The sample proves the settlement. The separate [NEAR AI run](docs/near/testnet-resolution-v2-ai.json) records a signed encrypted transcript check. Neither public booking proof contains that transcript.

## Hackathon versions

PactPay started as a group-booking and payment project. The NEAR entry added Testnet escrow, private dispute evidence, NEAR AI review and receipt verification. Use [1040a12](https://github.com/maixuancanh/pactpay-near/tree/1040a12) for the repository snapshot published before the deadline. [9afb5c2](https://github.com/maixuancanh/pactpay-near/tree/9afb5c2) is a post-deadline update that adds the verifiable-service and NEAR Auth changes. Subsequent verifier changes are also post-deadline.

## How a booking works

1. **Set the terms.** The merchant enters the service terms, participant wallet addresses, contribution amounts, funding deadline, and service end time. PactPay records a cryptographic commitment to the exact terms. The merchant shares the text privately with participants.
2. **Agree and fund.** Each buyer verifies the terms, accepts their share, and contributes through a NEAR wallet. The merchant captures a fully funded booking before the service ends.
3. **Settle each share.** A buyer can confirm completion or open a dispute within 48 hours after the service ends. A captured, undisputed share can be settled after the dispute window. If funding falls short or the merchant misses capture, eligible buyers can settle and claim refunds.
4. **Resolve a dispute.** The buyer and merchant can exchange encrypted evidence and approve a resolution agreement that specifies immediate payments, any amount held, the remedy, and the deadlines. A buyer can confirm a submitted remedy, or the signed deadline terms can determine how the retained amount is allocated. If the parties reach no agreement, the buyer can settle for a refund once the applicable dispute deadline passes.
5. **Claim funds.** Settlement makes a payout or refund available. The recipient claims it with a wallet transaction. The interface shows when a claim is available, pending, or received.

## Verify the testnet demo

Booking #2 models a workshop where the recording was missing. The buyer funded **20 PDEMO** and opened a dispute. The merchant and buyer agreed to make **12 PDEMO** available to the merchant and retain **8 PDEMO** until the missing recording was provided. The buyer confirmed completion, and the merchant claimed the remaining 8 PDEMO. Both claims paid the merchant wallet `cvcvvc.testnet`. The buyer wallet was `shikhanh21.testnet`.

In the 1:41 demo video, deployment evidence starts at **01:03** and the Booking #2 payout walkthrough starts at **01:15**.

### Contracts and transactions

| Item | NEAR Testnet evidence |
| --- | --- |
| V2 escrow | [`escrow-v2.pactpay-530c506b.testnet`](https://testnet.nearblocks.io/address/escrow-v2.pactpay-530c506b.testnet) |
| PDEMO token | [`token.pactpay-530c506b.testnet`](https://testnet.nearblocks.io/address/token.pactpay-530c506b.testnet) |
| Initial escrow deployment | [`DeployContract` transaction](https://testnet.nearblocks.io/txns/5uPCikZtsU19hLt89vBdwXH18n2iNzsDnRbsWYr4iZWm) |
| Retryable payout upgrade | [Escrow upgrade transaction](https://testnet.nearblocks.io/txns/83ySFiLns3MsNbtv8RLfzdTf3vuQPs4gd8Mog2LhKEUF) |
| Buyer contributes 20 PDEMO | [Contribution and escrow callback](https://testnet.nearblocks.io/txns/DjTNs6YJYQg1LDvTpUkBUbrA8KPiGNxKKXTsGvTdho5Q) |
| Buyer opens the dispute | [`open_dispute`](https://testnet.nearblocks.io/txns/5emWbVi43EfdGt4Zn2Vp3SzBpB32EwRuZRpPtdTwACWe) |
| Merchant proposes the split | [`propose_agreement`](https://testnet.nearblocks.io/txns/AJHrkuoDM3SBxiskVv3yKtbT7hrgfex78KLE6YMCMjdc) |
| Buyer approves the split | [`approve_agreement`](https://testnet.nearblocks.io/txns/5zLQ5Ed3HqVJp9aLvvJPEkG8YcTiN7tXbUom2t41ZNXN) |
| Merchant receives **12 PDEMO** | [Claim #4](https://testnet.nearblocks.io/txns/67QPZ67ZBoeQ7e5yrPPEKsHWDSGk3p6aSHhU5dtvLbGi) |
| Merchant submits the remedy | [`submit_completion`](https://testnet.nearblocks.io/txns/7TNPaERB8whMNH1qp4d6zCZ1A7k8kGzK3YYELSfXbLpm) |
| Buyer confirms completion | [`confirm_agreement_completion`](https://testnet.nearblocks.io/txns/EQ1P9ipfbVQVuCsSHDwX4eQiHBFxkTdqKTxBfh2GvvXu) |
| Merchant receives **8 PDEMO** | [Claim #5](https://testnet.nearblocks.io/txns/CSKUN7svXsdJ3TvQbS1jqLYG4UjP4SmY2FLwkcTgYdtp) |

On each payout transaction, check the receipt logs for an NEP-141 `ft_transfer` from the escrow to the merchant and a PactPay `claim_paid` event for the matching booking, claim ID, and amount. The booking shows **20 received, 0 retained, and 0 pending**. The scenario uses synthetic service evidence and real Testnet transactions signed through two wallet sessions.

### Try it yourself

Open Booking #2 and inspect **Participant shares → Resolution agreement**. Anyone can read the final amounts without connecting a wallet. To test a new booking, use two NEAR Testnet wallets in separate browser profiles, one as merchant and one as buyer. The buyer needs PDEMO and enough testnet NEAR for any wallet-paid transactions. If the demo dispenser is available for the connected buyer, **Get demo PDEMO** appears in the booking interface. Token registration reserves storage for the account.

A public receipt can be exported from the booking. The agreement proof export uses indexed transaction references when available. If a reference is missing, it can be supplied manually and checked against NEAR. Use **Verify** to check a supported proof file against chain data. A private case bundle is intended for authorized participants.

## Create a Testnet booking with NEAR Auth

Open the [Booking V2 workspace](https://pactpay-near-testnet-web.vercel.app/booking?escrow=escrow-v2.pactpay-530c506b.testnet), select **Connect → Continue with NEAR Auth**, and create a booking. Review the transaction in the Auth0 popup and approve it. The account menu shows the derived MPC address.

The Testnet relayer can activate a new MPC account and fund the shortfall for its first eligible booking. It sends Testnet NEAR directly to the MPC account, subject to sponsorship limits. The MPC key signs the booking transaction and the account pays the attached escrow storage deposit and gas from its balance.

The consent and signing walkthrough includes a finalized MPC self-transfer. The sponsored Create flow is published, with a finalized sponsored booking and separate Google and passkey acceptance runs still pending. See [FastAuth deployment and receipts](docs/near-auth-independent-testnet.md).

## Privacy and verification

| Component | Responsibility |
| --- | --- |
| NEAR escrow | Records participants, share amounts, deadlines, terms and evidence commitments, approvals, and claim states. Applies the agreed payment rules. |
| Evidence storage | The browser encrypts shared excerpts for authorized participants. The hosted evidence API stores encrypted objects through the Cloudflare R2 worker. The evidence panel supports text and file extraction, including PDF and image OCR. Participants can review excerpts before sharing. |
| NEAR AI Cloud | Helps parties review evidence and find supporting excerpts. The hosted proof can authenticate the signed encrypted AI transcript. Independent verification of the exact AI plaintext remains outside the demonstrated scope. Wallet approvals authorize resolution actions. |
| Signed transfers and receipts | Signature checks bind actions to the relevant wallets. For supported retryable claims, the PDEMO contract records an idempotent payment keyed by claim so a retry can complete without a second transfer. Legacy pending claims have an operator reconciliation path. |
| Sign-in | The hosted social flow uses Auth0. Booking V2 can request an MPC signature when creating a booking. Other booking actions and private evidence access use a connected NEAR wallet. |

Parties should retain their evidence recovery material and any private terms or proof files they need. The chain commitments allow an authorized reviewer to compare a shared document against the committed content. The public records expose wallet addresses and payment amounts.

## Run locally

Use Node.js **24.22.1**, the version pinned in `.node-version`. Run the following commands from this project directory.

```sh
npm ci
npm run dev
```

Open [localhost:5178](http://127.0.0.1:5178). For Testnet chain reads, copy `.env.example` to `.env.local` and set `VITE_NEAR_ESCROW_V2=escrow-v2.pactpay-530c506b.testnet`. The public RPC can be set with `VITE_NEAR_RPC`.

A standalone Vite session can render the frontend and read public NEAR state. To test the Vercel functions locally, run the project through the Vercel development environment with the corresponding server settings. The [evidence storage worker](infra/r2/) and [reconciliation guide](docs/near/RESOLUTION-RECOVERY.md) describe the supporting services.

| Setting | Used for |
| --- | --- |
| `VITE_NEAR_ESCROW_V2`, `VITE_NEAR_RPC` | Public V2 contract address and NEAR RPC URL |
| `VITE_NEAR_AUTH_TESTNET_CLIENT_ID`, `VITE_NEAR_AUTH_TESTNET_DOMAIN` | Optional Auth0 SPA client and tenant. Configure allowed callback URLs and web origins for the selected hosts. |
| `PACTPAY_NEAR_ESCROW_V2`, `PACTPAY_SESSION_SECRET` | Server-side contract selection and signed evidence sessions |
| `PACTPAY_STORAGE_URL`, `PACTPAY_STORAGE_SECRET` | R2 worker endpoint and server credential |
| `NEARAI_API_KEY` | Server-side credential for confidential inference |
| `PACTPAY_NEAR_ESCROW`, `PACTPAY_RELAYER_ACCOUNT`, `PACTPAY_RELAYER_KEY` | Server-side configuration for supported relayer operations. The Testnet demo dispenser also uses the configured V2 escrow and its distributor account. |

Variables prefixed with `VITE_` go into the browser bundle. Keep API keys, session and storage secrets, and signer keys in the server environment.

### Tests and verification tools

```sh
npm run test:near
npm run build
node --test scripts/near/verify-resolution-case.test.mjs
node scripts/near/verify-resolution-case.mjs PROOF.json
```

The final command expects a PactPay agreement proof export. Deployment, funding, and repair scripts are under `scripts/near/`. Use the linked transaction receipts to inspect the completed demo without invoking those scripts.

## Repository guide

| Path | Contents |
| --- | --- |
| [`src/near/`](src/near/) | Landing content, booking workspace, wallet integration, evidence review, and verification UI |
| [`contracts/near-v2/`](contracts/near-v2/) | Rust escrow, resolution agreement, claims, and Sandbox tests |
| [`contracts/near/demo-token/`](contracts/near/demo-token/) | PDEMO test token and transfer-once logic |
| [`api/`](api/) and [`lib/`](lib/) | Hosted endpoints and helpers for evidence, AI, demo tokens, claims, and proof verification |
| [`infra/r2/`](infra/r2/) | Evidence storage worker |
| [`scripts/near/`](scripts/near/) and [`docs/near/`](docs/near/) | Testnet deployment and verification scripts, case fixtures, and release records |

See the [deployment record](docs/near/testnet-resolution-v2-deployment.json), [retryable payout upgrade](docs/near/testnet-resolution-v2-retryable.json), and [separate scripted Testnet case](docs/near/testnet-resolution-v2-retryable-smoke.json). The scripted case uses Booking #1. The explorer links above document the two-wallet Booking #2 run.

## Mainnet status

The hosted NEAR Intents integration previews a 1Click quote from Base USDC to NEAR USDC. Mainnet escrow and cross-chain deposits into bookings are deferred because the project budget does not cover mainnet deployment, storage, and end-to-end transaction testing. The settlement demonstrated here runs on NEAR Testnet.
