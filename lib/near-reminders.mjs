const windows = Object.freeze([3600, 86400]);

function deadline(value) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  const remaining = Number(value);
  return Number.isSafeInteger(remaining) ? remaining : null;
}

/** Derive in-app notices from the agreement read at the latest finalized block. */
export function agreementReminder({escrow, booking, position, agreement, time}) {
  const terms = agreement?.proposal;
  if (!terms || terms.network !== "testnet" || terms.escrow !== escrow ||
      terms.booking !== String(booking) || terms.position !== String(position) ||
      !Number.isSafeInteger(time)) return null;
  let role, type, due;
  switch (agreement.status) {
    case "Proposed":
      if (agreement.approvals !== 1 && agreement.approvals !== 2) return null;
      role = agreement.approvals === 1 ? "merchant" : "buyer";
      type = "approve";
      due = deadline(terms.acceptBy);
      break;
    case "Active":
      role = "merchant";
      type = "deliver";
      due = deadline(terms.deliverBy);
      break;
    case "CompletionSubmitted":
      role = "buyer";
      type = "review";
      due = deadline(terms.reviewUntil);
      break;
    default:
      return null;
  }
  if (due === null || time >= due) return null;
  const window = windows.find(seconds=>due-time<=seconds);
  if (window === undefined) return null;
  const scope = {network:"testnet",escrow,booking:String(booking),position:String(position),version:terms.version};
  return {
    key:JSON.stringify([scope.network,escrow,scope.booking,scope.position,scope.version,type,role,window]),
    scope,role,type,deadline:due,window,
  };
}

export function reminderForRole(input, role) {
  const reminder = agreementReminder(input);
  return reminder?.role === role ? reminder : null;
}
