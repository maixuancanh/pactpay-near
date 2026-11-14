import {readFile} from "node:fs/promises";
import {isDeepStrictEqual} from "node:util";
import {providers} from "near-api-js";
const file=process.argv[2];
if (!file) throw new Error("Usage: node scripts/near/verify-public-receipt.mjs receipt.json");
const receipt=JSON.parse(await readFile(file,"utf8"));
if(receipt.network!=="testnet" || !/^escrow\.pactpay-[a-f0-9]{8}\.testnet$/.test(receipt.escrow) ||
   !Number.isSafeInteger(receipt.bookingId) || receipt.bookingId<0) throw new Error("Invalid PactPay receipt.");
const rpc=new providers.JsonRpcProvider({url:"https://test.rpc.fastnear.com"});
const [booking,token]=await Promise.all([
  rpc.callFunction(receipt.escrow,"get_booking",{id:receipt.bookingId},{finality:"final"}),
  rpc.callFunction(receipt.escrow,"get_token",{},{finality:"final"}),
]);
if(!booking || token!==receipt.token || !isDeepStrictEqual(booking,receipt.booking)) {
  console.error("Receipt differs from finalized state. It may have changed or may have been edited.");
  process.exitCode=1;
}else console.log("Receipt matches finalized state for booking",receipt.bookingId);
