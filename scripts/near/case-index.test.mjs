import {test} from "node:test";
import assert from "node:assert/strict";
import {indexReference,makeCaseIndexHandler} from "../../lib/near-case-index.mjs";
import {findHistoricalClaim} from "./verify-resolution-case.mjs";

const escrow = "escrow.example.testnet";
const ref = {hash:"A".repeat(43),signer:"buyer.testnet"};
const blockHash = "B".repeat(43);
const receiptId = "C".repeat(43);
const digest = "a".repeat(64);
const scope = {network:"testnet",escrow,booking:"9",position:"1",version:"3"};

function fixture() {
  return {
    final_execution_status:"FINAL", status:{SuccessValue:""},
    transaction:{hash:ref.hash,signer_id:ref.signer,receiver_id:escrow,actions:[{FunctionCall:{
      method_name:"approve_agreement",args:Buffer.from(JSON.stringify({id:9,index:1,version:"3",digest})).toString("base64"),
    }}]},
    receipts_outcome:[{id:receiptId,block_hash:blockHash,outcome:{executor_id:escrow,status:{SuccessValue:""},logs:[
      "EVENT_JSON:"+JSON.stringify({standard:"pactpay",version:"2.0.0",event:"agreement_activated",data:[
        {booking:"9",position:"1",version:"3",digest,actor:ref.signer},
      ]}),
    ]}}],
  };
}

function reader(tx = fixture()) {
  return {transaction:async () => tx,blockHeight:async () => 12};
}

function store() {
  const objects = new Map();
  return {
    get:async key => objects.get(key) ?? null,
    list:async prefix => [...objects.keys()].filter(key => key.startsWith(prefix)),
    put:async (key,value) => {
      if (objects.has(key)) return false;
      objects.set(key,value);
      return true;
    },
  };
}

async function request(handler,method,data) {
  const result = {status:200,body:null};
  const res = {
    setHeader() {},
    status(code) {result.status=code;return res;},
    json(body) {result.body=body;return res;},
  };
  await handler(method === "GET" ? {method,query:data} : {method,body:data},res);
  return result;
}

test("uses the chain event scope and rejects forged or unrelated transaction references", async () => {
  const result = await indexReference(reader(),escrow,{...ref,booking:"500"});
  assert.deepEqual(result.scope,scope);
  assert.deepEqual(result.receiptIds,[receiptId]);
  assert.equal(result.kind,"approval");
  await assert.rejects(indexReference(reader(),escrow,{...ref,hash:"Z".repeat(43)}));
  await assert.rejects(indexReference(reader(),escrow,{...ref,signer:"other.testnet"}));
  const mismatch = fixture();
  mismatch.transaction.actions[0].FunctionCall.args = Buffer.from(JSON.stringify({id:8,index:1,version:"3",digest})).toString("base64");
  await assert.rejects(indexReference(reader(mismatch),escrow,ref),/match the escrow event/);
});

test("parent success does not prove a failed child receipt", async () => {
  const tx = fixture();
  tx.receipts_outcome[0].outcome.status = {Failure:{}};
  await assert.rejects(indexReference(reader(tx),escrow,ref),/matching successful/);
});

test("finds a matching historical Paid claim after the first page", async () => {
  const record = {claim_id:"42",agreement_version:"3",status:"Paid"};
  const pages = [];
  const rpc = {view:async (_account,_method,args) => {
    pages.push(args.from_index);
    return args.from_index === 0 ? Array(20).fill({claim_id:"0"}) : [record];
  }};
  assert.deepEqual(await findHistoricalClaim(rpc,scope,"42",blockHash),record);
  assert.deepEqual(pages,[0,20]);
});

test("concurrent receipt indexing produces one durable scope-scoped record", async () => {
  const handler = makeCaseIndexHandler({reader:reader(),store:store(),escrow,admit:() => true});
  const [first,second] = await Promise.all([request(handler,"POST",ref),request(handler,"POST",ref)]);
  assert.equal(first.status,200);
  assert.deepEqual(first,second);
  const result = await request(handler,"GET",scope);
  assert.deepEqual(result.body,{coverage:"partial",references:[first.body.reference],nextCursor:null});
  assert.deepEqual((await request(handler,"GET",{...scope,booking:"8"})).body.references,[]);
});

test("pending and unavailable lookups leave the index untouched", async () => {
  const tx = fixture();
  tx.final_execution_status = "EXECUTED_OPTIMISTIC";
  const handler = makeCaseIndexHandler({reader:reader(tx),store:store(),escrow,admit:() => true});
  assert.equal((await request(handler,"POST",ref)).status,202);
  assert.deepEqual((await request(handler,"GET",scope)).body.references,[]);
  const failedReader = {transaction:async () => {throw new Error("RPC unavailable");}};
  const offline = makeCaseIndexHandler({reader:failedReader,store:store(),escrow,admit:() => true});
  assert.equal((await request(offline,"POST",ref)).status,503);
});

