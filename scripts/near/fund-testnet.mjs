import {readFile, mkdir, writeFile} from "node:fs/promises";
import {randomBytes} from "node:crypto";
import {KeyPair} from "near-api-js";

const dir = new URL("../../.near-testnet/", import.meta.url);
const keyFile = new URL("deploy-key.json", dir);
await mkdir(dir, {recursive: true});
let record;
try { record = JSON.parse(await readFile(keyFile, "utf8")); }
catch (err) {
  if (err.code !== "ENOENT") throw err;
  const key = KeyPair.fromRandom("ed25519");
  record = {accountId: "pactpay-" + randomBytes(4).toString("hex") + ".testnet",
    publicKey: key.getPublicKey().toString(), secretKey: key.toString()};
  await writeFile(keyFile, JSON.stringify(record), {flag: "wx", mode: 0o600});
}
console.log("Project testnet account:", record.accountId);
const response = await fetch("https://helper.nearprotocol.com/account", {
  method: "POST", headers: {"Content-Type": "application/json"},
  body: JSON.stringify({newAccountId: record.accountId, newAccountPublicKey: record.publicKey}),
  signal: AbortSignal.timeout(30000),
});
console.log("Testnet account helper HTTP", response.status);
if (!response.ok) {
  console.log((await response.text()).slice(0, 700));
  process.exitCode = 1;
}
