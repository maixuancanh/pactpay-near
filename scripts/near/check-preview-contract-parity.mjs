import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {previewAllocation} from '../../src/near/agreements/outcome-preview.ts';

export function checkScenario(scenario) {
  assert.equal(scenario.environment,'isolated-sandbox');
  const {success,fallback} = scenario.proposals ?? {};
  assert.ok(success && fallback,'Executed sandbox must include the exact committed proposals.');
  assert.deepEqual(previewAllocation(success,'immediate'),scenario.immediate);
  for (const [branch,proposal] of [['success',success],['fallback',fallback]]) {
    const immediate=previewAllocation(proposal,'immediate');
    const additional=previewAllocation(proposal,branch);
    assert.deepEqual({buyer:String(BigInt(immediate.buyer)+BigInt(additional.buyer)),
      merchant:String(BigInt(immediate.merchant)+BigInt(additional.merchant)),retained:additional.retained},scenario[branch],
      `${branch}: immediate plus additional UI allocation differs from executed contract claims`);
  }
}

const [input,...extra]=process.argv.slice(2);
assert.ok(input && !extra.length,'Usage: node scripts/near/check-preview-contract-parity.mjs stateful-gate-result.json');
const manifest=JSON.parse(await readFile(input,'utf8'));
assert.equal(manifest.status,'passed','Sandbox gate must pass before claiming UI/contract parity.');
for (const name of ['baseline','candidate','upgrade']) {
  const check=manifest.checks.find(item=>item.name===name);
  assert.equal(check?.exitCode,0);
  const scenarios=check.stdout.split(/\r?\n/).flatMap(line=>{
    try { const value=JSON.parse(line); return value.schema==='pactpay.sandbox-scenarios.v1' ? [value] : []; }
    catch { return []; }
  });
  assert.equal(scenarios.length,1,`${name}: missing or ambiguous executed scenario output`);
  checkScenario(scenarios[0]);
}
console.log(JSON.stringify({status:'passed',checks:9,source:'executed-WASM-claims',semantics:'terminal branch totals include immediate plus additional allocations'}));
