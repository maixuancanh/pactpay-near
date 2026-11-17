export interface BookingInvitation {
  escrow: string;
  booking: number;
  position: number;
  version: string;
}

const keys = ["escrow", "booking", "position", "version"] as const;
const decimal = /^(0|[1-9]\d*)$/;

export function parseInvitation(params: URLSearchParams, allowedEscrows: readonly string[]): BookingInvitation | null {
  if (!params.has("position") && !params.has("version")) return null;
  if (keys.some(key => params.getAll(key).length !== 1)) throw new Error("Invalid booking invitation.");
  const [escrow, booking, position, version] = keys.map(key => params.get(key)!);
  if (!escrow || !allowedEscrows.includes(escrow) || ![booking, position, version].every(value => decimal.test(value)) ||
    ![booking, position].every(value => Number.isSafeInteger(Number(value))) ||
    version.length > 20 || BigInt(version) > (1n << 64n) - 1n) {
    throw new Error("Invalid booking invitation.");
  }
  return {escrow, booking: Number(booking), position: Number(position), version};
}

export function invitationUrl(origin: string, invitation: BookingInvitation): string {
  const url = new URL("/booking", origin);
  for (const key of keys) url.searchParams.set(key, String(invitation[key]));
  return url.href;
}

export function needsInvitationReview(invited: string | undefined, current: string | undefined, reviewed: string | undefined): boolean {
  return invited !== undefined && current !== undefined && invited !== current && reviewed !== current;
}
