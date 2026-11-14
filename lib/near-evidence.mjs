import {createHash, createHmac, randomBytes, timingSafeEqual} from "node:crypto";
import {AwsClient} from "aws4fetch";
import {providers, utils} from "near-api-js";
import {evidenceV2} from "./near-evidence-v2.mjs";

const rpc = new providers.JsonRpcProvider({url:"https://test.rpc.fastnear.com"});
const accountPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const isAccount = value => typeof value === "string" && value.length >= 2 && value.length <= 64 && accountPattern.test(value);
const message = "Sign in to PactPay NEAR private evidence";
const recipient = "pactpay-near-testnet-web.vercel.app";

function textField(value) {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
}

export function nep413Digest(nonce, challengeMessage = message, challengeRecipient = recipient) {
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(2 ** 31 + 413);
  return createHash("sha256").update(Buffer.concat([
    tag, textField(challengeMessage), Buffer.from(nonce, "hex"), textField(challengeRecipient), Buffer.from([0]),
  ])).digest();
}

function signed(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return encoded + "." + createHmac("sha256", secret).update(encoded).digest("base64url");
}

export function unpack(token, secret, kind) {
  if (typeof token !== "string" || token.length > 1024) throw new Error("Sign in again.");
  const [encoded, mac, extra] = token.split(".");
  const expected = createHmac("sha256", secret).update(encoded).digest();
  const actual = Buffer.from(mac || "", "base64url");
  if (extra !== undefined || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Invalid session.");
  const data = JSON.parse(Buffer.from(encoded, "base64url"));
  if (data.kind !== kind || data.until <= Date.now() || !isAccount(data.account)) throw new Error("Sign in again.");
  return data;
}

export function hasStorage(config) {
  if (config.PACTPAY_STORAGE_URL && config.PACTPAY_STORAGE_SECRET?.length >= 32) {
    try { return new URL(config.PACTPAY_STORAGE_URL).protocol === "https:"; }
    catch { return false; }
  }
  return Boolean(config.R2_ACCESS_KEY_ID && config.R2_SECRET_ACCESS_KEY &&
    /^[a-f0-9]{32}$/.test(config.R2_ACCOUNT_ID || "") && /^[a-z0-9-]+$/.test(config.R2_BUCKET || ""));
}

function workerStorage(config) {
  async function call(op,key,method="GET",value) {
    const url = new URL(config.PACTPAY_STORAGE_URL);
    url.search = new URLSearchParams({op,key}).toString();
    return fetch(url,{method,headers:{authorization:"Bearer "+config.PACTPAY_STORAGE_SECRET},
      body:value===undefined ? undefined : JSON.stringify(value),signal:AbortSignal.timeout(15000)});
  }
  return {
    async get(key) {
      const r=await call("get",key);
      if(r.status===404) return null;
      if(!r.ok) throw new Error("Private storage unavailable.");
      return r.json();
    },
    async list(key) {
      const r=await call("list",key);
      if(!r.ok) throw new Error("Private storage unavailable.");
      return r.json();
    },
    async put(key,value) {
      const r=await call("put",key,"PUT",value);
      if(r.status===412) return false;
      if(r.status!==201) throw new Error("Private storage unavailable.");
      return true;
    }
  };
}

export function storage(config) {
  if (config.PACTPAY_STORAGE_URL) return workerStorage(config);
  const client = new AwsClient({accessKeyId:config.R2_ACCESS_KEY_ID, secretAccessKey:config.R2_SECRET_ACCESS_KEY, service:"s3", region:"auto"});
  const base = "https://" + config.R2_ACCOUNT_ID + ".r2.cloudflarestorage.com/" + config.R2_BUCKET + "/";
  const request = (path, options) => client.fetch(base + path, {...options, signal:AbortSignal.timeout(15000)});
  return {
    async get(path) {
      const response = await request(path);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("Private storage unavailable.");
      return response.json();
    },
    async put(path, body) {
      const response = await request(path, {method:"PUT", headers:{"content-type":"application/json","if-none-match":"*"},body:JSON.stringify(body)});
      if (response.status === 412) return false;
      if (!response.ok) throw new Error("Private storage unavailable.");
      return true;
    },
    async list(prefix) {
      const keys = [];
      let cursor;
      const params = new URLSearchParams({"list-type":"2","max-keys":"100",prefix});
      do {
        if (cursor) params.set("continuation-token",cursor);
        const response = await request("?" + params.toString());
        if (!response.ok) throw new Error("Private storage unavailable.");
        const xml = await response.text();
        keys.push(...[...xml.matchAll(/<Key>([a-zA-Z0-9/._-]+)<\/Key>/g)].map(match=>match[1]));
        if (!prefix.startsWith("evidence-v2/") || !xml.includes("<IsTruncated>true</IsTruncated>")) break;
        const next = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1]?.replace(/&amp;/g,"&");
        if (!next || next === cursor) throw new Error("Private storage unavailable.");
        cursor = next;
      } while (cursor);
      return keys;
    },
  };
}

