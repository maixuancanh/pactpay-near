import {describe,expect,it} from "vitest";
import {bookingShortfall} from "../../lib/near-mpc-funding.mjs";

describe("Testnet booking sponsorship",()=>{
  it("covers the deposit, account storage and the gas reserve, minus the balance",()=>{
    expect(bookingShortfall("10000000000000000000000",100,"51200000000000000000000"))
      .toBe(62200000000000000000000n);
    expect(bookingShortfall("100000000000000000000000",100,"51200000000000000000000")).toBe(0n);
  });
  it("keeps the per-booking subsidy bounded",()=>{
    expect(()=>bookingShortfall("0",100,"240000000000000000000000")).toThrow(/limit/i);
  });
});
