import {providers} from "near-api-js";
import {verifyResolutionCase} from "../scripts/near/verify-resolution-case.mjs";

const rpc = new providers.JsonRpcProvider({url:"https://test.rpc.fastnear.com"});

export default async function handler(req,res) {
  res.setHeader("Cache-Control","no-store");
  if(req.method!=="POST")return res.status(405).json({error:"Use POST."});
  const data=req.body;
  const escrow=process.env.PACTPAY_NEAR_ESCROW_V2;
  if(!escrow || !data || typeof data!=="object" || Object.hasOwn(data,"authorized") ||
    data.escrow!==escrow || JSON.stringify(data).length>24000) {
    return res.status(400).json({error:"Select a public proof for the configured testnet escrow."});
  }
  const reader={
    transaction:(hash,signer)=>rpc.txStatusReceipts(hash,signer,"FINAL"),
    view:(account,method,args,blockId)=>rpc.callFunction(account,method,args,{blockId}),
    codeHash:async(account,blockId)=>(await rpc.query({request_type:"view_account",account_id:account,block_id:blockId})).code_hash,
  };
  if(data.codeHash===null && data.receipts?.approval){
    const {hash,signer}=data.receipts.approval;
    if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hash) || signer!==data.proposal?.buyer && signer!==data.proposal?.merchant)
      return res.status(400).json({error:"Invalid approval reference."});
    try{
      const tx=await reader.transaction(hash,signer);
      const receipt=tx.receipts_outcome?.find(item=>item.outcome?.executor_id===escrow);
      if(tx.final_execution_status!=="FINAL" || tx.transaction?.receiver_id!==escrow || !receipt?.block_hash)
        throw Error("Approval unavailable");
      data.codeHash=await reader.codeHash(escrow,receipt.block_hash);
    }catch{return res.status(422).json({error:"Unable to read the approval block."});}
  }
  const result=await verifyResolutionCase(data,reader);
  res.json({...result,codeHash:data.codeHash});
}
