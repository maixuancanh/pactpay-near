const encoder = new TextEncoder();
export const decodeText = (value: ArrayBuffer) => new TextDecoder().decode(value);

export function encode(bytes: ArrayBuffer | Uint8Array) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let value = "";
  for (let i = 0; i < input.length; i += 8192) value += String.fromCharCode(...input.subarray(i,i+8192));
  return btoa(value);
}

export function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

export async function createEvidenceKey() {
  const pair = await crypto.subtle.generateKey({name:"RSA-OAEP", modulusLength:2048,
    publicExponent:new Uint8Array([1,0,1]), hash:"SHA-256"},true,["encrypt","decrypt"]);
  const rawCode = crypto.getRandomValues(new Uint8Array(32));
  const wrap = await crypto.subtle.importKey("raw",rawCode,"AES-GCM",false,["encrypt","decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const backup = await crypto.subtle.encrypt({name:"AES-GCM",iv},wrap,await crypto.subtle.exportKey("pkcs8",pair.privateKey));
  const profile = {key:await crypto.subtle.exportKey("jwk",pair.publicKey),backup:encode(backup),iv:encode(iv)};
  return {code:encode(rawCode), profile};
}

export async function restoreEvidenceKey(profile: {backup:string;iv:string;key:JsonWebKey}, code: string) {
  const wrap = await crypto.subtle.importKey("raw",decode(code.trim()),"AES-GCM",false,["decrypt"]);
  const bytes = await crypto.subtle.decrypt({name:"AES-GCM",iv:decode(profile.iv)},wrap,decode(profile.backup));
  const key = await crypto.subtle.importKey("pkcs8",bytes,{name:"RSA-OAEP",hash:"SHA-256"},true,["decrypt"]);
  const exported = await crypto.subtle.exportKey("jwk",key);
  if (exported.n !== profile.key.n || exported.e !== profile.key.e) throw new Error("Recovery key does not match the evidence profile.");
  return crypto.subtle.importKey("pkcs8",bytes,{name:"RSA-OAEP",hash:"SHA-256"},false,["decrypt"]);
}

export async function encryptEvidence(text:string, recipients:Record<string,JsonWebKey>) {
  const bytes = encoder.encode(text);
  if (bytes.length === 0 || bytes.length > 500000) throw new Error("Evidence must contain between 1 and 500,000 bytes.");
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey("raw",raw,"AES-GCM",false,["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({name:"AES-GCM",iv},key,bytes);
  const entries = await Promise.all(Object.entries(recipients).map(async ([id,jwk]) => {
    const publicKey = await crypto.subtle.importKey("jwk",jwk,{name:"RSA-OAEP",hash:"SHA-256"},false,["encrypt"]);
    return [id,encode(await crypto.subtle.encrypt("RSA-OAEP",publicKey,raw))];
  }));
  return {ciphertext:encode(ciphertext),iv:encode(iv),keys:Object.fromEntries(entries) as Record<string,string>};
}

export async function openEvidence(item:{ciphertext:string;iv:string;wrapped:string},key:CryptoKey,id:string) {
  const iv=decode(item.iv), ciphertext=decode(item.ciphertext);
  const packed=new Uint8Array(iv.length+ciphertext.length);
  packed.set(iv); packed.set(ciphertext,iv.length);
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",packed)), byte=>byte.toString(16).padStart(2,"0")).join("");
  if(hash!==id) throw new Error("Evidence does not match its commitment.");
  const raw=await crypto.subtle.decrypt("RSA-OAEP",key,decode(item.wrapped));
  const aes=await crypto.subtle.importKey("raw",raw,"AES-GCM",false,["decrypt"]);
  const text = decodeText(await crypto.subtle.decrypt({name:"AES-GCM",iv},aes,ciphertext));
  return {text, excerptKey:encode(raw)};
}

export async function decryptEvidence(item:{ciphertext:string;iv:string;wrapped:string},key:CryptoKey,id:string) {
  return (await openEvidence(item,key,id)).text;
}

export async function openEvidenceWithExcerptKey(item:{ciphertext:string;iv:string;excerptKey:string},id:string) {
  const iv=decode(item.iv), ciphertext=decode(item.ciphertext), raw=decode(item.excerptKey);
  if(iv.length!==12 || raw.length!==32 || ciphertext.length<17) throw Error("Invalid evidence opening.");
  const packed=new Uint8Array(iv.length+ciphertext.length);
  packed.set(iv);packed.set(ciphertext,iv.length);
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",packed)),byte=>byte.toString(16).padStart(2,"0")).join("");
  if(hash!==id)throw Error("Evidence does not match its commitment.");
  const key=await crypto.subtle.importKey("raw",raw,"AES-GCM",false,["decrypt"]);
  return new TextDecoder("utf-8",{fatal:true}).decode(await crypto.subtle.decrypt({name:"AES-GCM",iv},key,ciphertext));
}
