import test from "node:test";
import assert from "node:assert/strict";
import {KeyPair} from "near-api-js";
import {makeHandler,nep413Digest} from "../../lib/near-evidence.mjs";

test("signed wallet login, one-time challenge, booking ACL and encrypted payload", async()=>{
  const map = new Map();
  const wallet = KeyPair.fromRandom("ed25519");
  const store = {get:async k=>map.get(k)??null,list:async prefix=>[...map.keys()].filter(k=>k.startsWith(prefix)),
    put:async(k,v)=>{if(map.has(k))return false;map.set(k,v);return true;}};
  const chain = {block:async()=>({header:{timestamp_nanosec:String(BigInt(Date.now())*1000000n)}}),query:async()=>({permission:"FullAccess"}),
    callFunction:async()=>({merchant:"merchant.testnet",positions:[{buyer:"buyer.testnet",dispute_until:String(Date.now()/1000+1000)}]})};
  const handler = makeHandler({store,chain,escrow:"escrow.testnet",secret:"local-test-".repeat(8)});
  async function post(body, session) {
    const reply={code:200,setHeader(){},status(code){this.code=code;return this;},json(data){this.data=data;return this;}};
    return handler({method:"POST",body,headers:{authorization:session?"Bearer "+session:undefined}},reply);
  }
  async function credentials(account) {
    const {data} = await post({action:"challenge",account});
    const signature=wallet.sign(nep413Digest(data.nonce));
    return {action:"login",token:data.token,accountId:account,publicKey:wallet.getPublicKey().toString(),signature:Buffer.from(signature.signature).toString("base64")};
  }
  const login=await credentials("buyer.testnet");
  const session=(await post(login)).data.session;
  assert.ok(session);
  assert.equal((await post(login)).code,400);
  const outsider=(await post(await credentials("outsider.testnet"))).data.session;
  assert.equal((await post({action:"list",booking:0,position:0},outsider)).code,403);
  const envelope={action:"upload",booking:0,position:0,ciphertext:Buffer.alloc(32,3).toString("base64"),
    iv:Buffer.alloc(12,2).toString("base64"),keys:{"buyer.testnet":Buffer.alloc(256,1).toString("base64"),
    "merchant.testnet":Buffer.alloc(256,4).toString("base64")}};
  const {data}=await post(envelope,session);
  assert.match(data.id,/^[0-9a-f]{64}$/);
  const merchant=(await post(await credentials("merchant.testnet"))).data.session;
  const opened=(await post({action:"read",booking:0,position:0,id:data.id},merchant)).data.item;
  assert.equal(opened.wrapped,envelope.keys["merchant.testnet"]);
  assert.equal(opened.ciphertext,envelope.ciphertext);
  const scope={booking:0,position:0};
  const proposed=await post({action:"remedy_propose",...scope,evidenceId:data.id,due:Math.floor(Date.now()/1000)+200},session);
  assert.equal(proposed.code,200);
  const id=proposed.data.id;
  assert.equal((await post({action:"remedy_accept",...scope,id},session)).code,400);
  assert.equal((await post({action:"remedy_complete",...scope,id},session)).code,400);
  assert.equal((await post({action:"remedy_accept",...scope,id},merchant)).code,200);
  assert.equal((await post({action:"remedy_complete",...scope,id},merchant)).code,400);
  assert.equal((await post({action:"remedy_complete",...scope,id},session)).code,200);
  const timeline=await post({action:"remedy_list",...scope},session);
  assert.equal(timeline.data.offers[0].completion.by,"buyer.testnet");
});
