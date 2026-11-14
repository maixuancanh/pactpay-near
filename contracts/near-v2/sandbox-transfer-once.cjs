const assert = require("node:assert/strict");
const {Worker} = require("near-workspaces");

async function main() {
  const worker = await Worker.init();
  try {
    const root = worker.rootAccount;
    const token = await root.createSubAccount("token");
    const escrow = await root.createSubAccount("escrow");
    const merchant = await root.createSubAccount("merchant");
    await token.deploy(process.argv[2]);
    await root.call(token,"new",{owner_id:root.accountId,supply:"100"});
    for (const account of [escrow,merchant]) {
      await root.call(token,"storage_deposit",{account_id:account.accountId,registration_only:true},
        {attachedDeposit:"1250000000000000000000"});
    }
    await root.call(token,"ft_transfer",{receiver_id:escrow.accountId,amount:"60"},{attachedDeposit:"1"});
    await token.call(token,"enable_payout_escrow",{escrow:escrow.accountId});
    const args={claim_id:"3",receiver_id:merchant.accountId,amount:"20"};
    const pay=(signer,payout)=>signer.call(token,"pactpay_transfer_once",payout,{attachedDeposit:"1"});
    await pay(escrow,args);
    await pay(escrow,args);
    await assert.rejects(pay(escrow,{...args,amount:"21"}));
    await assert.rejects(pay(root,args));
    assert.equal(await token.view("ft_balance_of",{account_id:merchant.accountId}),"20");
    assert.equal(await token.view("ft_balance_of",{account_id:escrow.accountId}),"40");
    console.log("Repeated payout moved 20 PDEMO exactly once");
  } finally {
    await worker.tearDown();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
