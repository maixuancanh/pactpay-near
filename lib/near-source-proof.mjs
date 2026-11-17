const schema = "pactpay.delivery-source.v1";
const digestPattern = /^[a-f0-9]{64}$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const unsignedId = /^(0|[1-9][0-9]{0,19})$/;
const base64Url = /^[A-Za-z0-9_-]+$/;
const utf8 = new TextEncoder();

const status = (state, reason, detail) => ({state, reason, detail});

function bytes(encoded, size) {
  if (typeof encoded !== "string" || !base64Url.test(encoded) || encoded.length !== Math.ceil(size * 8 / 6)) {
    throw new Error("Invalid signature encoding");
  }
  const result = Uint8Array.from(atob(encoded.replaceAll("-", "+").replaceAll("_", "/")), character=>character.charCodeAt(0));
  const canonical = btoa(String.fromCharCode(...result)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  if (result.length !== size || canonical !== encoded) throw new Error("Noncanonical signature encoding");
  return result;
}

export function sourceReceiptMessage(payload, entryHash) {
  const {scope} = payload;
  return utf8.encode(JSON.stringify([
    schema,payload.issuer,payload.keyId,payload.eventId,payload.eventType,
    scope.network,scope.escrow,scope.booking,scope.position,scope.version,
    entryHash,payload.artifactDigest,payload.recipient,payload.occurredAt,payload.expiresAt,
  ]));
}

/** Select fields explicitly so an attached receipt never introduces arbitrary export data. */
export function copySourceReceipt(receipt) {
  const {entryHash, payload:p, signature} = receipt ?? {};
  const scope = p?.scope;
  if (!p || !scope || p.schema !== schema || p.eventType !== "access-granted" || scope.network !== "testnet" ||
      ![p.issuer,p.keyId,p.eventId,p.recipient,scope.escrow].every(value=>typeof value==="string" && identifier.test(value)) ||
      ![scope.booking,scope.position,scope.version].every(value=>typeof value==="string" && unsignedId.test(value)) ||
      ![entryHash,p.artifactDigest].every(value=>typeof value==="string" && digestPattern.test(value)) ||
      !Number.isSafeInteger(p.occurredAt) || !Number.isSafeInteger(p.expiresAt) ||
      p.occurredAt < 0 || p.expiresAt <= p.occurredAt) throw new Error("Invalid delivery source receipt");
  bytes(signature,64);
  return {entryHash,signature,payload:{schema,issuer:p.issuer,keyId:p.keyId,eventId:p.eventId,eventType:p.eventType,
    scope:{network:scope.network,escrow:scope.escrow,booking:scope.booking,position:scope.position,version:scope.version},
    artifactDigest:p.artifactDigest,recipient:p.recipient,occurredAt:p.occurredAt,expiresAt:p.expiresAt}};
}

export function trustedSourceIssuers(configuration) {
  if (!configuration) return [];
  try {
    const issuers = JSON.parse(configuration);
    if (!Array.isArray(issuers) || issuers.length > 32) return [];
    const unique = new Set();
    for (const issuer of issuers) {
      if (typeof issuer?.id !== "string" || typeof issuer?.keyId !== "string" ||
          !identifier.test(issuer.id) || !identifier.test(issuer.keyId) ||
          typeof issuer.label !== "string" || !issuer.label.trim() || issuer.label.length > 100) return [];
      bytes(issuer.publicKey,32);
      const key = JSON.stringify([issuer.id,issuer.keyId]);
      if (unique.has(key)) return [];
      unique.add(key);
    }
    return issuers;
  } catch {
    return [];
  }
}

export async function verifySourceReceipt({receipt,scope,recipient,openings,issuers,now=Math.floor(Date.now()/1000)}) {
  if (!receipt) return status("unavailable","source-attestation-missing","No signed delivery receipt was shared.");
  let material;
  try {
    material = copySourceReceipt(receipt);
  } catch {
    return status("invalid","source-receipt-invalid","The delivery receipt is malformed.");
  }
  const p = material.payload;
  if (["network","escrow","booking","position","version"].some(key=>p.scope[key]!==scope[key]) || p.recipient !== recipient) {
    return status("invalid","source-scope-mismatch","The receipt names another agreement or recipient.");
  }
  if (p.occurredAt > now || p.expiresAt <= now) {
    return status("invalid","source-receipt-outside-validity","The receipt is outside its validity period.");
  }
  const issuer = issuers.find(candidate=>candidate.id===p.issuer && candidate.keyId===p.keyId);
  if (!issuer) return status("unavailable","source-issuer-untrusted","This verifier has no trusted public key for the issuer.");
  const text = openings.get(material.entryHash);
  if (text === undefined) return status("unavailable","source-opening-missing","The corresponding verified excerpt was not shared.");
  try {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256",utf8.encode(text)));
    const hex = Array.from(digest,value=>value.toString(16).padStart(2,"0")).join("");
    if (hex !== p.artifactDigest) return status("invalid","source-artifact-mismatch","The verified excerpt differs from the signed artifact.");
    const key = await crypto.subtle.importKey("raw",bytes(issuer.publicKey,32),"Ed25519",false,["verify"]);
    if (!await crypto.subtle.verify("Ed25519",key,bytes(material.signature,64),sourceReceiptMessage(p,material.entryHash))) {
      return status("invalid","source-signature-invalid","The configured issuer key did not verify the receipt.");
    }
    return status("verified","source-access-grant-verified",`${issuer.label} signed the access-granted event for this recipient and excerpt.`);
  } catch {
    return status("unavailable","source-verifier-unavailable","This device could not check the delivery signature.");
  }
}
