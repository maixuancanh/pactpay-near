import {actionCreators} from "@near-js/transactions";

export const bookingEscrow = "escrow-v2.pactpay-530c506b.testnet";
const accountId = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const unsigned = /^[1-9][0-9]{0,38}$/;

export async function bookingAction(args, merchant, quoteDeposit) {
  if (!args || Object.keys(args).length !== 4 ||
      !/^[0-9a-f]{64}$/.test(args.terms_commitment) ||
      ![args.fund_until,args.service_end].every(value=>typeof value==="string" && /^[1-9][0-9]{0,14}$/.test(value)) ||
      BigInt(args.fund_until) >= BigInt(args.service_end) ||
      !Array.isArray(args.shares) || args.shares.length < 1 || args.shares.length > 32) {
    throw new Error("Invalid booking.");
  }
  const buyers = new Set();
  const shares = args.shares.map(share=>{
    if (!share || Object.keys(share).length !== 2 || typeof share.buyer !== "string" ||
        share.buyer.length < 2 || share.buyer.length > 64 || !accountId.test(share.buyer) ||
        share.buyer === merchant || buyers.has(share.buyer) || typeof share.amount !== "string" ||
        !unsigned.test(share.amount) || BigInt(share.amount) >= 2n ** 128n) {
      throw new Error("Invalid buyer share.");
    }
    buyers.add(share.buyer);
    return {buyer:share.buyer,amount:share.amount};
  });
  const deposit = BigInt(await quoteDeposit(shares.length));
  return actionCreators.functionCall("create_booking",{
    terms_commitment:args.terms_commitment,fund_until:args.fund_until,service_end:args.service_end,shares,
  },100000000000000n,deposit);
}
