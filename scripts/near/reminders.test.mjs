import test from "node:test";
import assert from "node:assert/strict";
import {agreementReminder,reminderForRole} from "../../lib/near-reminders.mjs";
import {scanResolution} from "../../infra/r2/worker.mjs";

const escrow="escrow-v2.pactpay-530c506b.testnet";
const proposal={network:"testnet",escrow,booking:"0",position:"0",version:"1",
  acceptBy:"5000",deliverBy:"6000",reviewUntil:"7000"};
const input={escrow,booking:0,position:0,time:1000,agreement:{status:"Proposed",approvals:1,proposal}};

test("reminder targets the unsigned party, expires at deadline, and changes with version and window",()=>{
  const first=reminderForRole(input,"merchant");
  assert.ok(first);
  assert.equal(first.type,"approve");
  assert.equal(first.window,86400);
  assert.equal(reminderForRole(input,"buyer"),null);
  assert.equal(agreementReminder({...input,time:5000}),null);
  const soon=agreementReminder({...input,time:4600});
  assert.equal(soon.window,3600);
  assert.notEqual(soon.key,first.key);
  assert.notEqual(agreementReminder({...input,agreement:{...input.agreement,proposal:{...proposal,version:"2"}}}).key,first.key);
  assert.equal(agreementReminder({...input,agreement:{...input.agreement,status:"CompletionSubmitted"}}).role,"buyer");
  assert.equal(agreementReminder({...input,agreement:{...input.agreement,status:"Completed"}}),null);
  assert.equal(agreementReminder({...input,position:1}),null);
});

function bucket() {
  const rows=new Map();
  let writes=0;
  return {
    rows,
    async get(key) {
      const row=rows.get(key);
      return row && {httpEtag:row.etag,json:async()=>JSON.parse(row.value)};
    },
    async put(key,value,{onlyIf}={}) {
      const row=rows.get(key);
      if (onlyIf?.has("if-none-match") && row || onlyIf?.has("if-match") && row?.etag!==onlyIf.get("if-match")) return null;
      const next={etag:`"${++writes}"`,value};
      rows.set(key,next);
      return next;
    },
  };
}

function rpc() {
  return async (_url,request)=>{
    const {method,params}=JSON.parse(request.body);
    if (method==="block") return Response.json({result:{header:{hash:"head",timestamp_nanosec:"1000000000000"}}});
    assert.equal(params.account_id,escrow);
    const args=JSON.parse(atob(params.args_base64));
    const values={
      get_booking:args.id===0?{positions:[{}]}:null,
      get_agreement:input.agreement,
      get_position_ledger:{pending:"8"},
    };
    if (params.method_name!=="get_booking") assert.equal(params.block_id,"head");
    return Response.json({result:{result:[...new TextEncoder().encode(JSON.stringify(values[params.method_name]))],
      block_hash:"head",block_height:100}});
  };
}

test("overlapping runs persist one snapshot and advance one step",async()=>{
  const env={EVIDENCE:bucket()};
  const send=rpc();
  await Promise.all([scanResolution(env,send,1000000),scanResolution(env,send,1000000)]);
  const record=await (await env.EVIDENCE.get("monitor/v2/bookings/0/0")).json();
  assert.equal(record.pending,"8");
  assert.equal(record.reminder.key,agreementReminder(input).key);
  assert.equal((await (await env.EVIDENCE.get("monitor/v2/cursor")).json()).id,1);
  assert.equal(env.EVIDENCE.rows.size,2);
});

test("RPC failure retains cursor, applies backoff, and resumes after recovery",async()=>{
  const env={EVIDENCE:bucket()};
  const failed=async()=>{throw Error("offline");};
  await assert.rejects(scanResolution(env,failed,1000000),/offline/);
  const read=async()=> (await env.EVIDENCE.get("monitor/v2/cursor")).json();
  assert.equal((await read()).id,0);
  assert.equal((await read()).failures,1);
  await scanResolution(env,failed,1100000);
  assert.equal((await read()).failures,1);
  await scanResolution(env,rpc(),1300000);
  assert.equal((await read()).id,1);
  assert.equal((await read()).lastSuccess,1300000);
  assert.equal((await read()).failures,0);
});
