async function scanClaims(env) {
  const escrow="escrow.pactpay-530c506b.testnet";
  const cursor=await env.EVIDENCE.get("monitor/cursor");
  let id=cursor ? Number(await cursor.text()) : 0;
  for(let i=0;i<8;i++){
    const response=await fetch("https://test.rpc.fastnear.com",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({jsonrpc:"2.0",id:"pactpay-monitor",method:"query",params:{
        request_type:"call_function",finality:"final",account_id:escrow,
        method_name:"get_booking",args_base64:btoa(JSON.stringify({id}))
      }}),signal:AbortSignal.timeout(10000),
    });
    const data=await response.json();
    if(!response.ok || !Array.isArray(data.result?.result))throw new Error("Monitor RPC unavailable");
    const booking=JSON.parse(new TextDecoder().decode(Uint8Array.from(data.result.result)));
    if(!booking){id=0;break;}
    const pending=booking.positions.flatMap((position,index)=>position.claims.flatMap((state,slot)=>
      state==="Pending"?[{index,role:slot===0?"buyer":"merchant"}]:[]));
    await env.EVIDENCE.put("monitor/bookings/"+id,JSON.stringify({id,pending,checkedAt:new Date().toISOString()}));
    if(pending.length) console.warn("Pending NEAR claims",JSON.stringify({id,pending}));
    id++;
  }
  await env.EVIDENCE.put("monitor/cursor",String(id));
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(scanClaims(env));
    ctx.waitUntil(scanResolution(env));
  },
  async fetch(request, env) {
    if (!env.STORAGE_SECRET || request.headers.get("authorization") !== "Bearer " + env.STORAGE_SECRET)
      return new Response(null,{status:404});
    const url = new URL(request.url);
    const key = url.searchParams.get("key") || "";
    const op = url.searchParams.get("op");
    if (!/^(keys|evidence|evidence-v2|used|ai-used|ai-quota)\/[a-zA-Z0-9/._-]{1,250}$/.test(key) || key.includes(".."))
      return new Response(null,{status:400});
    if (request.method === "GET" && op === "get") {
      const item = await env.EVIDENCE.get(key);
      return item ? new Response(item.body,{headers:{"content-type":"application/json","cache-control":"no-store"}}) : new Response(null,{status:404});
    }
    if (request.method === "GET" && op === "list") {
      const keys = [];
      let cursor;
      do {
        const result = await env.EVIDENCE.list({prefix:key,limit:100,cursor});
        keys.push(...result.objects.map(item=>item.key));
        if (!key.startsWith("evidence-v2/") || !result.truncated) break;
        if (!result.cursor || result.cursor === cursor) return new Response(null,{status:502});
        cursor = result.cursor;
      } while (cursor);
      return Response.json(keys);
    }
    if (request.method === "PUT" && op === "put") {
      const body = await request.arrayBuffer();
      if (body.byteLength > 900000) return new Response(null,{status:413});
      const result = await env.EVIDENCE.put(key,body,{onlyIf:new Headers({"if-none-match":"*"})});
      return new Response(null,{status:result ? 201 : 412});
    }
    return new Response(null,{status:405});
  }
};
import {agreementReminder} from "../../lib/near-reminders.mjs";

const resolutionEscrow = "escrow-v2.pactpay-530c506b.testnet";
const resolutionCursor = "monitor/v2/cursor";

async function queryEscrow(method, args, block, send) {
  const response = await send("https://test.rpc.fastnear.com",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0",id:"pactpay-monitor-v2",method:"query",params:{
      request_type:"call_function",account_id:resolutionEscrow,method_name:method,
      args_base64:btoa(JSON.stringify(args)),...(block ? {block_id:block} : {finality:"final"}),
    }}),signal:AbortSignal.timeout(10000),
  });
  const {result} = await response.json();
  if (!response.ok || !Array.isArray(result?.result) || !result.block_hash) throw new Error("Resolution monitor RPC unavailable");
  if (block && block !== result.block_hash) throw new Error("Resolution monitor block changed");
  return {value:JSON.parse(new TextDecoder().decode(Uint8Array.from(result.result))),block:result.block_hash,
    height:result.block_height};
}

function ifUnchanged(object) {
  return object ? new Headers({"if-match":object.httpEtag}) : new Headers({"if-none-match":"*"});
}

async function blockTime(block, send) {
  const response = await send("https://test.rpc.fastnear.com",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0",id:"pactpay-monitor-v2-block",method:"block",params:{block_id:block}}),
    signal:AbortSignal.timeout(10000),
  });
  const {result} = await response.json();
  const timestamp = result?.header?.timestamp_nanosec;
  if (!response.ok || result?.header?.hash !== block || typeof timestamp !== "string" || !/^\d+$/.test(timestamp)) {
    throw new Error("Resolution monitor block time unavailable");
  }
  return Number(BigInt(timestamp)/1000000000n);
}

/** Read-only monitor. A pending balance by itself never permits a transfer retry. */
export async function scanResolution(env, send=fetch, now=Date.now()) {
  const store = env.EVIDENCE;
  const previous = await store.get(resolutionCursor);
  const state = previous ? await previous.json() : {id:0,index:0,failures:0};
  if (state.nextRun > now) return;
  let {id,index} = state;
  try {
    const {value:booking,block,height} = await queryEscrow("get_booking",{id},undefined,send);
    if (!booking || index >= booking.positions.length) {
      id = booking ? id+1 : 0;
      index = 0;
    } else {
      const [time, agreement, ledger] = await Promise.all([
        blockTime(block,send),
        queryEscrow("get_agreement",{id,index},block,send),
        queryEscrow("get_position_ledger",{id,index},block,send),
      ]);
      const pending = ledger.value?.pending;
      if (typeof pending !== "string" || !/^\d+$/.test(pending) || !Number.isSafeInteger(height)) {
        throw new Error("Resolution monitor received invalid position data");
      }
      const reminder = agreementReminder({escrow:resolutionEscrow,booking:id,position:index,agreement:agreement.value,time});
      const key = "monitor/v2/bookings/"+id+"/"+index;
      const previousSnapshot = await store.get(key);
      const previousHeight = previousSnapshot ? (await previousSnapshot.json()).height : -1;
      if (height > previousHeight) {
        const saved = await store.put(key,JSON.stringify({id,index,block,height,pending,reminder,checkedAt:new Date(now).toISOString()}),
          {onlyIf:ifUnchanged(previousSnapshot)});
        if (!saved) return;
      }
      if (++index >= booking.positions.length) {
        id++;
        index = 0;
      }
    }
    await store.put(resolutionCursor,JSON.stringify({id,index,failures:0,lastSuccess:now}),{onlyIf:ifUnchanged(previous)});
  } catch (error) {
    const failures = Math.min(5,(state.failures ?? 0)+1);
    await store.put(resolutionCursor,JSON.stringify({...state,failures,nextRun:now+300000*2**(failures-1),
      error:"resolution-monitor-read-failed"}),{onlyIf:ifUnchanged(previous)});
    throw error;
  }
}
