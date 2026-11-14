const originAsset="nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const destinationAsset="nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

export default async function handler(req,res){
  res.setHeader("Cache-Control","no-store");
  if(req.method!=="POST")return res.status(405).json({error:"POST required."});
  const {refundTo,recipient,amount}=req.body??{};
  if(typeof refundTo!=="string"||!/^0x[0-9a-f]{40}$/i.test(refundTo)||
     typeof recipient!=="string"||!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(recipient)||
     recipient.length<2||recipient.length>64||recipient.endsWith(".testnet")||
     typeof amount!=="string"||!/^\d{1,3}(?:\.\d{1,6})?$/.test(amount))
    return res.status(400).json({error:"Enter a Base refund address, a NEAR mainnet recipient and a USDC amount."});
  const [whole,fraction=""]=amount.split(".");
  const units=BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,"0"));
  if(units<1000000n||units>100000000n)return res.status(400).json({error:"Quote amount must be 1–100 USDC."});
  try{
    const r=await fetch("https://1click.chaindefuser.com/v0/quote",{
      method:"POST",headers:{"Content-Type":"application/json"},signal:AbortSignal.timeout(10000),
      body:JSON.stringify({dry:true,swapType:"EXACT_OUTPUT",slippageTolerance:100,originAsset,destinationAsset,
        depositType:"ORIGIN_CHAIN",recipientType:"DESTINATION_CHAIN",refundType:"ORIGIN_CHAIN",
        refundTo,recipient,amount:units.toString(),deadline:new Date(Date.now()+300000).toISOString()}),
    });
    if(!r.ok)return res.status(502).json({error:"1Click could not quote this route.",upstreamStatus:r.status});
    const {quote,quoteRequest,correlationId}=await r.json();
    if(quoteRequest?.dry!==true||quoteRequest.recipient!==recipient||quote?.amountOut!==units.toString())
      return res.status(502).json({error:"Quote did not match the requested route."});
    return res.json({mode:"mainnet-dry",source:"USDC on Base",destination:"USDC on NEAR",recipient,
      amountIn:quote.amountInFormatted,amountOut:quote.amountOutFormatted,timeEstimate:quote.timeEstimate,correlationId});
  }catch{return res.status(502).json({error:"1Click quote service unavailable."});}
}
