const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const {createHash} = require('node:crypto');
const {Worker} = require('near-workspaces');
const [tokenWasm,escrowWasm,output] = process.argv.slice(2);
const gas = '100000000000000';
async function main() {
  assert.ok(tokenWasm && escrowWasm && output,'Pass token.wasm escrow.wasm output.json');
  const worker = await Worker.init();
  const report = {schema:'pactpay.sandbox-cost.v1',environment:'isolated-sandbox',startedAt:new Date().toISOString(),
    artifacts:{tokenSha256:createHash('sha256').update(await fs.readFile(tokenWasm)).digest('hex'),
      escrowSha256:createHash('sha256').update(await fs.readFile(escrowWasm)).digest('hex')},
    flow:'create, accept, fund, capture, normal completion, claim; excludes AI and dispute/remedy branches',
    excluded:'Account creation, deployment, mint/distribution and token registration gas. No real fees or AI billing.',cases:[]};
  try {
    const root=worker.rootAccount;
    const token=await root.createSubAccount('cost-token');
    const escrow=await root.createSubAccount('cost-escrow');
    const merchant=await root.createSubAccount('cost-merchant');
    await token.deploy(tokenWasm); await escrow.deploy(escrowWasm);
    await root.call(token,'new',{owner_id:root.accountId,supply:'1000'});
    await root.call(escrow,'new',{token:token.accountId});
    const storage='1250000000000000000000';
    for (const who of [escrow,merchant]) await root.call(token,'storage_deposit',{account_id:who.accountId},{attachedDeposit:storage});
    for (const count of [1,3,10]) {
      const buyers=[];
      for(let i=0;i<count;i++) {
        const buyer=await root.createSubAccount(`buyer-${count}-${i}`);buyers.push(buyer);
        await root.call(token,'storage_deposit',{account_id:buyer.accountId},{attachedDeposit:storage});
        await root.call(token,'ft_transfer',{receiver_id:buyer.accountId,amount:'20'},{attachedDeposit:'1'});
      }
      let gasBurnt=0n; let signatures=0; const methods=[];
      const invoke=async (who,contract,method,args,options={})=>{
        const result=await who.callRaw(contract,method,args,{gas,...options});
        const outcomes=[result.result.transaction_outcome,...result.result.receipts_outcome];
        assert.ok(outcomes.every(item=>!item.outcome.status.Failure),`${method} failed`);
        const used=outcomes.reduce((n,item)=>n+BigInt(item.outcome.gas_burnt),0n);
        gasBurnt+=used;signatures++;methods.push({method,gasBurnt:String(used)});
        return result.parseResult();
      };
      const {header}=await worker.provider.block({finality:'final'});
      const now=BigInt(header.timestamp_nanosec)/1000000000n;
      const bookingStorage=await escrow.view('booking_storage_deposit',{positions:count});
      const terms='a'.repeat(64);
      const id=await invoke(merchant,escrow,'create_booking',{terms_commitment:terms,fund_until:String(now+300n),service_end:String(now+600n),
        shares:buyers.map(buyer=>({buyer:buyer.accountId,amount:'20'}))},{attachedDeposit:bookingStorage});
      for(const [index,buyer] of buyers.entries()) {
        await invoke(buyer,escrow,'accept',{id,index,terms_commitment:terms});
        await invoke(buyer,token,'ft_transfer_call',{receiver_id:escrow.accountId,amount:'20',msg:JSON.stringify({booking:id,position:index})},{attachedDeposit:'1'});
      }
      await invoke(merchant,escrow,'capture',{id}); await worker.provider.fastForward(700);
      for(const [index,buyer] of buyers.entries()) {
        await invoke(buyer,escrow,'confirm_completion',{id,index});
        const [claim]=await escrow.view('get_claims',{id,index});
        await invoke(merchant,escrow,'claim_v2',{claim_id:claim.claim_id});
        const ledger=await escrow.view('get_position_ledger',{id,index});
        assert.equal(ledger.paid,'20');assert.equal(ledger.pending,'0');
      }
      report.cases.push({participants:count,gasBurnt:String(gasBurnt),transactionSignatures:signatures,
        bookingStorageDepositYoctoNear:bookingStorage,newBuyerTokenRegistrationDepositYoctoNear:String(BigInt(storage)*BigInt(count)),
        aiCalls:0,aiTokenUsage:null,methods});
    }
    assert.equal(await token.view('ft_balance_of',{account_id:escrow.accountId}),'0');
    report.finishedAt=new Date().toISOString();
    await fs.writeFile(output,JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report));
  } finally {await worker.tearDown();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
