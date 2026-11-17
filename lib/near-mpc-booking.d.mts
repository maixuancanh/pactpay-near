import type {Action} from "@near-js/transactions";
export const bookingEscrow: string;
export function bookingAction(
  args: unknown,
  merchant: string,
  quoteDeposit: (positions: number) => Promise<string>,
): Promise<Action>;
