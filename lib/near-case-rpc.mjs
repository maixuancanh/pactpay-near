import {setTimeout as delay} from "node:timers/promises";

const testnetArchive = "https://archival-rpc.testnet.fastnear.com";
const testnetRecent = "https://rpc.testnet.fastnear.com";

export function caseReader(signal) {
  const reads = new Map();
  function rpc(method, params) {
    const key = JSON.stringify([method, params]);
    const existing = reads.get(key);
    if (existing) return existing;
    const request = requestRpc(method, params).catch(error => {
      reads.delete(key);
      throw error;
    });
    reads.set(key, request);
    return request;
  }

  async function requestRpc(method, params) {
    for (let attempt=0; attempt<3; attempt++) {
      for (const endpoint of [testnetArchive,testnetRecent]) {
        const response = await fetch(endpoint,{
          method:"POST",headers:{"content-type":"application/json"},
          body:JSON.stringify({jsonrpc:"2.0",id:"pactpay-case",method,params}),signal,
        });
        if (response.ok) {
          const data = await response.json();
          if (data.result) return data.result;
        } else {
          await response.body?.cancel();
        }
      }
      if (attempt<2) await delay((attempt+1)*1000,undefined,{signal});
    }
    throw new Error("NEAR RPC unavailable.");
  }
  const blockParams = blockId => blockId ? {block_id:blockId} : {finality:"final"};
  return {
    transaction:(hash, signer) => rpc("EXPERIMENTAL_tx_status",{
      tx_hash:hash,sender_account_id:signer,wait_until:"FINAL",
    }),
    async view(account, method, args, blockId) {
      const data = await rpc("query",{
        request_type:"call_function",account_id:account,method_name:method,...blockParams(blockId),
        args_base64:Buffer.from(JSON.stringify(args)).toString("base64"),
      });
      return JSON.parse(Buffer.from(data.result).toString("utf8"));
    },
    blockHeight:async blockId => (await rpc("block",blockParams(blockId))).header.height,
    finalBlock:async () => (await rpc("block",{finality:"final"})).header.hash,
    codeHash:async (account,blockId) => (await rpc("query",{
      request_type:"view_account",account_id:account,...blockParams(blockId),
    })).code_hash,
  };
}
