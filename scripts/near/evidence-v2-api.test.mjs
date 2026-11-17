import test from "node:test";
import assert from "node:assert/strict";
import {KeyPair} from "near-api-js";
import {makeHandler, nep413Digest} from "../../lib/near-evidence.mjs";

const ESCROW = "resolution.testnet";
const BUYER = "buyer.testnet";
const MERCHANT = "merchant.testnet";
const scope = {escrow:ESCROW,booking:"0",position:0};

function setup() {
  const records = new Map();
  const store = {
    get:async key=>records.get(key)??null,
    list:async prefix=>[...records.keys()].filter(key=>key.startsWith(prefix)),
    put:async(key,value)=>{
      if(records.has(key)) return false;
      records.set(key,value);
      return true;
    },
  };
  const chain = {
    query:async()=>({permission:"FullAccess"}),
    callFunction:async(_escrow,_method,{id},options)=>{
      assert.equal(options.finality,"final");
      assert.equal(typeof id,"number");
      return {merchant:id===1?"other-merchant.testnet":MERCHANT,positions:[{buyer:id===1?"other-buyer.testnet":BUYER,dispute_until:"9999999999"}]};
    },
  };
  const handler=makeHandler({store,chain,escrow:"legacy.testnet",escrowV2:ESCROW,evidenceRecipient:"review.example",secret:"test-secret-".repeat(8)});
  async function post(body,session) {
    const reply={code:200,setHeader(){},status(code){this.code=code;return this;},json(data){this.data=data;return this;}};
    return handler({method:"POST",body,headers:{authorization:session?"Bearer "+session:undefined}},reply);
  }
  const wallet=KeyPair.fromRandom("ed25519");
  async function credentials(account,escrow=ESCROW) {
    const {data}=await post({action:"challenge",escrow,account});
    const digest=nep413Digest(data.nonce,data.message,data.recipient);
    return {escrow,action:"login",token:data.token,accountId:account,publicKey:wallet.getPublicKey().toString(),signature:Buffer.from(wallet.sign(digest).signature).toString("base64")};
  }
  async function login(account) {
    const reply=await post(await credentials(account));
    assert.ok(reply.data.session,JSON.stringify(reply.data));
    return reply.data.session;
  }
  return {records,post,credentials,login};
}

const envelope={
  ciphertext:Buffer.alloc(32,3).toString("base64"),
  iv:Buffer.alloc(12,2).toString("base64"),
  keys:{[BUYER]:Buffer.alloc(256,1).toString("base64"),[MERCHANT]:Buffer.alloc(256,4).toString("base64")},
};
const upload={...scope,...envelope,action:"upload",sequence:1,previousEntryHash:null,idempotencyKey:"evidence-upload-first"};

test("V2 challenges and sessions are scoped to escrow and domain, one-use and expiring",async()=>{
  const {post,credentials}=setup();
  const {data}=await post({action:"challenge",escrow:ESCROW,account:BUYER});
  assert.equal(data.recipient,"review.example");
  assert.match(data.message,/testnet.*resolution.testnet/);
  const login=await credentials(BUYER);
  assert.equal((await post({...login,escrow:"legacy.testnet"})).code,400);
  const first=await post(login);
  assert.ok(first.data.session);
  assert.equal((await post(login)).code,400);
  assert.equal((await post({action:"list",booking:0,position:0},first.data.session)).code,400);
  const legacy=await post(await credentials(BUYER,"legacy.testnet"));
  assert.equal((await post({...scope,action:"list"},legacy.data.session)).code,400);
  const now=Date.now;
  Date.now=()=>now()+16*60*1000;
  try {
    assert.equal((await post({...scope,action:"list"},first.data.session)).code,400);
  } finally { Date.now=now; }
});

