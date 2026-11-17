import {hasStorage,storage} from "../lib/near-evidence.mjs";
import {makeCaseIndexHandler} from "../lib/near-case-index.mjs";
import {caseReader} from "../lib/near-case-rpc.mjs";

const requests = new Map();
let windowStarted = 0;
let total = 0;
function admit(req) {
  const now = Date.now();
  if (now-windowStarted >= 60_000) {
    windowStarted = now;
    total = 0;
    requests.clear();
  }
  const forwarded = req.headers["x-vercel-forwarded-for"];
  const ip = typeof forwarded === "string" && forwarded.length <= 64 ? forwarded : req.socket?.remoteAddress ?? "unknown";
  const used = requests.get(ip) ?? 0;
  if (used >= 12 || total >= 80) return false;
  total++;
  requests.set(ip,used+1);
  return true;
}

export default async function handler(req,res) {
  const env = process.env;
  if (!env.PACTPAY_NEAR_ESCROW_V2 || !hasStorage(env)) {
    res.setHeader("Cache-Control","no-store");
    return res.status(503).json({error:"Receipt history storage is unavailable."});
  }
  const reader = caseReader(AbortSignal.timeout(12000));
  return makeCaseIndexHandler({reader,store:storage(env),escrow:env.PACTPAY_NEAR_ESCROW_V2,admit})(req,res);
}
