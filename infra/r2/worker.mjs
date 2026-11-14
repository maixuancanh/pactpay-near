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
  async scheduled(_event, env, ctx) {ctx.waitUntil(scanClaims(env));},
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