test("V2 evidence enforces finalized case ACL and append-only sequencing",async()=>{
  const {post,login,records}=setup();
  const buyer=await login(BUYER);
  const merchant=await login(MERCHANT);
  const outsider=await login("outsider.testnet");
  assert.equal((await post({...scope,action:"list"},outsider)).code,403);
  assert.equal((await post({...scope,action:"list",booking:"1"},buyer)).code,403);
  assert.equal((await post({...scope,action:"list",profileMode:"merchant"},outsider)).code,403);
  const responses=await Promise.all([post(upload,buyer),post(upload,buyer)]);
  assert.ok(responses.every(reply=>reply.code===200));
  const entry=responses[0].data.entry;
  assert.deepEqual(responses[1].data.entry,entry);
  assert.deepEqual(entry.case,{network:"testnet",...scope});
  assert.equal(entry.author,BUYER);
  assert.match(entry.entryHash,/^[a-f0-9]{64}$/);
  assert.equal((await post({...upload,idempotencyKey:"different-key"},buyer)).code,409);
  assert.equal((await post({...upload,sequence:2,previousEntryHash:"a".repeat(64),idempotencyKey:"evidence-upload-second"},buyer)).code,409);
  const initialSnapshot=(await post({...scope,action:"list"},buyer)).data;
  const second=await post({...upload,sequence:2,previousEntryHash:entry.entryHash,supersedes:entry.entryHash,kind:"completion",idempotencyKey:"evidence-upload-second"},buyer);
  assert.equal(second.data.entry.supersedes,entry.entryHash);
  assert.equal(second.data.entry.kind,"completion");
  const list=await post({...scope,action:"list"},merchant);
  assert.deepEqual(list.data.entries,[entry,second.data.entry]);
  assert.match(list.data.evidenceRoot,/^[a-f0-9]{64}$/);
  assert.notEqual(list.data.evidenceRoot,initialSnapshot.evidenceRoot);
  assert.deepEqual((await post({...scope,action:"list",evidenceRoot:initialSnapshot.evidenceRoot},merchant)).data,initialSnapshot);
  assert.equal((await post({...scope,action:"list",evidenceRoot:"a".repeat(64)},merchant)).code,404);
  const read={...scope,action:"read",author:BUYER,sequence:1};
  const opened=await post(read,merchant);
  assert.equal(opened.data.item.wrapped,envelope.keys[MERCHANT]);
  assert.equal((await post({...scope,action:"revoke",sequence:1},merchant)).code,404);
  assert.ok((await post({...scope,action:"revoke",sequence:1},buyer)).data.ok);
  assert.equal((await post(read,merchant)).code,403);
  assert.ok((await post(read,buyer)).data.item.wrapped);
  assert.equal((await post({...scope,action:"list"},merchant)).data.evidenceRoot,list.data.evidenceRoot);
  const canary="private invoice canary";
  const invalid=await post({...upload,ciphertext:canary},buyer);
  assert.equal(invalid.code,400);
  assert.ok(!JSON.stringify([invalid.data,...records.entries()]).includes(canary));
  const path=[...records.keys()].find(key=>key.endsWith("/"+entry.sourceLocator));
  assert.ok(path);
  const record=records.get(path);
  records.set(path,{...record,entry:{...record.entry,kind:"evidence",ciphertextHash:"f".repeat(64)}});
  assert.equal((await post({...scope,action:"list"},buyer)).code,400);
  assert.equal((await post({...scope,action:"list",evidenceRoot:initialSnapshot.evidenceRoot},buyer)).code,400);
});
test("V2 inference ticket is unavailable without configuration and scoped to finalized case when issued",async()=>{
  const {post,login}=setup();
  const buyer=await login(BUYER);
  const previous=process.env.NEARAI_API_KEY;
  delete process.env.NEARAI_API_KEY;
  try {
    const request={...scope,action:"ai_ticket"};
    assert.equal((await post(request,buyer)).code,503);
    process.env.NEARAI_API_KEY="synthetic-key";
    assert.equal((await post({...request,booking:"1"},buyer)).code,403);
    const {data}=await post(request,buyer);
    const metadata=JSON.parse(Buffer.from(data.ticket.split(".")[0],"base64url"));
    assert.deepEqual(metadata.case,{network:"testnet",...scope});
    assert.equal(metadata.account,BUYER);
    await post(request,buyer);
    await post(request,buyer);
    assert.equal((await post(request,buyer)).code,429);
  } finally {
    if (previous===undefined) delete process.env.NEARAI_API_KEY;
    else process.env.NEARAI_API_KEY=previous;
  }
});

test("V2 AI budget is read-only, participant scoped and remains bounded under concurrent requests",async()=>{
  const {post,login}=setup();
  const buyer=await login(BUYER);
  const outsider=await login("outsider.testnet");
  const previous=process.env.NEARAI_API_KEY;
  process.env.NEARAI_API_KEY="synthetic-key";
  try {
    assert.equal((await post({...scope,action:"ai_budget"},outsider)).code,403);
    const before=await post({...scope,action:"ai_budget"},buyer);
    assert.equal(before.data.budget.remaining,3);
    assert.equal((await post({...scope,action:"ai_budget"},buyer)).data.budget.remaining,3);
    const replies=await Promise.all(Array.from({length:8},()=>post({...scope,action:"ai_ticket"},buyer)));
    assert.equal(replies.filter(reply=>reply.code===200).length,3);
    assert.equal(replies.filter(reply=>reply.code===429).length,5);
    assert.equal((await post({...scope,action:"ai_budget"},buyer)).data.budget.remaining,0);
  } finally {
    if(previous===undefined) delete process.env.NEARAI_API_KEY; else process.env.NEARAI_API_KEY=previous;
  }
});
