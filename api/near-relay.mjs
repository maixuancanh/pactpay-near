import {createHash} from "node:crypto";
import {deserialize} from "borsh";
import {actionCreators} from "@near-js/transactions";
import {Account, KeyPairSigner, providers, transactions, utils} from "near-api-js";
import {hasStorage, storage} from "../lib/near-evidence.mjs";

const chain = new providers.JsonRpcProvider({url:"https://test.rpc.fastnear.com"});
const gasLimit = 20_000_000_000_000n;
const testnetAccount = /^[a-z0-9]+(?:[._-][a-z0-9]+)*\.testnet$/;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const env = process.env;
  const enabled = Boolean(testnetAccount.test(env.PACTPAY_RELAYER_ACCOUNT ?? "") &&
    testnetAccount.test(env.PACTPAY_NEAR_ESCROW ?? "") && env.PACTPAY_RELAYER_KEY && hasStorage(env));
  if (req.method === "GET") return res.json({enabled});
  if (req.method !== "POST") return res.status(405).json({error:"POST required."});
  if (!enabled) return res.status(503).json({error:"Fee sponsorship is unavailable."});
  try {
    const encoded = req.body?.delegate;
    if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]{1,1024}={0,2}$/.test(encoded)) throw new Error();
    const bytes = Buffer.from(encoded,"base64");
    const signed = deserialize(transactions.SCHEMA.SignedDelegate,bytes);
    if (!Buffer.from(transactions.encodeSignedDelegate(signed)).equals(bytes)) throw new Error();
    const {delegateAction:action, signature} = signed;
    const call = action.actions[0]?.functionCall;
    if (!testnetAccount.test(action.senderId) || action.receiverId !== env.PACTPAY_NEAR_ESCROW ||
        action.actions.length !== 1 || call?.methodName !== "accept" || call.deposit !== 0n ||
        call.gas <= 0n || call.gas > gasLimit || !action.publicKey.ed25519Key || !signature.ed25519Signature) throw new Error();
    const {id,index,terms_commitment:terms} = JSON.parse(Buffer.from(call.args));
    if (!Number.isSafeInteger(id) || id < 0 || !Number.isInteger(index) || index < 0 || index > 31 ||
        !/^[a-f0-9]{64}$/.test(terms)) throw new Error();
    const key = new utils.PublicKey({keyType:0,data:Uint8Array.from(action.publicKey.ed25519Key.data)});
    const digest = createHash("sha256").update(transactions.encodeDelegateAction(action)).digest();
    if (!key.verify(digest,Uint8Array.from(signature.ed25519Signature.data))) throw new Error();
    const [booking, block, access] = await Promise.all([
      chain.callFunction(action.receiverId,"get_booking",{id},{finality:"final"}),
      chain.block({finality:"final"}),
      chain.query({request_type:"view_access_key",finality:"final",account_id:action.senderId,public_key:key.toString()}),
    ]);
    const height = BigInt(block.header.height);
    if (access.permission !== "FullAccess" || action.nonce <= BigInt(access.nonce) || action.maxBlockHeight <= height ||
        booking?.positions?.[index]?.buyer !== action.senderId || booking.positions[index].accepted ||
        booking.terms_commitment !== terms || BigInt(booking.fund_until) <= BigInt(block.header.timestamp_nanosec)/1000000000n) throw new Error();
    const store = storage(env);
    const day = new Date().toISOString().slice(0,10);
    if (!await store.put(`used/relay/${day}/${action.senderId}`,{day})) {
      return res.status(429).json({error:"This wallet has used its sponsored attempt today."});
    }
    let reserved = false;
    for (let slot = 0; slot < 20 && !reserved; slot++) {
      reserved = await store.put(`used/relay/${day}/slots/${slot}`,{day});
    }
    if (!reserved) return res.status(429).json({error:"Daily sponsorship limit reached."});
    const signer = new Account(env.PACTPAY_RELAYER_ACCOUNT,chain,KeyPairSigner.fromSecretKey(env.PACTPAY_RELAYER_KEY));
    const outcome = await signer.signAndSendTransaction({
      receiverId:action.senderId, actions:[actionCreators.signedDelegate(signed)],
      waitUntil:"FINAL",
    });
    return res.json({hash:outcome.transaction.hash,sender:env.PACTPAY_RELAYER_ACCOUNT});
  } catch {
    return res.status(400).json({error:"Unable to sponsor this acceptance. Refresh the booking and check its on-chain status before retrying."});
  }
}
