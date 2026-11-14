# Resolution Agreement V2 payout reconciliation

The NEAR testnet V2 escrow can reconcile a failed callback. It records Paid when the linked token transfer succeeded. It restores Available when the transfer receipt failed and shows no transfer event. The operator script checks the finalized receipts and current pending attempt. The contract accepts the call only from the escrow account, records each receipt once, and sends no tokens during reconciliation. Receipt verification depends on the operator and RPC.

Run `node scripts/near/reconcile-resolution-v2.mjs TX_HASH SIGNER` to inspect a claim. Append `--apply` only for an eligible testnet result. An unknown outcome or a transfer with no successful matching NEP-141 receipt stays pending.

For a reconciled claim, enter the original transaction hash, its signer and the reconciliation transaction hash on the same line in **Export agreement proof**. The verifier checks the original token transfer and failed callback, the escrow-signed reconciliation, and the historical Paid state. Run `node scripts/near/verify-resolution-case.mjs PROOF.json` to repeat the checks.

The recovery upgrade preserved booking 0, its agreement, claims and balances as recorded in `testnet-resolution-v2-recovery-upgrade.json`. A Sandbox test transferred 20 PDEMO, deliberately failed the callback, blocked a retry and unauthorized repair, recorded Paid using the escrow account, and rejected repeated repair. The recipient still held exactly 20. Fault injection was limited to the Sandbox build.

The hosted AI smoke outcome is in `testnet-resolution-v2-ai.json`. It confirms the signature over the encrypted transcript. Portable proof of the plaintext remains unavailable through the current integration. The hosted smoke used a script signer and synthetic evidence.
