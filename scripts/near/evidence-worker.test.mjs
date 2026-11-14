import test from "node:test";
import assert from "node:assert/strict";
import worker from "../../infra/r2/worker.mjs";

test("V2 worker returns every page using opaque R2 cursors",async()=>{
  const key="evidence-v2/testnet/escrow.testnet/0/0/buyer.testnet/entries/";
  const env={STORAGE_SECRET:"test",EVIDENCE:{async list({prefix,cursor}) {
    assert.equal(prefix,key);
    return cursor === undefined
      ? {truncated:true,cursor:"page-2",objects:[{key:key+"1"}]}
      : {truncated:false,objects:[{key:key+"2"}]};
  }}};
  const response=await worker.fetch(new Request("https://example.com/?"+new URLSearchParams({op:"list",key}),
    {headers:{authorization:"Bearer test"}}),env);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),[key+"1",key+"2"]);
});
