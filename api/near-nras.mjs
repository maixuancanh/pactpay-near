export default async function handler(req,res) {
  res.setHeader("Cache-Control","no-store");
  if (req.method!=="POST") return res.status(405).json({error:"POST required"});
  try {
    const body=typeof req.body==="string"?req.body:JSON.stringify(req.body);
    if (!body || body.length>1000000) return res.status(400).json({error:"Invalid GPU evidence"});
    const r=await fetch("https://cloud.near.ai/api/proxy/nras/v3/attest/gpu",{
      method:"POST",headers:{"content-type":"application/json"},body,signal:AbortSignal.timeout(18000),redirect:"error",
    });
    const raw=await r.text();
    if(r.ok) {
      const token=JSON.parse(raw)?.[0]?.[1];
      if(typeof token==="string") {
        const claims=JSON.parse(Buffer.from(token.split(".")[1],"base64url"));
        const delay=Math.max(claims.iat,claims.nbf)*1000-Date.now();
        // Unverified timestamps only delay delivery. The SDK checks all claims and the signature.
        if(Number.isFinite(delay) && delay<=10000) await new Promise(resolve=>setTimeout(resolve,Math.max(5000,delay+3500)));
      }
    }
    res.setHeader("Content-Type","application/json");
    return res.status(r.status).send(raw);
  } catch {
    return res.status(502).json({error:"GPU evidence unavailable"});
  }
}
