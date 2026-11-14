import {readFile, writeFile} from "node:fs/promises";
import {Account, KeyPair, KeyPairSigner, transactions} from "near-api-js";
import {JsonRpcProvider} from "@near-js/providers";
const {deployContract, functionCall} = transactions;

const root = new URL("../../", import.meta.url);
const dir = new URL(".near-testnet/", root);
const key = JSON.parse(await readFile(new URL("deploy-key.json", dir), "utf8"));
if (!/^pactpay-[0-9a-f]{8}\.testnet$/.test(key.accountId)) throw new Error("Expected an isolated PactPay testnet account");
const provider = new JsonRpcProvider({url: "https://test.rpc.fastnear.com"});
const account = new Account(key.accountId, provider, KeyPairSigner.fromSecretKey(key.secretKey));
const token = "token." + key.accountId;
const escrow = "escrow." + key.accountId;
const one = 10n ** 24n;
const evidence = {network: "testnet", deployer: key.accountId, token, escrow, transactions: {}};
const report = new URL("docs/near/testnet-deployment.json", root);
async function record(name, outcome) {
  const hash = outcome.transaction.hash;
  evidence.transactions[name] = {hash, signer: outcome.transaction.signer_id, receiver: outcome.transaction.receiver_id};
  await writeFile(report, JSON.stringify(evidence, null, 2) + "\n");
  console.log(name, hash);
}
async function state(id) {
  try { return await provider.query({request_type: "view_account", account_id: id, finality: "final"}); }
  catch (err) { if (err.type === "AccountDoesNotExist" || JSON.stringify(err).includes("UNKNOWN_ACCOUNT") || /does not exist|UnknownAccount/.test(String(err))) return null; throw err; }
}
async function setup(id, name, wasm, init) {
  let current = await state(id);
  if (!current) {
    await record(name + "_account", await account.signAndSendTransaction({receiverId: id, waitUntil: "FINAL", throwOnFailure: true, actions: [transactions.createAccount(), transactions.transfer(3n * one), transactions.addKey(KeyPair.fromString(key.secretKey).getPublicKey(), transactions.fullAccessKey())]}));
    for (let attempt = 0; attempt < 8 && !current; attempt++) {
      current = await state(id);
      if (!current) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!current) throw new Error("Account created but final RPC state is unavailable. Check the recorded transaction before retrying.");
  }
  if (current.code_hash !== "11111111111111111111111111111111") {
    console.log(name, "already has code; skipping deployment");
    return;
  }
  const code = await readFile(new URL(wasm, root));
  const budget = BigInt(code.length + 4096) * 10n ** 19n + one / 4n;
  if (BigInt(current.amount) < budget) { await record(name + "_storage_funding", await account.signAndSendTransaction({receiverId: id, actions: [transactions.transfer(budget - BigInt(current.amount))], waitUntil: "FINAL", throwOnFailure: true})); }
  const signer = new Account(id, provider, KeyPairSigner.fromSecretKey(key.secretKey));
  await record(name + "_deploy_init", await signer.signAndSendTransaction({
    receiverId: id, actions: [deployContract(code),
      functionCall("new", init, 30_000_000_000_000n, 0n)], waitUntil: "FINAL", throwOnFailure: true,
  }));
}
try {
  const prior = JSON.parse(await readFile(report, "utf8"));
  if (prior.deployer === evidence.deployer) evidence.transactions = prior.transactions;
} catch (err) { if (err.code !== "ENOENT") throw err; }
const tokenPath = "contracts/near/target-token/wasm32-unknown-unknown/release/pactpay_demo_token.wasm";
const escrowPath = "contracts/near/target/wasm32-unknown-unknown/release/pactpay_escrow.wasm";
await setup(token, "token", tokenPath, {owner_id: key.accountId, supply: "1000000"});
await setup(escrow, "escrow", escrowPath, {token});
const view = (contractId, methodName, args = {}) => account.viewFunction({contractId, methodName, args});
if (await view(escrow, "get_token") !== token) throw new Error("Escrow token mismatch");
const min = (await view(token, "storage_balance_bounds")).min;
if (!await view(token, "storage_balance_of", {account_id: escrow})) {
  await record("escrow_token_registration", await account.functionCall({
    contractId: token, methodName: "storage_deposit", args: {account_id: escrow, registration_only: true},
    attachedDeposit: BigInt(min), gas: 30_000_000_000_000n,
  }));
}
evidence.verified = {tokenMetadata: await view(token, "ft_metadata"),
  escrowRegistration: await view(token, "storage_balance_of", {account_id: escrow}),
  escrowCodeHash: (await state(escrow)).code_hash, tokenCodeHash: (await state(token)).code_hash};
await writeFile(report, JSON.stringify(evidence, null, 2) + "\n");
await writeFile(new URL(".env.local", root), "VITE_NEAR_ESCROW=" + escrow + "\nVITE_NEAR_RPC=https://test.rpc.fastnear.com\n", {flag: "wx"}).catch(err => { if (err.code !== "EEXIST") throw err; });
console.log(JSON.stringify({token, escrow, verified: evidence.verified}));
