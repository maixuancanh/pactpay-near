const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {Worker} = require('near-workspaces');

const gas = '100000000000000';
const storageDeposit = '1250000000000000000000';
const bookingDeposit = '300000000000000000000000';
const terms = 'a'.repeat(64);
const rootHash = 'b'.repeat(64);

async function main() {
  const worker = await Worker.init();
  try {
    const root = worker.rootAccount;
    const token = await root.createSubAccount('token');
    const escrow = await root.createSubAccount('escrow');
    const merchant = await root.createSubAccount('merchant');
    const buyers = [];
    for (let index = 0; index < 4; index++) buyers.push(await root.createSubAccount('buyer' + index));
    await token.deploy(process.argv[2]);
    await escrow.deploy(process.argv[3]);
    await root.call(token, 'new', {owner_id: root.accountId, supply: '200'});
    await root.call(escrow, 'new', {token: token.accountId});
    assert.equal(await escrow.view('contract_version'), 2);
    const register = account => root.call(token, 'storage_deposit', {account_id: account.accountId}, {attachedDeposit: storageDeposit});
    for (const account of [escrow, ...buyers]) await register(account);
    const clock = async () => {
      const {header} = await worker.provider.block({finality: 'final'});
      return Math.floor(Number(header.timestamp_nanosec) / 1e9);
    };
    const seconds = await clock();
    const id = await merchant.call(escrow, 'create_booking', {
      terms_commitment: terms, fund_until: String(seconds + 600), service_end: String(seconds + 900),
      shares: buyers.map(buyer => ({buyer: buyer.accountId, amount: '20'})),
    }, {attachedDeposit: bookingDeposit});
    const key = index => ({id, index});
    const balance = account => token.view('ft_balance_of', {account_id: account.accountId});
    const ledger = index => escrow.view('get_position_ledger', key(index));
    const agreement = index => escrow.view('get_agreement', key(index));
    const claims = index => escrow.view('get_claims', key(index));
    const upgradeCheckpoint = async label => {
      if (!process.argv[4]) return;
      const snapshot = async () => ({
        token: await escrow.view('get_token', {}),
        booking: await escrow.view('get_booking', {id}),
        positions: await Promise.all(buyers.map(async (_, index) => ({
          ledger: await ledger(index), agreement: await agreement(index), claims: await claims(index),
        }))),
        balances: await Promise.all([escrow,merchant,...buyers].map(balance)),
      });
      const before = await snapshot();
      // Pending is not included in this fixture: callback-loss liabilities are
      // reconciled against token receipts in sandbox-recovery, never double-counted.
      let debt = 0n;
      for (const {ledger: row} of before.positions) {
        assert.equal(row.pending, '0');
        const outstanding = ['unallocated','retained','available'].reduce((n,k) => n+BigInt(row[k]),0n);
        assert.equal(outstanding+BigInt(row.paid),BigInt(row.funded));
        debt += outstanding;
      }
      assert.equal(String(debt),before.balances[0]);
      await escrow.deploy(process.argv[4]);
      if (process.env.PACTPAY_SANDBOX_BAD_MIGRATION === '1') {
        await escrow.call(escrow, 'sandbox_bad_migrate', {}, {gas});
      }
      assert.deepEqual(await snapshot(),before,`State changed during candidate upgrade: ${label}`);
      // Continue each branch against the candidate after the active-remedy checkpoint.
      if (label !== 'active-remedy') await escrow.deploy(process.argv[3]);
      console.log(`Stateful WASM upgrade checkpoint passed: ${label}`);
    };

    for (const [position, buyer] of buyers.entries()) {
      await root.call(token, 'ft_transfer', {receiver_id: buyer.accountId, amount: '30'}, {attachedDeposit: '1'});
      const args = {receiver_id: escrow.accountId, amount: '20', msg: JSON.stringify({booking: id, position})};
      const fund = (signer, deposit = args) => signer.call(token, 'ft_transfer_call', deposit, {attachedDeposit: '1', gas});
      if (position === 0) {
        await assert.rejects(() => buyer.call(escrow, 'ft_on_transfer', {sender_id: buyer.accountId, amount: '20', msg: args.msg}));
        await fund(buyer);
        assert.equal(await balance(buyer), '30');
      }
      await buyer.call(escrow, 'accept', {...key(position), terms_commitment: terms});
      if (position === 0) {
        await fund(buyer, {...args, amount: '19'});
        await fund(buyer, {...args, amount: '21'});
        await fund(root, args);
        assert.equal(await balance(buyer), '30');
        assert.equal((await ledger(position)).funded, '0');
      }
      await fund(buyer);
      assert.equal(await balance(buyer), '10');
      if (position === 0) await upgradeCheckpoint('partially-funded');
    }
    assert.equal(await balance(escrow), '80');
    await merchant.call(escrow, 'capture', {id});
    await upgradeCheckpoint('captured');
    await worker.provider.fastForward(1000);
    for (const index of [0, 1, 2]) {
      await buyers[index].call(escrow, 'open_dispute', key(index));
      await buyers[index].call(escrow, 'revise_evidence', {...key(index), commitment: rootHash});
    }
    await buyers[3].call(escrow, 'confirm_completion', key(3));
    await upgradeCheckpoint('disputed-and-available-claim');
    const start = await clock();
    const proposalFor = (index, overrides = {}) => ({
      schema: 'pactpay.resolution.v2', network: 'testnet', escrow: escrow.accountId,
      booking: String(id), position: String(index), version: '1',
      buyer: buyers[index].accountId, merchant: merchant.accountId, token: token.accountId,
      termsCommitment: terms, evidenceRoot: rootHash, privateTermsCommitment: 'c'.repeat(64), assessmentDigest: null,
      immediateBuyer: '0', immediateMerchant: '12', retained: '8',
      successBuyer: '0', successMerchant: '8', fallbackBuyer: '5', fallbackMerchant: '3',
      acceptBy: String(start + 250), deliverBy: String(start + 500), reviewUntil: String(start + 750),
      salt: 'd'.repeat(64), ...overrides,
    });
    const digestFor = proposal => createHash('sha256').update(JSON.stringify(Object.values(proposal))).digest('hex');
    const propose = (index, proposal) => buyers[index].call(escrow, 'propose_agreement', {...key(index), proposal});
    const approve = (index, proposal, signer = merchant, digest = digestFor(proposal)) =>
      signer.call(escrow, 'approve_agreement', {...key(index), version: proposal.version, digest});
    await assert.rejects(() => propose(0, proposalFor(0, {retained: '9'})));
    await assert.rejects(() => propose(0, proposalFor(0, {immediateMerchant: '012'})));
    await assert.rejects(() => propose(0, proposalFor(1)));
    await assert.rejects(() => propose(0, proposalFor(0, {token: merchant.accountId})));
    await assert.rejects(() => propose(0, proposalFor(0, {acceptBy: String(start - 1)})));
    await assert.rejects(() => propose(0, proposalFor(0, {immediateMerchant: '340282366920938463463374607431768211455'})));
    const original = proposalFor(0);
    await propose(0, original);
    assert.equal((await agreement(0)).digest, digestFor(original));
    assert.equal((await agreement(0)).status, 'Proposed');
    await assert.rejects(() => approve(0, original, buyers[0]));
    await buyers[0].call(escrow, 'revise_evidence', {...key(0), commitment: 'e'.repeat(64)});
    await assert.rejects(() => approve(0, original));
    const active = proposalFor(0, {version: '2', evidenceRoot: 'e'.repeat(64)});
    await propose(0, active);
    await assert.rejects(() => approve(0, original));
    await approve(0, active);
    await assert.rejects(() => propose(0, proposalFor(0, {version: '3'})));
    await assert.rejects(() => buyers[0].call(escrow, 'confirm_completion', key(0)));
    await assert.rejects(() => root.call(escrow, 'settle', key(0)));
    await buyers[0].call(escrow, 'revise_evidence', {...key(0), commitment: 'f'.repeat(64)});
    assert.equal((await agreement(0)).proposal.evidenceRoot, active.evidenceRoot);

    await upgradeCheckpoint('active-remedy');
    const claim = (signer, claim_id, claimGas = gas) => signer.call(escrow, 'claim_v2', {claim_id}, {gas: claimGas});
    const immediate = (await claims(0))[0];
    assert.equal((await claims(0)).length, 1);
    assert.equal(immediate.amount, '12');
    assert.deepEqual(await ledger(0), {funded: '20', unallocated: '0', retained: '8', available: '12', pending: '0', paid: '0'});
    await assert.rejects(() => claim(buyers[0], immediate.claim_id));
    await assert.rejects(() => merchant.call(escrow, 'finish_claim_v2', {claim_id: immediate.claim_id, attempt_nonce: '1'}));
    assert.equal(await claim(merchant, immediate.claim_id), false);
    assert.equal((await claims(0))[0].status, 'Available');
    await register(merchant);
    const invoke = await Promise.allSettled([claim(merchant, immediate.claim_id), claim(merchant, immediate.claim_id, '101000000000000')]);
    assert.equal(invoke.filter(result => result.status === 'fulfilled' && result.value === true).length, 1);
    assert.equal(await balance(merchant), '12');
    assert.equal((await claims(0))[0].attempt_nonce, '2');
    assert.equal((await claims(0))[0].status, 'Paid');
    // The sandbox account can sign directly as the contract to model a stale callback receipt.
    assert.equal(await escrow.call(escrow, 'finish_claim_v2', {claim_id: immediate.claim_id, attempt_nonce: '1'}), false);

    const completion = (index, version) => ({...key(index), version, evidence_root: 'a'.repeat(64)});
    const confirm = (index, proposal) => buyers[index].call(escrow, 'confirm_agreement_completion', {
      ...key(index), version: proposal.version, digest: digestFor(proposal),
    });
    await assert.rejects(() => confirm(0, active));
    await assert.rejects(() => buyers[0].call(escrow, 'submit_completion', completion(0, '2')));
    await merchant.call(escrow, 'submit_completion', completion(0, '2'));
    await buyers[0].call(escrow, 'object_agreement', completion(0, '2'));
    await confirm(0, active);
    await assert.rejects(() => root.call(escrow, 'settle_agreement', {...key(0), version: '2'}));
    const bonus = (await claims(0))[1];
    assert.equal(bonus.amount, '8');
    assert.equal(await claim(merchant, bonus.claim_id), true);

    const fallback = proposalFor(1);
    await propose(1, fallback);
    await assert.rejects(() => approve(1, fallback, merchant, digestFor(active)));
    await approve(1, fallback);
    await merchant.call(escrow, 'submit_completion', completion(1, '1'));
    await assert.rejects(() => root.call(escrow, 'settle_agreement', {...key(1), version: '1'}));
    const expired = proposalFor(2);
    await propose(2, expired);
    await worker.provider.fastForward(900);
    assert.equal((await agreement(2)).status, 'Expired');
    await assert.rejects(() => approve(2, expired));
    await assert.rejects(() => confirm(1, fallback));
    await assert.rejects(() => root.call(escrow, 'settle', key(1)));
    await root.call(escrow, 'settle_agreement', {...key(1), version: '1'});
    await assert.rejects(() => root.call(escrow, 'settle_agreement', {...key(1), version: '1'}));
    const fallbackClaims = await claims(1);
    assert.deepEqual(fallbackClaims.map(({recipient, amount}) => [recipient, amount]), [
      [merchant.accountId, '12'], [buyers[1].accountId, '5'], [merchant.accountId, '3'],
    ]);
    for (const record of fallbackClaims) {
      const recipient = record.recipient === merchant.accountId ? merchant : buyers[1];
      assert.equal(await claim(recipient, record.claim_id), true);
    }
    const normal = (await claims(3))[0];
    assert.equal(normal.agreement_version, '0');
    assert.equal(await claim(merchant, normal.claim_id), true);

    let liabilities = 0n;
    for (let index = 0; index < buyers.length; index++) {
      const {funded, unallocated, retained, available, pending, paid} = await ledger(index);
      const debt = [unallocated, retained, available, pending].reduce((total, amount) => total + BigInt(amount), 0n);
      assert.equal(debt + BigInt(paid), BigInt(funded));
      liabilities += debt;
    }
    assert.equal(liabilities, 20n);
    assert.equal(await balance(escrow), String(liabilities));
    assert.equal(await balance(merchant), '55');
    assert.equal(await balance(buyers[1]), '15');
    console.log(JSON.stringify({schema:'pactpay.sandbox-scenarios.v1',environment:'isolated-sandbox',
      proposals:{success:active,fallback},
      immediate:{buyer:'0',merchant:immediate.amount,retained:'8'},
      success:{buyer:'0',merchant:String(BigInt(immediate.amount)+BigInt(bonus.amount)),retained:'0'},
      fallback:{buyer:fallbackClaims.filter(record=>record.recipient===buyers[1].accountId).reduce((n,record)=>n+BigInt(record.amount),0n).toString(),
        merchant:fallbackClaims.filter(record=>record.recipient===merchant.accountId).reduce((n,record)=>n+BigInt(record.amount),0n).toString(),retained:'0'},
      finalEscrowBalance:await balance(escrow),finalLiabilities:String(liabilities)}));
    console.log('V2 Sandbox passed funding, stale and invalid agreements, success and fallback, retry, concurrent claims and conservation.');
  } finally {
    await worker.tearDown();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
