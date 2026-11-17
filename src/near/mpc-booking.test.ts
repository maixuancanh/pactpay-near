import {describe,expect,it} from "vitest";
import {bookingAction} from "../../lib/near-mpc-booking.mjs";

describe("MPC booking policy",()=>{
  const args={terms_commitment:"a".repeat(64),fund_until:"1800000000",service_end:"1800000300",shares:[{buyer:"buyer.testnet",amount:"20"}]};
  const quote=async(n:number)=>String(n*100);
  it("fixes the method, gas and deposit",async()=>{
    const action=await bookingAction(args,"merchant.testnet",quote);
    expect(action.functionCall).toMatchObject({methodName:"create_booking",gas:100000000000000n,deposit:100n});
  });
  it("rejects extra fields and self-bookings",async()=>{
    await expect(bookingAction({...args,recipient:"other.testnet"},"merchant.testnet",quote)).rejects.toThrow();
    await expect(bookingAction(args,"buyer.testnet",quote)).rejects.toThrow();
  });
});
