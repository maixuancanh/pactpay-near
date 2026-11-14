const assert = require('node:assert/strict');
const {Worker} = require('near-workspaces');

const [tokenWasm, faultEscrowWasm, healthyEscrowWasm] = process.argv.slice(2);
const gas = '100000000000000';

async function main() {
  assert.ok(tokenWasm && faultEscrowWasm, 'Pass demo token WASM and sandbox-callback-fault escrow WASM');
  const worker = await Worker.init();
  try {
    const root = worker.rootAccount;
    const token = await root.createSubAccount('token');
    const escrow = await root.createSubAccount('escrow');
    const merchant = await root.createSubAccount('merchant');
    const buyer = await root.createSubAccount('buyer');
    await token.deploy(tokenWasm);
    await escrow.deploy(faultEscrowWasm);
    await root.call(token, 'new', {owner_id: root.accountId, supply: '60'});
    await root.call(escrow, 'new', {token: token.accountId});
    for (const account of [escrow, buyer]) {
      await root.call(token, 'storage_deposit', {account_id: account.accountId}, {attachedDeposit: '1250000000000000000000'});
    }
    await root.call(token, 'ft_transfer', {receiver_id: buyer.accountId, amount: '20'}, {attachedDeposit: '1'});
    const {header} = await worker.provider.block({finality: 'final'});
    const now = BigInt(header.timestamp_nanosec) / 1_000_000_000n;
    const terms = 'a'.repeat(64);
    const id = await merchant.call(escrow, 'create_booking', {
      terms_commitment: terms, fund_until: String(now + 45n), service_end: String(now + 90n),
      shares: [{buyer: buyer.accountId, amount: '20'}],
    }, {attachedDeposit: await escrow.view('booking_storage_deposit', {positions: 1})});
    const position = {id, index: 0};
    await buyer.call(escrow, 'accept', {...position, terms_commitment: terms});
    await buyer.call(token, 'ft_transfer_call', {
      receiver_id: escrow.accountId, amount: '20', msg: JSON.stringify({booking: id, position: 0}),
    }, {attachedDeposit: '1', gas});
    await merchant.call(escrow, 'capture', {id});
    await worker.provider.fastForward(110);
    await buyer.call(escrow, 'confirm_completion', position);
    const claims = () => escrow.view('get_claims', position);
    const [claim] = await claims();
    const balance = account => token.view('ft_balance_of', {account_id: account.accountId});
    const attempts = result => result.result.receipts_outcome;
    if (healthyEscrowWasm) {
      await token.call(token, 'enable_payout_escrow', {escrow: escrow.accountId});
      await root.call(token, 'storage_deposit', {account_id: merchant.accountId}, {attachedDeposit: '1250000000000000000000'});
      await merchant.callRaw(escrow, 'claim_retryable_v2', {claim_id: claim.claim_id}, {gas});
      assert.equal((await claims())[0].status, 'Pending');
      assert.equal(await balance(merchant), '20');
      await escrow.deploy(healthyEscrowWasm);
      await merchant.call(escrow, 'claim_retryable_v2', {claim_id: claim.claim_id}, {gas});
      assert.equal((await claims())[0].status, 'Paid');
      assert.equal(await balance(merchant), '20');
      assert.equal(await balance(escrow), '0');
      console.log('Recipient recovered Pending payout without a second transfer or an operator reconciliation');
      return;
    }
    const failed = await merchant.callRaw(escrow, 'claim_v2', {claim_id: claim.claim_id}, {gas});
    const failedTransfer = attempts(failed).find(({outcome}) => outcome.executor_id === token.accountId && outcome.status.Failure);
    assert.ok(failedTransfer);
    assert.equal((await claims())[0].status, 'Pending');
    const reopen = await escrow.callRaw(escrow, 'reconcile_failed_claim_v2', {
      claim_id: claim.claim_id, attempt_nonce: '1', transfer_receipt: failedTransfer.id,
    }, {gas});
    assert.ok(!attempts(reopen).some(({outcome}) => outcome.executor_id === token.accountId || outcome.status.Failure));
    assert.equal((await claims())[0].status, 'Available');
    await root.call(token, 'storage_deposit', {account_id: merchant.accountId}, {attachedDeposit: '1250000000000000000000'});
    const result = await merchant.callRaw(escrow, 'claim_v2', {claim_id: claim.claim_id}, {gas});
    const transfer = attempts(result).find(({outcome}) =>
      outcome.executor_id === token.accountId && typeof outcome.status.SuccessValue === 'string'
      && outcome.logs.some(log => log.includes('"event":"ft_transfer"') && log.includes('"amount":"20"')));
    const failedCallback = attempts(result).find(({outcome}) =>
      outcome.executor_id === escrow.accountId && outcome.status.Failure);
    assert.ok(transfer, 'Transfer receipt must succeed');
    assert.ok(failedCallback, 'Callback receipt must fail after transfer');
    assert.equal((await claims())[0].status, 'Pending');
    assert.equal((await claims())[0].attempt_nonce, '2');
    assert.equal(await balance(merchant), '20');
    assert.equal(await balance(escrow), '0');
    const retry = await merchant.callRaw(escrow, 'claim_v2', {claim_id: claim.claim_id}, {gas});
    assert.ok(attempts(retry).some(({outcome}) => outcome.executor_id === escrow.accountId && outcome.status.Failure));
    assert.ok(!attempts(retry).some(({outcome}) => outcome.executor_id === token.accountId));
    assert.equal((await claims())[0].status, 'Pending');
    assert.equal((await claims())[0].attempt_nonce, '2');
    assert.equal(await balance(merchant), '20');
    const repair = {claim_id: claim.claim_id, attempt_nonce: '2', transfer_receipt: transfer.id};
    async function rejected(signer, args) {
      const result = await signer.callRaw(escrow, 'reconcile_paid_claim_v2', args, {gas});
      assert.ok(attempts(result).some(({outcome}) => outcome.executor_id === escrow.accountId && outcome.status.Failure));
      assert.ok(!attempts(result).some(({outcome}) => outcome.executor_id === token.accountId));
    }
    await rejected(merchant, repair);
    await rejected(escrow, {...repair, attempt_nonce: '1'});
    const repairResult = await escrow.callRaw(escrow, 'reconcile_paid_claim_v2', repair, {gas});
    assert.ok(!attempts(repairResult).some(({outcome}) => outcome.executor_id === token.accountId || outcome.status.Failure));
    assert.equal((await claims())[0].status, 'Paid');
    await rejected(escrow, repair);
    assert.equal(await balance(merchant), '20');
    assert.equal(await balance(escrow), '0');
    console.log(JSON.stringify({claim_id: claim.claim_id, transfer_receipt: transfer.id,
      failed_callback_receipt: failedCallback.id, paid_on_escrow: '20', paid_on_token: '20', retry_transfer_count: 0}));
  } finally {
    await worker.tearDown();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