// Recovery performs only read RPCs and immutable history writes; it never imports
// a wallet, signer, claim retry, or financial reconciliation client.
test("replay survives interruption after every write without dropping older events", async () => {
  const {replayReferences} = await import('../../lib/near-case-index.mjs');
  const {diskStore} = await import('./case-index-replay.mjs');
  const {mkdtemp,rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const older = {hash:'D'.repeat(43),signer:ref.signer};
  const olderTx = fixture();
  olderTx.transaction.hash = older.hash;
  olderTx.receipts_outcome[0].id = 'E'.repeat(43);
  olderTx.receipts_outcome[0].block_hash = 'F'.repeat(43);
  const rpc = {transaction:async hash => hash === older.hash ? olderTx : fixture(),
    blockHeight:async hash => hash === blockHash ? 12 : 11};
  for (const failAt of [1,2,3]) {
    const directory = await mkdtemp(join(tmpdir(),'pactpay-replay-'));
    try {
      const disk = diskStore(directory);
      let writes = 0;
      const crashing = {...disk,put:async (...args) => {
        const result = await disk.put(...args);
        if (++writes === failAt) throw new Error('process interrupted');
        return result;
      }};
      await assert.rejects(replayReferences({reader:rpc,store:crashing,escrow,references:[ref]}),/interrupted/);
      // Reopen the actual disk store, rather than carrying an in-memory checkpoint.
      const records = await replayReferences({reader:rpc,store:diskStore(directory),escrow,
        references:[ref,older,ref,older]});
      assert.deepEqual(records.map(record => record.blockHeight),['11','12']);
      assert.equal(records[1].eventId,`testnet:${escrow}:${receiptId}:0:0`);
      assert.deepEqual(await replayReferences({reader:rpc,store:diskStore(directory),escrow,
        references:[older,ref]}),records);
    } finally { await rm(directory,{recursive:true,force:true}); }
  }
});

test("replay rejects wrong contract and never checkpoints unfinalized receipts", async () => {
  const {replayReferences} = await import('../../lib/near-case-index.mjs');
  const tx = fixture();
  const records = store();
  tx.final_execution_status = 'EXECUTED_OPTIMISTIC';
  await assert.rejects(replayReferences({reader:reader(tx),store:records,escrow,references:[ref]}),/unfinalized/);
  assert.deepEqual(await records.list('evidence-v2/'),[]);
  tx.final_execution_status = 'FINAL';
  tx.receipts_outcome[0].outcome.executor_id = 'other.testnet';
  await assert.rejects(replayReferences({reader:reader(tx),store:records,escrow,references:[ref]}));
  assert.deepEqual(await records.list('evidence-v2/'),[]);
});

test("a terminated worker resumes from disk without relying on process memory", async () => {
  const {replayReferences} = await import('../../lib/near-case-index.mjs');
  const {diskStore} = await import('./case-index-replay.mjs');
  const {mkdtemp,rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {spawnSync} = await import('node:child_process');
  for (const boundary of [1,2,3]) {
    const directory = await mkdtemp(join(tmpdir(),'pactpay-worker-kill-'));
    try {
      const script = `
        import {replayReferences} from ${JSON.stringify(new URL('../../lib/near-case-index.mjs',import.meta.url).href)};
        import {diskStore} from ${JSON.stringify(new URL('./case-index-replay.mjs',import.meta.url).href)};
        const store = diskStore(${JSON.stringify(directory)});
        let writes = 0;
        const workerStore = {...store,put:async (...args) => {
          const saved = await store.put(...args);
          if (++writes === ${boundary}) process.kill(process.pid,'SIGKILL');
          return saved;
        }};
        await replayReferences({reader:{transaction:async () => (${JSON.stringify(fixture())}),blockHeight:async () => 12},
          store:workerStore,escrow:${JSON.stringify(escrow)},references:[${JSON.stringify(ref)}]});
      `;
      const stopped = spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:15000});
      assert.equal(stopped.error,undefined);
      assert.notEqual(stopped.status,0);
      assert.equal(stopped.stderr,'');
      const reopened = diskStore(directory);
      const restored = await replayReferences({reader:reader(),store:reopened,escrow,references:[ref,ref]});
      assert.equal(restored.length,1);
      assert.equal(restored[0].eventId,`testnet:${escrow}:${receiptId}:0:0`);
    } finally { await rm(directory,{recursive:true,force:true}); }
  }
});

test("event identity includes original log position rather than filtered-event order", async () => {
  const tx=fixture();
  tx.receipts_outcome[0].outcome.logs.unshift('diagnostic log');
  const record=await indexReference(reader(tx),escrow,ref);
  assert.equal(record.logIndex,1);
  assert.equal(record.eventId,`testnet:${escrow}:${receiptId}:1:0`);
});
