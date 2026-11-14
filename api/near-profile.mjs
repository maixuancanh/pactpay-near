import {createHash, createHmac, randomBytes, timingSafeEqual} from "node:crypto";
import {createRemoteJWKSet, jwtVerify} from "jose";
import {providers, utils} from "near-api-js";
import {hasStorage, storage} from "../lib/near-evidence.mjs";

const issuer = "https://pactpay.us.auth0.com/";
const clientId = "2mxCN1epr2VDuLUv9Pff7b3faVbVd5E6";
const jwks = createRemoteJWKSet(new URL(".well-known/jwks.json", issuer));
const rpc = new providers.JsonRpcProvider({url:"https://test.rpc.fastnear.com"});
const recipient = "pactpay-near-testnet-web.vercel.app";
const hash = value => createHash("sha256").update(value).digest("hex");
const accountPattern = /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

function textField(value) {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function challengeMac(secret, profile, account, nonce, expires) {
  return createHmac("sha256", secret).update(JSON.stringify([profile, account, nonce, expires])).digest("hex");
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({error:"POST required."});
  const secret = process.env.PACTPAY_SESSION_SECRET;
  if (!hasStorage(process.env) || secret?.length < 32 || !secret) {
    return res.status(503).json({error:"Profile storage is unavailable."});
  }
  let profile;
  try {
    const token = req.headers.authorization?.match(/^Bearer (\S{1,8192})$/)?.[1];
    if (!token) throw new Error();
    const {payload} = await jwtVerify(token, jwks, {
      issuer, audience:clientId, algorithms:["RS256"], requiredClaims:["sub","iat","exp"],
    });
    if (typeof payload.sub !== "string" || !payload.sub) throw new Error();
    profile = hash(issuer + payload.sub);
  } catch {
    return res.status(401).json({error:"Sign in again to manage linked wallets."});
  }

  const data = req.body;
  const store = storage(process.env);
  const path = "keys/social/" + profile;
  try {
    if (data?.action === "list") {
      const items = await store.list(path + "/");
      return res.json({wallets:items.map(key => key.slice(path.length + 1)).filter(key => accountPattern.test(key))});
    }
    const {account} = data ?? {};
    if (typeof account !== "string" || !accountPattern.test(account)) return res.status(400).json({error:"Invalid NEAR account."});
    const message = `Link ${account} to your PactPay profile on NEAR Testnet.`;
    if (data.action === "challenge") {
      const nonce = randomBytes(32).toString("hex");
      const expires = Date.now() + 180000;
      return res.json({nonce, expires, proof:challengeMac(secret, profile, account, nonce, expires), message, recipient});
    }
    if (data.action !== "link") return res.status(400).json({error:"Unknown profile action."});
    const {nonce, expires, proof, publicKey, signature} = data;
    if (typeof nonce !== "string" || !/^[a-f0-9]{64}$/.test(nonce) ||
        typeof proof !== "string" || !/^[a-f0-9]{64}$/.test(proof) ||
        !Number.isSafeInteger(expires) || expires <= Date.now() ||
        !timingSafeEqual(Buffer.from(proof,"hex"),Buffer.from(challengeMac(secret,profile,account,nonce,expires),"hex"))) {
      return res.status(400).json({error:"Request a new wallet verification."});
    }
    if (typeof publicKey !== "string" || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(publicKey) ||
        typeof signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) {
      return res.status(400).json({error:"Invalid wallet signature."});
    }
    const key = utils.PublicKey.fromString(publicKey);
    const tag = Buffer.alloc(4);
    tag.writeUInt32LE(2 ** 31 + 413);
    const digest = createHash("sha256").update(Buffer.concat([
      tag, textField(message), Buffer.from(nonce,"hex"), textField(recipient), Buffer.from([0]),
    ])).digest();
    if (!key.verify(digest,Buffer.from(signature,"base64"))) return res.status(400).json({error:"Invalid wallet signature."});
    const access = await rpc.query({request_type:"view_access_key",finality:"final",account_id:account,public_key:publicKey});
    if (access.permission !== "FullAccess") return res.status(400).json({error:"Sign with a full-access wallet key."});
    await store.put(path + "/" + account, {linkedAt:new Date().toISOString()});
    return res.json({account});
  } catch {
    return res.status(400).json({error:"Unable to verify or save this wallet."});
  }
}