function validJwk(key) {
  return key?.kty === "RSA" && key.e === "AQAB" && typeof key.n === "string" &&
    /^[A-Za-z0-9_-]{342}$/.test(key.n) && !("d" in key);
}
function base64(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

export function makeHandler({store, chain = rpc, secret, escrow, escrowV2, evidenceRecipient = recipient}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control","no-store");
    if (req.method !== "POST") return res.status(405).json({error:"POST required."});
    const data = req.body;
    if (!data || typeof data !== "object" || JSON.stringify(data).length > 900000) return res.status(400).json({error:"Invalid request size."});
    try {
      const v2 = escrowV2 && data.escrow === escrowV2;
      if (data.escrow !== undefined && data.escrow !== escrow && !v2) throw new Error("Unknown escrow.");
      const binding = v2 ? {network:"testnet",escrow:escrowV2,recipient:evidenceRecipient} : undefined;
      const matchesBinding = token => v2
        ? token.binding?.network === binding.network && token.binding?.escrow === binding.escrow &&
          token.binding?.recipient === binding.recipient
        : token.binding === undefined;
      const challengeMessage = v2 ? message + " for testnet escrow " + escrowV2 : message;
      const challengeRecipient = v2 ? evidenceRecipient : recipient;
      const keyPrefix = v2 ? "evidence-v2/testnet/"+escrowV2+"/keys/" : "keys/";
      if (data.action === "challenge") {
        if (!isAccount(data.account)) throw new Error("Invalid account.");
        const nonce = randomBytes(32).toString("hex");
        const token = signed({kind:"challenge",account:data.account,nonce,binding,until:Date.now()+180000},secret);
        return res.json({token,nonce,message:challengeMessage,recipient:challengeRecipient});
      }
      if (data.action === "login") {
        const c = unpack(data.token,secret,"challenge");
        if (!matchesBinding(c) || data.accountId !== c.account || typeof data.publicKey !== "string" || !base64(data.signature, 128)) throw new Error("Invalid wallet signature.");
        const key = utils.PublicKey.fromString(data.publicKey);
        if (!key.verify(nep413Digest(c.nonce,challengeMessage,challengeRecipient),Buffer.from(data.signature,"base64"))) throw new Error("Invalid wallet signature.");
        const access = await chain.query({request_type:"view_access_key",finality:"final",account_id:c.account,public_key:data.publicKey});
        if (access.permission !== "FullAccess") throw new Error("A full-access wallet key is required for sign-in.");
        if (!await store.put("used/"+c.nonce,{until:c.until})) throw new Error("Challenge already used.");
        return res.json({session:signed({kind:"session",account:c.account,binding,until:Date.now()+900000},secret)});
      }
      const session = unpack(req.headers.authorization?.replace(/^Bearer /,""),secret,"session");
      if (!matchesBinding(session)) throw new Error("Sign in for this escrow.");
      const {account} = session;
      if (data.action === "register") {
        if (!validJwk(data.key) || !base64(data.backup,16000) || !base64(data.iv,24)) throw new Error("Invalid evidence key.");
        const existing = await store.get(keyPrefix+account);
        if (existing) throw new Error("A key already exists. Restore it with your recovery code.");
        if (!await store.put(keyPrefix+account,{key:{kty:"RSA",n:data.key.n,e:data.key.e},backup:data.backup,iv:data.iv})) throw new Error("A key already exists.");
        return res.json({ok:true});
      }
      if (data.action === "restore") return res.json({profile:await store.get(keyPrefix+account)});
      if (v2) {
        const id = typeof data.booking === "number" && Number.isSafeInteger(data.booking) ? String(data.booking) : data.booking;
        if (typeof id !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(id) || !Number.isSafeInteger(Number(id)) ||
            !Number.isInteger(data.position) || data.position < 0 || data.position > 31) throw new Error("Invalid booking position.");
        const booking = await chain.callFunction(escrowV2,"get_booking",{id:Number(id)},{finality:"final"});
        const position = booking?.positions?.[data.position];
        if (!position || !isAccount(booking.merchant) || !isAccount(position.buyer) || ![booking.merchant,position.buyer].includes(account)) {
          return res.status(403).json({error:"This evidence belongs to the buyer and merchant."});
        }
        const other = account === booking.merchant ? position.buyer : booking.merchant;
        if (data.action === "peer") {
          const peer = await store.get(keyPrefix+other);
          return res.json({account:other,key:peer?.key ?? null});
        }
        const scope = {network:"testnet",escrow:escrowV2,booking:id,position:data.position};
        if (data.action === "ai_ticket") {
          if (!process.env.NEARAI_API_KEY || !position.dispute_until) {
            return res.status(503).json({error:"Verified NEAR AI is not configured for this case."});
          }
          const day = new Date().toISOString().slice(0,10);
          const prefix = ["evidence-v2","testnet",escrowV2,id,data.position,account,"ai-quota",day].join("/");
          let reserved = false;
          for (let slot=0;slot<3 && !reserved;slot++) reserved = await store.put(prefix+"/"+slot,{day});
          if (!reserved) return res.status(429).json({error:"This case has used its daily AI requests."});
          return res.json({ticket:signed({kind:"ai",account,case:scope,nonce:randomBytes(32).toString("hex"),
            until:Date.now()+180000},secret)});
        }
        return await evidenceV2({data,res,store,scope,account,other});
      }
      if (!Number.isSafeInteger(data.booking) || data.booking < 0 || !Number.isInteger(data.position) || data.position < 0 || data.position > 31) throw new Error("Invalid booking position.");
      const booking = await chain.callFunction(escrow,"get_booking",{id:data.booking},{finality:"final"});
      const position = booking?.positions?.[data.position];
      if (!position || !isAccount(booking.merchant) || !isAccount(position.buyer) || ![booking.merchant,position.buyer].includes(account)) return res.status(403).json({error:"This evidence belongs to the buyer and merchant."});
      const other = account === booking.merchant ? position.buyer : booking.merchant;
      const prefix = "evidence/"+data.booking+"/"+data.position+"/";
      if (data.action === "peer") {
        const peer = await store.get("keys/"+other);
        return res.json({account:other,key:peer?.key ?? null});
      }
      if (data.action === "remedy_list") {
        const root = prefix + "remedies/";
        const keys = await store.list(root);
        const offers = await Promise.all(keys.filter(k => /^[a-f0-9]{32}$/.test(k.slice(root.length))).map(async path => {
          const id = path.slice(root.length);
          const [offer, acceptance, completion] = await Promise.all([
            store.get(path), store.get(path+"/accept"), store.get(path+"/complete"),
          ]);
          return {id,offer,acceptance,completion};
        }));
        return res.json({offers});
      }
      if (["remedy_propose","remedy_accept","remedy_complete"].includes(data.action)) {
        if (!position.dispute_until || position.allocation) throw new Error("This dispute is closed.");
        const block = await chain.block({finality:"final"});
        const now = Number(BigInt(block.header.timestamp_nanosec)/1000000000n);
        const limit = Number(position.dispute_until);
        if(now >= limit) throw new Error("The dispute deadline has passed.");
        const root = prefix + "remedies/";
        if(data.action === "remedy_propose") {
          if(!Number.isSafeInteger(data.due) || data.due<=now || data.due>limit ||
             !/^[a-f0-9]{64}$/.test(data.evidenceId) || !await store.get(prefix+data.evidenceId))
            throw new Error("Choose a shared evidence item and a deadline within the dispute window.");
          const id=randomBytes(16).toString("hex");
          if(!await store.put(root+id,{by:account,due:data.due,evidenceId:data.evidenceId,at:now}))
            throw new Error("Could not save remedy.");
          return res.json({id});
        }
        if(!/^[a-f0-9]{32}$/.test(data.id)) throw new Error("Invalid remedy.");
        const path=root+data.id;
        const offer=await store.get(path);
        if(!offer || offer.due<=now) throw new Error("Remedy expired.");
        if(data.action==="remedy_accept") {
          if(offer.by===account) throw new Error("The other party must accept.");
          if(!await store.put(path+"/accept",{by:account,at:now})) throw new Error("Remedy already accepted.");
        } else {
          if(position.buyer!==account || !await store.get(path+"/accept")) throw new Error("Only the buyer can confirm an accepted remedy.");
          if(!await store.put(path+"/complete",{by:account,at:now})) throw new Error("Remedy already completed.");
        }
        return res.json({ok:true});
      }
      if (data.action === "ai_ticket") {
        if (!process.env.NEARAI_API_KEY || !position.dispute_until) return res.status(503).json({error:"Verified NEAR AI is not configured for this case."});
        const day = new Date().toISOString().slice(0,10);
        let reserved = false;
        for (let slot=0; slot<3 && !reserved; slot++) {
          reserved = await store.put("ai-quota/"+day+"/"+data.booking+"/"+data.position+"/"+account+"/"+slot,{day});
        }
        if (!reserved) return res.status(429).json({error:"This case has used its daily AI requests."});
        return res.json({ticket:signed({kind:"ai",account,nonce:randomBytes(32).toString("hex"),until:Date.now()+180000},secret)});
      }
      if (data.action === "list") {
        const keys = await store.list(prefix);
        return res.json({items:keys.map(path=>path.slice(prefix.length)).filter(id=>/^[a-f0-9]{64}$/.test(id))});
      }
      if (data.action === "read") {
        if (!/^[a-f0-9]{64}$/.test(data.id)) throw new Error("Invalid evidence ID.");
        const item = await store.get(prefix+data.id);
        return res.json({item:item && {ciphertext:item.ciphertext,iv:item.iv,wrapped:item.keys[account]}});
      }
      if (data.action === "upload") {
        if (!position.dispute_until || position.allocation || Number(position.dispute_until) <= Date.now()/1000) throw new Error("This dispute does not accept new evidence.");
        if (!base64(data.ciphertext, 800000) || !base64(data.iv,24) ||
            !base64(data.keys?.[account],350) || !base64(data.keys?.[other],350)) throw new Error("Invalid encrypted evidence.");
        const bytes = Buffer.from(data.ciphertext,"base64");
        const iv = Buffer.from(data.iv,"base64");
        if (iv.length !== 12 || bytes.length < 17 || [account,other].some(id=>Buffer.from(data.keys[id],"base64").length!==256)) throw new Error("Invalid evidence envelope.");
        const id = createHash("sha256").update(iv).update(bytes).digest("hex");
        await store.put(prefix+id,{ciphertext:data.ciphertext,iv:data.iv,keys:{[account]:data.keys[account],[other]:data.keys[other]}});
        return res.json({id});
      }
      return res.status(400).json({error:"Unknown action."});
    } catch (error) {
      return res.status(400).json({error: error instanceof Error && /^[A-Za-z][A-Za-z .-]{1,110}$/.test(error.message) ? error.message : "Unable to complete the private evidence request."});
    }
  };
}

export default async function handler(req,res) {
  const env = process.env;
  const escrowV2 = env.PACTPAY_NEAR_ESCROW_V2;
  const requestedV2 = Boolean(escrowV2 && req.body?.escrow === escrowV2);
  if (!hasStorage(env) || !env.PACTPAY_SESSION_SECRET || env.PACTPAY_SESSION_SECRET.length < 32 ||
      !(requestedV2 ? isAccount(escrowV2) && escrowV2.endsWith(".testnet") && escrowV2 !== env.PACTPAY_NEAR_ESCROW
          : env.PACTPAY_NEAR_ESCROW?.endsWith(".testnet"))) return res.status(503).json({error:"Private evidence storage is not configured."});
  return makeHandler({store:storage(env),secret:env.PACTPAY_SESSION_SECRET,escrow:env.PACTPAY_NEAR_ESCROW,
    escrowV2,evidenceRecipient:env.PACTPAY_EVIDENCE_RECIPIENT || recipient})(req,res);
}
