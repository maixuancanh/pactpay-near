# Booking #5 · Private AI and settlement on NEAR Testnet

This post-deadline case uses synthetic workshop evidence and real Testnet transactions. The two dedicated demo accounts signed through a script. The synthetic excerpts were encrypted locally and committed on-chain. The case does not exercise participant-to-participant R2 sharing.

1. The buyer funded 20 PDEMO and opened a dispute after the workshop. The merchant committed the evidence snapshot.
2. PactPay sent the sample terms and excerpt to NEAR AI Cloud with E2EE enabled. It verified the signature on the encrypted transcript, compared the model attestation with the outbound nonce, and found a citation matching the sample excerpt. The agreement contains the assessment digest for this booking, share, and version.
3. The merchant proposed the split and the buyer approved it. The merchant received 12 PDEMO. The ledger still held 8 PDEMO in escrow.
4. The merchant submitted completion and the buyer confirmed it. The merchant received the final 8 PDEMO.

| Step | Testnet transaction |
| --- | --- |
| Fund 20 PDEMO | [Contribution](https://testnet.nearblocks.io/txns/5bas7jreeEEVRJTPPdPbu2wtZyZyLB29juMbc5EgDeAd) |
| Commit evidence | [Evidence snapshot](https://testnet.nearblocks.io/txns/9BE3pcFBZwJXSVz2hkpRNHp8fG2trQg6Eh3qdtt4m7NJ) |
| Merchant proposes | [Proposal](https://testnet.nearblocks.io/txns/J8w8gLrgzqiZ3kTi7PtrYubDpdjfFjQbdri6QfFz3Rie) |
| Buyer approves | [Approval](https://testnet.nearblocks.io/txns/2sHpngxweBJ78wXsxQXfNK7Vs8LneHBNSUBj8xJDf2xw) |
| First payout | [12 PDEMO](https://testnet.nearblocks.io/txns/7ciYsPY2iQJYx3YCeJHAp46JAai8NWmgkdKFCZoh8gUD) |
| Buyer confirms completion | [Confirmation](https://testnet.nearblocks.io/txns/7jYCF99QxzrNV6ZHdiRqFRc2tUZY5QM4ESc1YNMRRWFH) |
| Final payout | [8 PDEMO](https://testnet.nearblocks.io/txns/9BCwpSgDbE5xMEdsLkepPttHsgjfbkHYTT7ZQe7FyYbE) |

Download [the synthetic proof JSON](testnet-workshop-ai-proof.json), then upload it on [PactPay Verify](https://pactpay-near-testnet-web.vercel.app/verify). No wallet is needed. The excerpt keys in the file disclose only the two synthetic excerpts created for this run.

To check locally after installing dependencies, run:

```sh
node scripts/near/verify-resolution-case.mjs docs/near/testnet-workshop-ai-proof.json
```

The evidence openings, both approvals, both payouts, signed encrypted transcript, and nonce passed on the recorded run. The aggregate flag is false and the CLI exits 1 because independent verification of the decrypted AI response remains unavailable. Later attestation checks can also depend on provider verification material and its validity.
