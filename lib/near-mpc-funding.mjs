export const activationDeposit = 5_000_000_000_000_000_000_000n;
const storageByteCost = 10_000_000_000_000_000_000n;
const gasReserve = 20_000_000_000_000_000_000_000n;
const maxSubsidy = 250_000_000_000_000_000_000_000n;

export function bookingShortfall(balance, storageBytes, deposit) {
  const missing = BigInt(deposit) + BigInt(storageBytes) * storageByteCost + gasReserve - BigInt(balance);
  if (missing > maxSubsidy) throw new Error("The booking exceeds the Testnet sponsorship limit.");
  return missing > 0n ? missing : 0n;
}
