import type {AgreementRecord} from "../src/near/agreements/chain-v2";
import type {CaseScope} from "../src/near/agreements/case-model";

type ReminderRole = "buyer" | "merchant";
type ReminderInput = {
  escrow: string;
  booking: number;
  position: number;
  agreement: AgreementRecord | null;
  time: number;
};
export type AgreementReminder = {
  key: string;
  scope: CaseScope;
  role: ReminderRole;
  type: "approve" | "deliver" | "review";
  deadline: number;
  window: number;
};
export function agreementReminder(input: ReminderInput): AgreementReminder | null;
export function reminderForRole(input: ReminderInput, role: ReminderRole): AgreementReminder | null;
