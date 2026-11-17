import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const [token,baseline,candidate,fault,badMigration,output,...extra] = process.argv.slice(2);
if (!output || extra.length) throw new Error('Usage: node scripts/near/stateful-release-gate.mjs token.wasm baseline.wasm candidate.wasm callback-fault.wasm bad-migration.wasm manifest.json');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const artifacts = {};
for (const [name,path] of Object.entries({token,baseline,candidate,fault,badMigration})) {
  const bytes = await readFile(path);
  if (!bytes.subarray(0,4).equals(Buffer.from([0,97,115,109]))) throw new Error(`Not a WASM artifact: ${name}`);
  artifacts[name] = {path:resolve(path),sha256:sha(bytes)};
}
const git = args => spawnSync('git',args,{cwd:root,encoding:'utf8'}).stdout?.trim() ?? '';
const manifest = {schema:'pactpay.stateful-gate.v1',startedAt:new Date().toISOString(),
  commit:git(['rev-parse','HEAD']),workingTreeDirty:Boolean(git(['status','--porcelain'])),artifacts,
  baselineEqualsCandidate:artifacts.baseline.sha256 === artifacts.candidate.sha256,
  snapshotSource:'Isolated near-workspaces sandbox fixtures, not a production snapshot',
  scope:'Baseline/candidate funded state read compatibility, behavior, conservation, callback-loss recovery',
  limitation:'Healthy upgrade preserves current Borsh schema; the injected migration corrupts one funded share in isolated sandbox.',
  checks:[],status:'failed'};
const checks = [
  ['replay','--test','scripts/near/case-index.test.mjs'],
  ['baseline','contracts/near-v2/sandbox.cjs',artifacts.token.path,artifacts.baseline.path],
  ['candidate','contracts/near-v2/sandbox.cjs',artifacts.token.path,artifacts.candidate.path],
  ['upgrade','contracts/near-v2/sandbox.cjs',artifacts.token.path,artifacts.baseline.path,artifacts.candidate.path],
  ['callback-loss-upgrade','contracts/near-v2/sandbox-recovery.cjs',artifacts.token.path,artifacts.fault.path,artifacts.candidate.path],
];
try {
  for (const [name,...args] of checks) {
    console.log(`Starting sandbox gate check: ${name}`);
    const result = spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',timeout:300000,maxBuffer:8*1024*1024});
    manifest.checks.push({name,command:[process.execPath,...args],exitCode:result.status,
      stdout:result.stdout ?? '',stderr:result.stderr ?? '',error:result.error?.message});
    if (result.status !== 0 || result.error) throw new Error(`Release gate failed: ${name}`);
  }
  const negativeArgs = ['contracts/near-v2/sandbox.cjs',artifacts.token.path,artifacts.baseline.path,artifacts.badMigration.path];
  console.log('Starting injected migration negative control');
  const negative = spawnSync(process.execPath,negativeArgs,{cwd:root,encoding:'utf8',timeout:300000,maxBuffer:8*1024*1024,
    env:{...process.env,PACTPAY_SANDBOX_BAD_MIGRATION:'1'}});
  const detected = negative.status !== 0 && !negative.error &&
    (negative.stderr ?? '').includes('State changed during candidate upgrade: partially-funded');
  manifest.checks.push({name:'injected-migration-rejected',command:[process.execPath,...negativeArgs],
    environment:{PACTPAY_SANDBOX_BAD_MIGRATION:'1'},exitCode:negative.status,expectedFailureDetected:detected,
    stdout:negative.stdout ?? '',stderr:negative.stderr ?? ''});
  if (!detected) throw new Error('Gate did not catch the injected funded-state migration fault.');
  manifest.status = 'passed';
} finally {
  manifest.finishedAt = new Date().toISOString();
  await mkdir(dirname(resolve(output)),{recursive:true});
  await writeFile(output,JSON.stringify(manifest,null,2)+'\n');
  console.log(JSON.stringify({status:manifest.status,manifest:resolve(output)}));
}
