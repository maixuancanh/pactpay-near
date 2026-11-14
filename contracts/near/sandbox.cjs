const assert = require('node:assert/strict');
const { Worker } = require('near-workspaces');

async function main() {
  const worker = await Worker.init();
  try {
    const root = worker.rootAccount;
    const token = await root.createSubAccount('token');
    const escrow = await root.createSubAccount('escrow');
    const merchant = await root.createSubAccount('merchant');
    const buyers = [];
    for (let i = 0; i < 5; i++) buyers.push(await root.createSubAccount('buyer' + i));
    await token.deploy(process.argv[2]);
    await escrow.deploy(process.argv[3]);
    await root.call(token, 'new', {owner_id: root.accountId, supply: '100'});
    await root.call(escrow, 'new', {token: token.accountId});
    for (const account of [escrow, ...buyers]) {
      await root.call(token, 'storage_deposit', {account_id: account.accountId}, {attachedDeposit: '1250000000000000000000'});
    }
    const block = await worker.provider.block({finality: 'final'});
    const seconds = Math.floor(Number(block.header.timestamp_nanosec) / 1e9);
    const terms = 'a'.repeat(64);
    const id = await merchant.call(escrow, 'create_booking', {
      terms_commitment: terms, fund_until: String(seconds + 600), service_end: String(seconds + 900),
      shares: buyers.map(buyer => ({buyer: buyer.accountId, amount: '20'})),
    }, {attachedDeposit: '50000000000000000000000'});
    const balance = account => token.view('ft_balance_of', {account_id: account.accountId});
    for (const [position, buyer] of buyers.entries()) {
      await root.call(token, 'ft_transfer', {receiver_id: buyer.accountId, amount: '20'}, {attachedDeposit: '1'});
      await buyer.call(escrow, 'accept', {id, index: position, terms_commitment: terms});
      const args = {receiver_id: escrow.accountId, amount: '20', msg: JSON.stringify({booking: id, position})};
      if (position === 0) {
        await buyer.call(token, 'ft_transfer_call', {...args, amount: '19'}, {attachedDeposit: '1', gas: '100000000000000'});
        assert.equal(await balance(buyer), '20');
      }
      await buyer.call(token, 'ft_transfer_call', args, {attachedDeposit: '1', gas: '100000000000000'});
    }
    assert.equal(await balance(escrow), '100');
    await merchant.call(escrow, 'capture', {id});
    await worker.provider.fastForward(1000);
    const dispute = {id, index: 4};
    await buyers[4].call(escrow, 'open_dispute', dispute);
    for (let index = 0; index < 4; index++) await buyers[index].call(escrow, 'confirm_completion', {id, index});
    const claim = {id, index: 0, refund: false};
    const claimOptions = {gas: '100000000000000'};
    assert.equal(await merchant.call(escrow, 'claim', claim, claimOptions), false);
    let booking = await escrow.view('get_booking', {id});
    assert.equal(booking.positions[0].claims[1], 'Unclaimed');
    await root.call(token, 'storage_deposit', {account_id: merchant.accountId}, {attachedDeposit: '1250000000000000000000'});
    for (let index = 0; index < 4; index++) {
      assert.equal(await merchant.call(escrow, 'claim', {...claim, index}, claimOptions), true);
    }
    assert.equal(await balance(merchant), '80');
    assert.equal(await balance(escrow), '20');
    await buyers[4].call(escrow, 'revise_evidence', {...dispute, commitment: 'b'.repeat(64)});
    booking = await escrow.view('get_booking', {id});
    const proposal = {...dispute, refund: '8', payout: '12', expires: booking.positions[4].dispute_until,
      evidence_revision: '1', expected_proposal_version: '0'};
    await buyers[4].call(escrow, 'approve_resolution', proposal);
    await assert.rejects(() => merchant.call(escrow, 'approve_resolution', proposal));
    await merchant.call(escrow, 'approve_resolution', {...proposal, expected_proposal_version: '1'});
    assert.equal(await buyers[4].call(escrow, 'claim', {...dispute, refund: true}, claimOptions), true);
    assert.equal(await merchant.call(escrow, 'claim', {...dispute, refund: false}, claimOptions), true);
    await assert.rejects(() => merchant.call(escrow, 'claim', {...dispute, refund: false}, claimOptions));
    assert.equal(await balance(escrow), '0');
    assert.equal(await balance(merchant), '92');
    assert.equal(await balance(buyers[4]), '8');
    console.log('NEAR Sandbox: 100 funded, 80 paid, 20 disputed, refund 8, payout 12; failed and repeated claims checked.');
  } finally {
    await worker.tearDown();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
