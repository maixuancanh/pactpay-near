import {createHash} from "node:crypto";
import {evidenceKinds, hashEvidenceEntry, verifyEvidenceManifest} from "../src/near/agreements/evidence-manifest.mjs";

const hashPattern = /^[a-f0-9]{64}$/;
const validSequence = value => Number.isSafeInteger(value) && value >= 1;
const entryPath = (root,author,sequence) => root + author + "/entries/" + sequence;

function encryptedField(value, max, exactBytes) {
  if (typeof value !== "string" || value.length > max || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const decoded = Buffer.from(value,"base64");
  if (decoded.toString("base64") !== value || (exactBytes !== undefined && decoded.length !== exactBytes)) return null;
  return decoded;
}

function envelopeHash(item) {
  const ciphertext = encryptedField(item?.ciphertext,800000);
  const iv = encryptedField(item?.iv,24,12);
  if (!iv || !ciphertext || ciphertext.length < 17) return null;
  return createHash("sha256").update(iv).update(ciphertext).digest("hex");
}

async function authorRecords(store, root, author, through) {
  const prefix = entryPath(root,author,"");
  const listed = await store.list(prefix);
  const keys = through === undefined ? listed : listed.filter(key=>Number(key.slice(prefix.length)) <= through);
  const records = await Promise.all(keys.map(async key => {
    const record = await store.get(key);
    if (!record?.entry || record.entry.author !== author ||
        key !== entryPath(root,author,record.entry.sequence)) throw new Error("Evidence history is unavailable.");
    return record;
  }));
  return records.sort((a,b)=>a.entry.sequence-b.entry.sequence);
}

export async function evidenceV2({data,res,store,scope,account,other}) {
  const {booking,position,network,escrow} = scope;
  const root = ["evidence-v2",network,escrow,booking,position,""].join("/");
  if (data.action === "list") {
    const authors = [...new Set([account,other])].sort();
    const checkpointPath = digest => root+"snapshots/"+digest;
    if (data.evidenceRoot !== undefined) {
      if (typeof data.evidenceRoot !== "string" || !hashPattern.test(data.evidenceRoot)) throw new Error("Invalid evidence snapshot.");
      const checkpoint = await store.get(checkpointPath(data.evidenceRoot));
      if (!checkpoint) return res.status(404).json({error:"Historical evidence snapshot is unavailable."});
      const records = (await Promise.all(authors.map(author=>authorRecords(store,root,author,checkpoint.heads?.[author] ?? 0)))).flat();
      const entries = records.map(record=>record.entry);
      if (await verifyEvidenceManifest(scope,entries) !== data.evidenceRoot) {
        throw new Error("Historical evidence snapshot failed verification.");
      }
      return res.json({entries,evidenceRoot:data.evidenceRoot});
    }
    const authorHistories = await Promise.all(authors.map(author=>authorRecords(store,root,author)));
    const entries = authorHistories.flat().map(record=>record.entry);
    const evidenceRoot = await verifyEvidenceManifest(scope,entries);
    const heads = Object.fromEntries(authors.map((author,index)=>[author,authorHistories[index].at(-1)?.entry.sequence ?? 0]));
    await store.put(checkpointPath(evidenceRoot),{heads});
    return res.json({entries,evidenceRoot});
  }

  if (data.action === "read") {
    if (!validSequence(data.sequence) || ![account,other].includes(data.author)) throw new Error("Invalid evidence entry.");
    const path = entryPath(root,data.author,data.sequence);
    const record = await store.get(path);
    if (!record) return res.json({item:null,entry:null});
    if (data.author !== account && await store.get(root+data.author+"/revoked/"+data.sequence)) {
      return res.status(403).json({error:"Access to this evidence key was revoked."});
    }
    const {entry,envelope} = record;
    if (entry.author !== data.author || entry.sequence !== data.sequence ||
        ["network","escrow","booking","position"].some(key=>entry.case[key] !== scope[key]) ||
        entry.entryHash !== await hashEvidenceEntry(entry) || entry.ciphertextHash !== envelopeHash(envelope)) {
      throw new Error("Evidence does not match its commitment.");
    }
    const wrapped = envelope.keys?.[account];
    if (!encryptedField(wrapped,350,256)) throw new Error("Evidence key unavailable.");
    return res.json({entry,item:{ciphertext:envelope.ciphertext,iv:envelope.iv,wrapped}});
  }

  if (data.action === "revoke") {
    if (!validSequence(data.sequence)) throw new Error("Invalid evidence entry.");
    if (!await store.get(entryPath(root,account,data.sequence))) {
      return res.status(404).json({error:"Evidence entry not found."});
    }
    await store.put(root+account+"/revoked/"+data.sequence,{revoked:true});
    return res.json({ok:true});
  }

  if (data.action !== "upload") return res.status(400).json({error:"Unknown evidence action."});
  const {sequence,previousEntryHash,idempotencyKey} = data;
  const supersedes = data.supersedes ?? null;
  const kind = data.kind ?? "evidence";
  const ciphertextHash = envelopeHash(data);
  if (!validSequence(sequence) ||
      (previousEntryHash !== null && (typeof previousEntryHash !== "string" || !hashPattern.test(previousEntryHash))) ||
      (supersedes !== null && (typeof supersedes !== "string" || !hashPattern.test(supersedes))) ||
      !evidenceKinds.includes(kind) || typeof idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{12,80}$/.test(idempotencyKey) ||
      !ciphertextHash || ![account,other].every(id=>encryptedField(data.keys?.[id],350,256))) {
    throw new Error("Invalid encrypted evidence entry.");
  }

  const envelope = {ciphertext:data.ciphertext,iv:data.iv,keys:{[account]:data.keys[account],[other]:data.keys[other]}};
  const path = entryPath(root,account,sequence);
  const requestHash = createHash("sha256").update(JSON.stringify([
    sequence,previousEntryHash,supersedes,kind,ciphertextHash,envelope.keys[account],envelope.keys[other],
  ])).digest("hex");
  const conflict = () => res.status(409).json({error:"Evidence history changed or this upload key was already used."});
  const resolveRetry = record => record?.idempotencyKey === idempotencyKey && record.requestHash === requestHash
    ? res.json({entry:record.entry})
    : conflict();

  const existing = await store.get(path);
  if (existing) return resolveRetry(existing);

  const records = await authorRecords(store,root,account);
  const entries = records.map(record=>record.entry);
  await verifyEvidenceManifest(scope,entries);
  const previous = entries.at(-1);
  if (previous?.sequence === sequence) return resolveRetry(records.at(-1));
  if (sequence !== (previous?.sequence ?? 0)+1 || previousEntryHash !== (previous?.entryHash ?? null) ||
      (supersedes && !entries.some(entry=>entry.entryHash === supersedes)) ||
      records.some(record=>record.idempotencyKey === idempotencyKey)) return conflict();

  const fields = {case:scope,author:account,sequence,previousEntryHash,ciphertextHash,supersedes,
    sourceLocator:account+"/entries/"+sequence,createdAt:new Date().toISOString(),kind};
  const entry = {...fields,entryHash:await hashEvidenceEntry(fields)};
  if (!await store.put(path,{entry,envelope,idempotencyKey,requestHash})) return resolveRetry(await store.get(path));
  return res.json({entry});
}
