import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {setTimeout as delay} from "node:timers/promises";
import {indexReference} from "../../lib/near-case-index.mjs";
import {caseReader} from "../../lib/near-case-rpc.mjs";

const args = process.argv.slice(2);
assert.ok(args.length === 0 || args.length === 1 && args[0] === "--publish",
  "Usage: node scripts/near/seed-case-history.mjs [--publish]");
const sample = JSON.parse(await readFile(new URL("../../public/pactpay-v2-sample-proof.json",import.meta.url),"utf8"));
assert.equal(sample.escrow,"escrow-v2.pactpay-530c506b.testnet");
const buyer = "shikhanh21.testnet";
const merchant = "cvcvvc.testnet";
const demo = [
  {hash:"AJHrkuoDM3SBxiskVv3yKtbT7hrgfex78KLE6YMCMjdc",signer:merchant},
  {hash:"5zLQ5Ed3HqVJp9aLvvJPEkG8YcTiN7tXbUom2t41ZNXN",signer:buyer},
  {hash:"67QPZ67ZBoeQ7e5yrPPEKsHWDSGk3p6aSHhU5dtvLbGi",signer:merchant},
  {hash:"7TNPaERB8whMNH1qp4d6zCZ1A7k8kGzK3YYELSfXbLpm",signer:merchant},
  {hash:"EQ1P9ipfbVQVuCsSHDwX4eQiHBFxkTdqKTxBfh2GvvXu",signer:buyer},
  {hash:"CSKUN7svXsdJ3TvQbS1jqLYG4UjP4SmY2FLwkcTgYdtp",signer:merchant},
];

for (const {booking,refs} of [
  {booking:"0",refs:[sample.receipts.proposal,sample.receipts.approval,...sample.receipts.claims]},
  {booking:"2",refs:demo},
]) {
  for (const ref of refs) {
    let verified;
    if (args[0] === "--publish") {
      for (let attempt=0;attempt<3;attempt++) {
        const response = await fetch("https://pactpay-near-testnet-web.vercel.app/api/near-case-index",{
          method:"POST",headers:{"content-type":"application/json"},
          body:JSON.stringify(ref),signal:AbortSignal.timeout(30000),
        });
        if (response.status===200) {
          verified=(await response.json()).reference;
          break;
        }
        if (![202,429,503].includes(response.status) || attempt===2) {
          throw new Error("Hosted indexing returned HTTP "+response.status+" for "+ref.hash);
        }
        await response.body?.cancel();
        await delay(10000*(attempt+1));
      }
    } else {
      for (let attempt=0;attempt<3;attempt++) {
        try {
          verified=await indexReference(caseReader(AbortSignal.timeout(18000)),sample.escrow,ref);
          break;
        } catch (error) {
          if (attempt===2 || (error.message!=="NEAR RPC unavailable." && !["AbortError","TimeoutError"].includes(error.name))) throw error;
          await delay(10000*(attempt+1));
        }
      }
    }
    assert.ok(verified,"The reference is not finalized.");
    assert.equal(verified.scope.booking,booking);
    assert.equal(verified.scope.escrow,sample.escrow);
    assert.equal(verified.transactionHash,ref.hash);
    assert.equal(verified.signer,ref.signer);
    console.log(JSON.stringify({booking,kind:verified.kind,blockHeight:verified.blockHeight,
      transactionHash:verified.transactionHash,receiptIds:verified.receiptIds}));
    await delay(2000);
  }
}
