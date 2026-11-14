import {hasStorage, storage, unpack} from "../lib/near-evidence.mjs";

const MODEL = "z-ai/glm-5.3-flash";
const gateway = "https://cloud-api.near.ai/v1/";
const forwarded = ["x-signing-algo","x-client-pub-key","x-model-pub-key","x-encryption-version",
  "x-encrypt-all-fields","x-no-aliasing","x-request-id"];

export const config = {api:{bodyParser:false}};

async function rawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);
  if (req.body && typeof req.body === "object") return Buffer.from(JSON.stringify(req.body));
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 180000) throw new Error("Request too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req,res) {
  res.setHeader("Cache-Control","no-store");
  const env=process.env;
  if (!env.NEARAI_API_KEY || !env.PACTPAY_SESSION_SECRET || !hasStorage(env))
    return res.status(503).json({error:"NEAR AI is not configured."});
  let phase = "routing";
  try {
    const source = new URL(req.url,"https://pactpay.invalid");
    const path = (typeof req.query?.route === "string" ? req.query.route : source.pathname.replace(/^\/api\/near-ai\//,""));
    const modelPath = path.startsWith("model/") && decodeURIComponent(path.slice(6)) === MODEL;
    const attestation = path === "attestation/report" &&
      (!source.searchParams.get("model") || source.searchParams.get("model") === MODEL);
    const signature = /^signature\/[a-zA-Z0-9._-]{1,150}$/.test(path);
    const completion = path === "chat/completions" && req.method === "POST";
    if (!(completion || (req.method === "GET" && (modelPath || attestation || signature))))
      return res.status(404).json({error:"Unsupported inference path."});
    const publicAttestation = attestation && !source.searchParams.get("model");
    const ticket = publicAttestation ? null : unpack(req.headers.authorization?.replace(/^Bearer /,""),env.PACTPAY_SESSION_SECRET,"ai");
    const target = new URL(modelPath ? "model/"+encodeURIComponent(MODEL) : path,gateway);
    for(const name of ["model","provider","include_tls_fingerprint","signing_algo","signing_address","nonce"]) {
      const value = source.searchParams.get(name);
      if(value) target.searchParams.set(name,value);
    }
    const headers = {"Content-Type":"application/json"};
    if (!publicAttestation) headers.Authorization="Bearer "+env.NEARAI_API_KEY;
    for(const name of forwarded) if(typeof req.headers[name]==="string") headers[name]=req.headers[name];
    let body;
    if (completion) {
      phase = "request body";
      body=await rawBody(req);
      const data=JSON.parse(body.toString("utf8"));
      if (req.headers["x-encryption-version"]!=="3" || req.headers["x-encrypt-all-fields"]!=="true" ||
          !/^[a-f0-9]{64}$/i.test(req.headers["x-client-pub-key"] || "") || data?.model!==MODEL ||
          !Array.isArray(data.messages) || data.messages.length!==2 || data.stream!==false ||
          data.max_tokens!==(ticket.case?.network==="testnet" ? 900 : 600) || data.reasoning_effort!=="low" || Object.keys(data).some(k=>!["model","messages","max_tokens","stream","reasoning_effort"].includes(k)) ||
          data.messages[0]?.role!=="system" || data.messages[1]?.role!=="user" ||
          data.messages.some(m=>Object.keys(m).some(k=>k!=="role" && k!=="content") ||
            typeof m.content!=="string" || !/^[a-f0-9]{144,90000}$/i.test(m.content)))
        return res.status(400).json({error:"Only encrypted PactPay chat is accepted."});
      phase = "ticket consumption";
      if (!await storage(env).put("ai-used/"+ticket.nonce,{until:ticket.until}))
        return res.status(429).json({error:"Inference ticket already used."});

    }
    phase = "upstream connection";
    const response=await fetch(target,{method:req.method,headers,body,redirect:"error",signal:AbortSignal.timeout(45000)});
    for(const name of ["content-type","x-request-id","x-generation-id"]) {
      const value=response.headers.get(name);
      if(value)res.setHeader(name,value);
    }
    return res.status(response.status).send(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.warn("NEAR AI failure",phase,error?.name,error?.cause?.code);
    return res.status(400).json({error:"Verified inference failed at "+phase+"."});
  }
}
