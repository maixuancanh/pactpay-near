import {createHash} from "node:crypto";
import {createRemoteJWKSet,jwtVerify} from "jose";
import {Account,KeyPairSigner,providers} from "near-api-js";
import {actionCreators,createTransaction,encodeTransaction,Transaction,SignedTransaction,Signature} from "@near-js/transactions";
import {PublicKey} from "@near-js/crypto";
import {hasStorage,storage} from "../lib/near-evidence.mjs";

import {bookingAction,bookingEscrow} from "../lib/near-mpc-booking.mjs";

import {activationDeposit,bookingShortfall} from "../lib/near-mpc-funding.mjs";

const origin = "https://pactpay-near-testnet-web.vercel.app";
const issuer = "https://pactpay.us.auth0.com/";
const clientId = "2mxCN1epr2VDuLUv9Pff7b3faVbVd5E6";
const audience = "auth0.pactpay-530c506b.testnet";
const contract = "auth.pactpay-530c506b.testnet";
const guard = "jwt#" + issuer;
const jwks = createRemoteJWKSet(new URL(".well-known/jwks.json",issuer));
const rpc = new providers.JsonRpcProvider({url:"https://test.rpc.fastnear.com"});

function relayerConfig() {
  const env=process.env;
  if (env.PACTPAY_RELAYER_ACCOUNT!=="relay.pactpay-530c506b.testnet" || !env.PACTPAY_RELAYER_KEY || !hasStorage(env)) return null;
  return {
    store:storage(env),
    relayer:new Account(env.PACTPAY_RELAYER_ACCOUNT,rpc,KeyPairSigner.fromSecretKey(env.PACTPAY_RELAYER_KEY)),
  };
}

async function reserveDay(store, prefix, count) {
  const day=new Date().toISOString().slice(0,10);
  for (let slot=0;slot<count;slot++) {
    if (await store.put(prefix+"/"+day+"/"+slot,{day})) return true;
  }
  return false;
}

