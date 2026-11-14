import {Account, KeyPairSigner, providers, transactions} from "near-api-js";
import {hasStorage, storage, unpack} from "../lib/near-evidence.mjs";

const chain = new providers.JsonRpcProvider({url:"https://test.rpc.fastnear.com"});
const demoToken = "token.pactpay-530c506b.testnet";
const distributor = "relay.pactpay-530c506b.testnet";
const maxGrant = 20n;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({error:"POST required."});
  const env = process.env;
  const escrow = env.PACTPAY_NEAR_ESCROW_V2?.trim();
  if (!escrow?.endsWith(".testnet") || env.PACTPAY_RELAYER_ACCOUNT?.trim() !== distributor ||
      !env.PACTPAY_RELAYER_KEY || !env.PACTPAY_SESSION_SECRET || !hasStorage(env)) {
    return res.status(503).json({error:"Demo token distribution is unavailable."});
  }
  const {id,index} = req.body ?? {};
  if (!Number.isSafeInteger(id) || id < 0 || !Number.isInteger(index) || index < 0 || index > 31) {
    return res.status(400).json({error:"Invalid booking share."});
  }
  let account;
  try {
    const session = unpack(req.headers.authorization?.replace(/^Bearer /,""),env.PACTPAY_SESSION_SECRET,"session");
    if (session.binding?.network !== "testnet" || session.binding?.escrow !== escrow ||
        !session.account.endsWith(".testnet")) throw new Error();
    account = session.account;
  } catch {
    return res.status(401).json({error:"Verify your Testnet wallet first."});
  }
  try {
    const [booking, block, token, balance, registered] = await Promise.all([
      chain.callFunction(escrow,"get_booking",{id}),
      chain.block({finality:"final"}),
      chain.callFunction(escrow,"get_token",{}),
      chain.callFunction(demoToken,"ft_balance_of",{account_id:account}),
      chain.callFunction(demoToken,"storage_balance_of",{account_id:account}),
    ]);
    const share = booking?.positions?.[index];
    if (token !== demoToken || share?.buyer !== account || !share.accepted || share.funded ||
        BigInt(booking.fund_until) <= BigInt(block.header.timestamp_nanosec)/1000000000n) {
      return res.status(409).json({error:"Accept the terms of an open, unfunded booking share first."});
    }
    const amount = BigInt(share.share) - BigInt(balance);
    if (amount <= 0n) return res.json({amount:"0"});
    if (amount > maxGrant) return res.status(409).json({error:"The demo dispenser tops up at most 20 PDEMO per wallet."});
    const store = storage(env);
    if (!await store.put("used/demo-tokens/"+account,{id,index,amount:String(amount),at:Date.now()})) {
      return res.status(409).json({error:"This wallet already requested demo tokens. Check your balance before continuing."});
    }
    const actions = [];
    if (!registered) actions.push(transactions.functionCall("storage_deposit",
      {account_id:account,registration_only:true},15_000_000_000_000n,1_250_000_000_000_000_000_000n));
    actions.push(transactions.functionCall("ft_transfer",
      {receiver_id:account,amount:String(amount)},25_000_000_000_000n,1n));
    const signer = new Account(distributor,chain,KeyPairSigner.fromSecretKey(env.PACTPAY_RELAYER_KEY.trim()));
    const outcome = await signer.signAndSendTransaction({receiverId:demoToken,actions,waitUntil:"FINAL"});
    if (typeof outcome.status?.SuccessValue !== "string") throw new Error("Token transfer failed");
    return res.json({amount:String(amount),hash:outcome.transaction.hash});
  } catch {
    return res.status(502).json({error:"Unable to confirm the demo transfer. Check your balance before requesting help."});
  }
}