function accessKey(account,key) {
  return rpc.query({request_type:"view_access_key",finality:"final",account_id:account,public_key:key.toString()}).catch(error=>{
    if (/UNKNOWN_ACCOUNT|UNKNOWN_ACCESS_KEY|does not exist|doesn't exist/i.test(String(error.type)+" "+error.message)) return null;
    throw error;
  });
}

async function accountState(account) {
  try {
    return await rpc.query({request_type:"view_account",finality:"final",account_id:account});
  } catch (error) {
    if (/UNKNOWN_ACCOUNT|does not exist|doesn't exist/i.test(String(error.type)+" "+error.message)) return null;
    throw error;
  }
}

async function canFund(relayer, amount) {
  const state=await accountState(relayer.accountId);
  return state && BigInt(state.amount) >= amount + 100_000_000_000_000_000_000_000n;
}

async function fund(relayer, account, amount) {
  const outcome=await relayer.signAndSendTransaction({
    receiverId:account,actions:[actionCreators.transfer(amount)],waitUntil:"FINAL",throwOnFailure:false,
  });
  if (outcome.final_execution_status!=="FINAL" || typeof outcome.status?.SuccessValue!=="string") throw Error();
  return outcome.transaction.hash;
}

export default async function handler(req,res) {
  res.setHeader("Cache-Control","no-store");
  if (req.method !== "POST" || req.headers.origin !== origin) return res.status(403).json({error:"Use the PactPay test page."});
  const {action,token} = req.body ?? {};
  if (!["prepare","activate","submit","create"].includes(action) || typeof token !== "string" || token.length > 9000) {
    return res.status(400).json({error:"Invalid test request.",broadcastUncertain:false});
  }
  const profileRequest = action==="prepare" || action==="activate";
  let stage = "Auth0 token verification";
  let signingHash;
  try {
    const {payload} = await jwtVerify(token,jwks,{
      issuer,audience:profileRequest?clientId:audience,algorithms:["RS256"],requiredClaims:["sub","exp"],
    });
    if (typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 256 || payload.sub.includes("#")) throw Error();
    if (!profileRequest && (payload.azp !== clientId || !String(payload.scope).split(" ").includes("transaction:sign"))) throw Error();
    stage = "MPC account derivation";
    const derived = await rpc.callFunction("v1.signer-prod.testnet","derived_public_key",{
      path:guard+"#"+payload.sub,predecessor:contract,domain_id:1,
    },{finality:"final"});
    const key = PublicKey.fromString(derived);
    const account = Buffer.from(key.ed25519Key.data).toString("hex");
    stage = "Testnet access key lookup";
    let access = await accessKey(account,key);
    if (action==="activate" && !access) {
      stage="MPC account activation";
      const config=relayerConfig();
      if (!config) return res.status(503).json({error:"Testnet sponsorship is unavailable."});
      if (await accountState(account)) return res.status(409).json({error:"This address exists without its expected MPC key."});
      if (!await canFund(config.relayer,activationDeposit)) return res.status(503).json({error:"The Testnet sponsorship balance is low."});
      if (!await reserveDay(config.store,"used/auth-mpc/activation",10) ||
          !await config.store.put("used/auth-mpc/activated/"+account,{account})) {
        return res.status(429).json({error:"Activation limit reached or activation already started. Refresh to check the account."});
      }
      await fund(config.relayer,account,activationDeposit);
      access=await accessKey(account,key);
    }
    if (!access || access.error || access.permission !== "FullAccess") {
      return res.status(action==="prepare"?200:409).json({account,funded:false,error:action!=="prepare"?"The MPC access key is not ready.":undefined,broadcastUncertain:false});
    }
    if (profileRequest) return res.json({account,publicKey:key.toString(),funded:true,nonce:String(access.nonce),blockHash:access.block_hash});
    stage = "transaction validation";
    const booking = action==="create";
    const bytes = payload.fatxn;
    if (!Array.isArray(bytes) || (booking ? bytes.length > 740 : bytes.length !== 230) || bytes.some(b=>!Number.isInteger(b)||b<0||b>255)) throw Error();
    const tx = Transaction.decode(Uint8Array.from(bytes));
    let approvedAction = actionCreators.transfer(0n);
    if (booking) {
      if (tx.receiverId !== bookingEscrow || tx.actions.length !== 1 ||
          tx.actions[0].functionCall?.methodName !== "create_booking") throw Error();
      const args=JSON.parse(Buffer.from(tx.actions[0].functionCall.args).toString("utf8"));
      approvedAction=await bookingAction(args,account,positions=>
        rpc.callFunction(bookingEscrow,"booking_storage_deposit",{positions},{finality:"final"}));
    }
    const expected = createTransaction(account,key,booking?bookingEscrow:account,BigInt(access.nonce)+1n,
      [approvedAction],tx.blockHash);
    if (!Buffer.from(encodeTransaction(expected)).equals(Buffer.from(bytes))) {
      return res.status(409).json({error:"Transaction differs from the allowed action or its nonce changed.",broadcastUncertain:false});
    }
    stage = "test quota reservation";
    const config=relayerConfig();
    if (!config) return res.status(503).json({error:"Testnet relayer unavailable.",broadcastUncertain:false});
    const {store,relayer}=config;
    const day=new Date().toISOString().slice(0,10);
    const digest=createHash("sha256").update(Buffer.from(bytes)).digest();
    if (!await store.put("used/auth-mpc/"+digest.toString("hex"),{day})) return res.status(409).json({error:"Transaction already submitted. Check its final outcome.",broadcastUncertain:true});
    if (!await reserveDay(store,booking?"used/auth-mpc/create":"used/auth-mpc",booking?10:3)) {
      return res.status(429).json({error:"Daily Testnet MPC signing limit reached.",broadcastUncertain:false});
    }
    stage="FastAuth signing receipt";
    const signed=await relayer.signAndSendTransaction({
      receiverId:contract,actions:[actionCreators.functionCall("sign",{
        guard_id:guard,verify_payload:token,sign_payload:bytes,algorithm:"eddsa",
      },300000000000000n,1n)],waitUntil:"FINAL",throwOnFailure:false,
    });
    signingHash=signed.transaction.hash;
    if (signed.final_execution_status!=="FINAL" || !signed.status?.SuccessValue) throw Error();
    stage="MPC signature verification";
    const {signature}=JSON.parse(Buffer.from(signed.status.SuccessValue,"base64").toString());
    if (!Array.isArray(signature) || signature.length!==64 || signature.some(b=>!Number.isInteger(b)||b<0||b>255) ||
        !key.verify(digest,Uint8Array.from(signature))) throw Error();
    const userTx=new SignedTransaction({
      transaction:tx,signature:new Signature({keyType:0,data:Uint8Array.from(signature)}),
    });
    let fundingHash;
    if (booking) {
      stage="booking sponsorship";
      const state=await accountState(account);
      if (!state) throw Error();
      let shortfall;
      try {
        shortfall=bookingShortfall(state.amount,state.storage_usage,approvedAction.functionCall.deposit);
      } catch (error) {
        return res.status(409).json({error:error.message,broadcastUncertain:false});
      }
      if (shortfall>0n) {
        if (!await canFund(relayer,shortfall)) {
          return res.status(503).json({error:"The Testnet sponsorship balance is low.",broadcastUncertain:false});
        }
        if (!await store.put("used/auth-mpc/create-credit/"+account,{day})) {
          return res.status(429).json({error:"This MPC account has already used its booking subsidy.",broadcastUncertain:false});
        }
        fundingHash=await fund(relayer,account,shortfall);
      }
    }
    stage="user transaction broadcast";
    const outcome=await rpc.sendTransactionUntil(userTx,"FINAL");
    const userHash=outcome.transaction.hash;
    if (outcome.final_execution_status!=="FINAL" || typeof outcome.status?.SuccessValue!=="string") {
      return res.status(422).json({error:"User transaction did not finalize successfully.",signingHash,userHash});
    }
    return res.json({account,signingHash,userHash,fundingHash});
  } catch {
    return res.status(422).json({error:"MPC request stopped at "+stage+".",signingHash,broadcastUncertain:stage==="user transaction broadcast"});
  }
}
