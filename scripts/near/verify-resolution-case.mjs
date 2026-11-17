import {createDecipheriv, createHash} from "node:crypto";
import {resolutionAssessmentDigest} from "../../src/near/agreements/assessment-digest.mjs";
import {verifyEvidenceManifest} from "../../src/near/agreements/evidence-manifest.mjs";
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {providers} from "near-api-js";
import {agreementDigest} from "../../src/near/agreements/canonical.mjs";
import {inspectClaim} from "./reconcile-resolution-v2.mjs";

const sha256 = /^[0-9a-f]{64}$/;
const hash = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const account = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;
const decimal = /^(0|[1-9][0-9]*)$/;
const isAccount = value => typeof value === "string" && value.length >= 2 && value.length <= 64 && account.test(value);
const isDecimal = (value, bits) => typeof value === "string" && value.length <= 39 &&
  decimal.test(value) && BigInt(value) < 1n << BigInt(bits);
const isHash = value => typeof value === "string" && hash.test(value);
const isDigest = value => typeof value === "string" && sha256.test(value);

export class CheckFailure extends Error {}
function decodeBase64(value, length) {
  requireProof(typeof value === "string" && value.length <= 800000, "Invalid encoded data.");
  const bytes = Buffer.from(value,"base64");
  requireProof(bytes.toString("base64") === value && (length === undefined || bytes.length === length), "Invalid encoded data.");
  return bytes;
}
function requireProof(condition, detail) {
  if (!condition) throw new CheckFailure(detail);
}

function validateCase(data) {
  const p = data?.proposal;
  requireProof(data?.schema === "pactpay.resolution-proof.v2" && data.network === "testnet" &&
    data.contractVersion === 2 && isAccount(data.escrow) && isHash(data.codeHash) && isDigest(data.digest),
  "Invalid resolution proof identity.");
  requireProof(p?.schema === "pactpay.resolution.v2" && p.network === data.network && p.escrow === data.escrow &&
    [p.buyer,p.merchant,p.token].every(isAccount) && p.buyer !== p.merchant,
  "Invalid agreement identity.");
  requireProof([p.booking,p.version,p.acceptBy,p.deliverBy,p.reviewUntil].every(value => isDecimal(value,64)) &&
    isDecimal(p.position,8) && Number.isSafeInteger(Number(p.booking)) && p.version !== "0" &&
    [p.termsCommitment,p.evidenceRoot,p.privateTermsCommitment,p.salt].every(isDigest) &&
    (p.assessmentDigest === null || isDigest(p.assessmentDigest)),
  "Invalid agreement commitments, version or deadlines.");
  requireProof([p.immediateBuyer,p.immediateMerchant,p.retained,p.successBuyer,p.successMerchant,
    p.fallbackBuyer,p.fallbackMerchant].every(value => isDecimal(value,128)),
  "Invalid agreement amounts.");
  requireProof(BigInt(p.acceptBy) < BigInt(p.deliverBy) && BigInt(p.deliverBy) < BigInt(p.reviewUntil) &&
    BigInt(p.successBuyer) + BigInt(p.successMerchant) === BigInt(p.retained) &&
    BigInt(p.fallbackBuyer) + BigInt(p.fallbackMerchant) === BigInt(p.retained), "Invalid agreement splits or deadline order.");
}

export async function finalizedCall(reader, ref, escrow, method) {
  requireProof(isHash(ref?.hash) && isAccount(ref?.signer), "Invalid transaction reference.");
  const result = await reader.transaction(ref.hash,ref.signer);
  if (result?.final_execution_status !== "FINAL") throw new Error("Transaction finality unavailable.");
  const tx = result.transaction;
  const call = tx?.actions?.[0]?.FunctionCall;
  requireProof(tx?.hash === ref.hash && tx.signer_id === ref.signer && tx.receiver_id === escrow &&
    tx?.actions?.length === 1 && call?.method_name === method && typeof result.status?.SuccessValue === "string",
  "Finalized transaction did not perform the expected successful call.");
  const receipt = result.receipts_outcome?.find(item => item.outcome?.executor_id === escrow);
  if (!isHash(receipt?.block_hash)) throw new Error("Execution block unavailable.");
  try {
    return {args:JSON.parse(Buffer.from(call.args,"base64").toString("utf8")), block:receipt.block_hash, result};
  } catch {
    throw new CheckFailure("Malformed function call arguments.");
  }
}

function samePosition(args,p) {
  return args?.id === Number(p.booking) && args.index === Number(p.position);
}

export function receiptEvents(result, executor, standard, version, event) {
  const matches = [];
  for (const receipt of result.receipts_outcome ?? []) {
    if (receipt.outcome?.executor_id !== executor || !receipt.outcome.status ||
        !Object.keys(receipt.outcome.status).some(key => key === "SuccessValue" || key === "SuccessReceiptId")) continue;
    for (const log of receipt.outcome.logs ?? []) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      let parsed;
      try {
        parsed = JSON.parse(log.slice("EVENT_JSON:".length));
      } catch {
        continue;
      }
      if (parsed.standard === standard && parsed.version === version && parsed.event === event && Array.isArray(parsed.data)) {
        matches.push(...parsed.data.map(data => ({data,block:receipt.block_hash,receiptId:receipt.id})));
      }
    }
  }
  return matches;
}

export async function findHistoricalClaim(reader, p, claimId, block) {
  for (let from_index = 0; from_index < 256; from_index += 20) {
    const limit = Math.min(20, 256 - from_index);
    const records = await reader.view(p.escrow, "get_claims",
      {id:Number(p.booking),index:Number(p.position),from_index,limit},block);
    const record = records?.find(item => item.claim_id === claimId && item.agreement_version === p.version);
    if (record || !records || records.length < limit) return record;
  }
}

export async function verifyClaim(reader,ref,p) {
  requireProof([p.buyer,p.merchant].includes(ref?.signer), "Claim signer is outside the agreement.");
  if (ref.reconciliation) return verifyReconciledClaim(reader,ref,p);
  const tx = await reader.transaction(ref.hash,ref.signer);
  const method = tx.transaction?.actions?.[0]?.FunctionCall?.method_name;
  requireProof(["claim_v2","claim_retryable_v2"].includes(method),"Unsupported claim method.");
  const {args,result} = await finalizedCall({...reader,transaction:async()=>tx},ref,p.escrow,method);
  const claimId = args?.claim_id;
  requireProof(isDecimal(claimId,64), "Invalid claim ID.");
  const pending = receiptEvents(result,p.escrow,"pactpay","2.0.0","claim_pending");
  const paid = receiptEvents(result,p.escrow,"pactpay","2.0.0","claim_paid");
  const retryable = method==="claim_retryable_v2";
  const transfer = retryable ? receiptEvents(result,p.token,"pactpay_token","1.0.0","payout_recorded")
    : receiptEvents(result,p.token,"nep141","1.0.0","ft_transfer");
  requireProof(pending.length === 1 && paid.length === 1 && transfer.length === 1,
    "Expected one successful escrow claim, token transfer and paid callback.");
  const claim = paid[0].data;
  const before = pending[0].data;
  requireProof(claim?.claim_id === claimId && claim.booking === p.booking && claim.position === p.position &&
    claim.version === p.version && claim.recipient === ref.signer && claim.token === p.token &&
    isDecimal(claim.amount,128) && claim.amount !== "0" &&
    isDecimal(claim.attempt_nonce,64) && claim.attempt_nonce !== "0" && claim.status === "Paid" &&
    before?.status === "Pending" && ["claim_id","booking","position","version","recipient","token","amount","attempt_nonce"]
      .every(key => before[key] === claim[key]),
  "Paid callback or claim attempt differs from the requested payout.");
  const movement = transfer[0].data;
  requireProof((retryable ? movement?.escrow===p.escrow && movement.claim_id===claimId && movement.recipient===claim.recipient
    : movement?.old_owner_id===p.escrow && movement.new_owner_id===claim.recipient) &&
    movement.amount === claim.amount, "Token transfer differs from the escrow payout.");
  const block = paid[0].block;
  if (!isHash(block)) throw new Error("Claim block unavailable.");
  const record = await findHistoricalClaim(reader,p,claimId,block);
  requireProof(record?.recipient === claim.recipient && record.amount === claim.amount &&
    record.status === "Paid" && record.attempt_nonce === claim.attempt_nonce,
  "Historical ledger has no matching Paid claim.");
  return {id:claimId,recipient:claim.recipient,amount:claim.amount,block,
    receiptIds:[pending[0].receiptId,transfer[0].receiptId,paid[0].receiptId]};
}

async function verifyReconciledClaim(reader,ref,p) {
  const repair = ref.reconciliation;
  requireProof(repair.signer === p.escrow, "Reconciliation was not signed by the escrow account.");
  const {args,result,block} = await finalizedCall(reader,repair,p.escrow,"reconcile_paid_claim_v2");
  let transfer;
  try {
    transfer = await inspectClaim({
      txStatusReceipts:reader.transaction,
      callFunction:(escrow,method,args)=>reader.view(escrow,method,args,block),
    },{escrow:p.escrow,token:p.token,hash:ref.hash,sender:ref.signer});
  } catch (error) {
    if (error.code !== "ERR_ASSERTION") throw error;
    throw new CheckFailure("The original payout receipts or historical claim do not match.");
  }
  requireProof(transfer.transferred && transfer.callbackFailed && transfer.status === "Paid" &&
    transfer.id === Number(p.booking) && transfer.index === Number(p.position) &&
    args.claim_id === transfer.claim_id && args.attempt_nonce === transfer.attempt_nonce &&
    args.transfer_receipt === transfer.transfer_receipt, "Reconciliation does not match the failed callback and completed transfer.");
  const markers = receiptEvents(result,p.escrow,"pactpay","2.0.0","reconciliation_receipt");
  const paid = receiptEvents(result,p.escrow,"pactpay","2.0.0","claim_reconciled");
  requireProof(markers.length === 1 && paid.length === 1 &&
    ["claim_id","attempt_nonce","transfer_receipt"].every(key=>markers[0].data[key] === args[key]) &&
    paid[0].data.claim_id === transfer.claim_id && paid[0].data.attempt_nonce === transfer.attempt_nonce &&
    paid[0].data.version === p.version && paid[0].data.booking === p.booking && paid[0].data.position === p.position &&
    paid[0].data.status === "Paid" && paid[0].data.amount === transfer.amount &&
    paid[0].data.recipient === ref.signer && paid[0].data.token === p.token,
  "Reconciliation receipt or payout event differs.");
  return {id:transfer.claim_id,recipient:ref.signer,amount:transfer.amount,block};
}

export async function verifyResolutionCase(data,reader) {
  const checks = [];
  async function check(name, work) {
    try {
      await work();
      checks.push({name,status:"Passed"});
      return true;
    } catch (error) {
      checks.push(error instanceof CheckFailure
        ? {name,status:"Failed",detail:error.message}
        : {name,status:"Unavailable",detail:"Required historical or proof material is unavailable."});
      return false;
    }
  }

  if (!await check("proofIdentity", () => validateCase(data))) return {ok:false,checks};
  const p = data.proposal;
  const receipts = data.receipts ?? {};
  await check("agreementDigest", async () => {
    requireProof(await agreementDigest(p) === data.digest, "Agreement digest differs from the exported payload.");
  });

  let approvalBlock;
  await check("bilateralApproval", async () => {
    if (!receipts.proposal || !receipts.approval) throw new Error("Approval history is absent.");
    const {proposal,approval} = receipts;
    requireProof(proposal.signer !== approval.signer &&
      [proposal.signer,approval.signer].every(signer => signer === p.buyer || signer === p.merchant),
    "Expected distinct buyer and merchant approvals.");
    const [proposed,approved] = await Promise.all([
      finalizedCall(reader,proposal,p.escrow,"propose_agreement"),
      finalizedCall(reader,approval,p.escrow,"approve_agreement"),
    ]);
    requireProof(samePosition(proposed.args,p) && samePosition(approved.args,p) &&
      proposed.args.proposal && await agreementDigest(proposed.args.proposal) === data.digest &&
      approved.args.version === p.version && approved.args.digest === data.digest,
    "Transaction arguments differ from the agreement identity or digest.");
    const proposalEvents = receiptEvents(proposed.result,p.escrow,"pactpay","2.0.0","agreement_proposed");
    const approvalEvents = receiptEvents(approved.result,p.escrow,"pactpay","2.0.0","agreement_activated");
    for (const [events, signer, status, mask] of [
      [proposalEvents,proposal.signer,"Proposed",proposal.signer === p.buyer ? 1 : 2],
      [approvalEvents,approval.signer,"Active",3],
    ]) {
      const event = events[0]?.data;
      requireProof(events.length === 1 && event?.booking === p.booking && event.position === p.position &&
        event.version === p.version && event.digest === data.digest && event.actor === signer &&
        event.status === status && event.approvals === mask, "Agreement event does not match the signed action.");
    }
    const snapshot = await reader.view(p.escrow,"get_agreement",{id:Number(p.booking),index:Number(p.position)},approved.block);
    requireProof(snapshot?.digest === data.digest && snapshot.proposal &&
      await agreementDigest(snapshot.proposal) === data.digest &&
      ["Active","CompletionSubmitted","Completed","FallbackAllocated"].includes(snapshot.status) &&
      snapshot.approvals === 3,
    "Historical agreement view lacks both approvals for this version.");
    approvalBlock = approved.block;
  });

  await check("contractVersionAndCode", async () => {
    if (!approvalBlock) throw new Error("Approval block is absent.");
    const [version, codeHash] = await Promise.all([
      reader.view(p.escrow,"contract_version",{},approvalBlock),
      reader.codeHash(p.escrow,approvalBlock),
    ]);
    requireProof(version === 2 && codeHash === data.codeHash, "Historical version or code hash differs.");
  });
  const authorized = data.authorized;
  const manifestOK = await check("evidenceSnapshot", async () => {
    if (authorized?.manifest === undefined) throw new Error("Manifest missing.");
    const manifest = authorized.manifest;
    requireProof(Array.isArray(manifest) && manifest.every(entry => [p.buyer,p.merchant].includes(entry?.author)), "Invalid manifest participants.");
    let root;
    try {
      root = await verifyEvidenceManifest({network:p.network,escrow:p.escrow,booking:p.booking,position:Number(p.position)},manifest);
    } catch {
      throw new CheckFailure("Evidence manifest failed integrity or case checks.");
    }
    requireProof(root === p.evidenceRoot, "Evidence manifest differs from the agreed snapshot.");
  });
  await check("privateTermsCommitment", () => {
    if (!manifestOK) throw new Error("Verified manifest required.");
    requireProof(authorized.manifest.some(entry => entry.kind === "agreement_terms" &&
      entry.ciphertextHash === p.privateTermsCommitment), "Signed private terms do not match any entry in the committed snapshot.");
  });
  await check("evidencePlaintext", () => {
    if (!manifestOK || authorized.openings === undefined) throw new Error("Verified manifest and opening required.");
    const entries = new Map(authorized.manifest.map(entry => [entry.entryHash,entry]));
    const opened = new Set();
    requireProof(Array.isArray(authorized.openings), "Invalid evidence openings.");
    for (const opening of authorized.openings) {
      const entry = entries.get(opening?.entryHash);
      requireProof(entry && !opened.has(entry.entryHash), "Opening references an unknown or duplicate manifest entry.");
      try {
        const encrypted = decodeBase64(opening.ciphertext);
        const iv = decodeBase64(opening.iv,12);
        const key = decodeBase64(opening.excerptKey,32);
        requireProof(encrypted.length >= 17 && createHash("sha256").update(iv).update(encrypted).digest("hex") === entry.ciphertextHash,
          "Ciphertext differs from the manifest commitment.");
        const decipher = createDecipheriv("aes-256-gcm",key,iv);
        decipher.setAuthTag(encrypted.subarray(-16));
        const plaintext = Buffer.concat([decipher.update(encrypted.subarray(0,-16)),decipher.final()]);
        requireProof(typeof opening.text === "string" && Buffer.from(opening.text,"utf8").equals(plaintext),
          "Plaintext differs from the authenticated ciphertext.");
      } catch {
        throw new CheckFailure("An evidence opening failed ciphertext or plaintext integrity checks.");
      }
      opened.add(entry.entryHash);
    }
    if (opened.size !== entries.size) throw new Error("Evidence was selectively disclosed.");
  });
  let verifiedClaims;
  await check("claimPayments", async () => {
    if (!approvalBlock) throw new Error("Approval history unavailable.");
    requireProof(receipts.claims === undefined || Array.isArray(receipts.claims), "Invalid claim references.");
    if (!receipts.claims?.length) throw new Error("Finalized claim transactions absent.");
    requireProof(receipts.claims.length <= 4, "Too many claim transactions.");
    const checked = await Promise.all(receipts.claims.map(ref => verifyClaim(reader,ref,p)));
    requireProof(new Set(checked.map(item => item.id)).size === checked.length, "Duplicate claim history.");
    const snapshots = await Promise.all(checked.map(({block}) =>
      reader.view(p.escrow,"get_agreement",{id:Number(p.booking),index:Number(p.position)},block)));
    requireProof(snapshots.every(snapshot => snapshot?.digest === data.digest), "Claim history differs from the agreed version.");
    const snapshot = snapshots.find(item => ["Completed","FallbackAllocated"].includes(item.status));
    if (!snapshot) {
      throw new Error("The terminal agreement and any remaining claim transactions are required.");
    }
    const finalAmounts = snapshot.status === "Completed"
      ? [p.successBuyer,p.successMerchant]
      : [p.fallbackBuyer,p.fallbackMerchant];
    const expected = [
      [p.buyer,p.immediateBuyer],[p.merchant,p.immediateMerchant],
      [p.buyer,finalAmounts[0]],[p.merchant,finalAmounts[1]],
    ].filter(([,amount]) => amount !== "0").map(pair => JSON.stringify(pair)).sort();
    const actual = checked.map(({recipient,amount}) => JSON.stringify([recipient,amount])).sort();
    if (expected.length > actual.length) throw new Error("Some payments have no finalized claim transaction.");
    requireProof(JSON.stringify(expected) === JSON.stringify(actual), "Claim recipients or amounts differ from the signed splits.");
    verifiedClaims = checked.map(({id,amount}, index) => ({id, amount, hash:receipts.claims[index].hash}));
  });
  if (p.assessmentDigest !== null) {
    await check("aiTranscript", async () => {
      const transcript = authorized?.transcript;
      if (!transcript) throw new Error("Encrypted transcript absent.");
      const {id,version,request,response,signature,attestation,model,promptVersion,inputHash,outputHash} = transcript;
      requireProof(version === 1 && typeof id === "string" && typeof model === "string" &&
        typeof promptVersion === "string" && isDigest(inputHash) && isDigest(outputHash) &&
        signature?.kind === "provider_tee" && typeof attestation?.nonce === "string",
        "Invalid provider transcript.");
      const requestBody = decodeBase64(request);
      const responseBody = decodeBase64(response);
      let parsed;
      try {
        parsed = JSON.parse(responseBody.toString("utf8"));
      } catch {
        throw new CheckFailure("Invalid encrypted response.");
      }
      requireProof(parsed?.id === id && await resolutionAssessmentDigest(p,{model,promptVersion,inputHash,outputHash,proof:{request,response}}) === p.assessmentDigest,
        "Transcript differs from the agreement assessment commitment.");
      const {verifyModelAttestation, verifyModelResponse} = await import("@nearai/inference-sdk/node");
      let verified;
      try {
        verified = await verifyModelAttestation({attestation,clientBinding:{nonce:attestation.nonce}});
      } catch (error) {
        const code = error?.code ?? error?.failure?.code;
        const reason = error?.details?.reason ?? error?.failure?.details?.reason;
        if (reason === "expired" || reason === "not_yet_valid" || code === "quote.collateral_unavailable" || error?.retryable) throw error;
        throw new CheckFailure("Model attestation failed validation.");
      }
      try {
        verifyModelResponse({requestBody,responseBody,signature,attestation:verified});
      } catch {
        throw new CheckFailure("Model signature did not authenticate the encrypted bytes.");
      }
    });
    checks.push({name:"aiPlaintextBinding",status:"Unavailable",detail:"The SDK has no portable two-way plaintext binding."});
  }
  return {ok:checks.every(item => item.status === "Passed"),checks,...(verifiedClaims ? {verifiedClaims} : {})};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error("Usage: node scripts/near/verify-resolution-case.mjs proof.json");
    process.exitCode = 2;
  } else {
    try {
      const rpc = new providers.JsonRpcProvider({url:"https://test.rpc.fastnear.com"});
      const result = await verifyResolutionCase(JSON.parse(await readFile(process.argv[2],"utf8")), {
        transaction:(txHash,signer) => rpc.txStatusReceipts(txHash,signer,"FINAL"),
        view:(escrow, method, args, blockId) => rpc.callFunction(escrow,method,args,{blockId}),
        codeHash:async (escrow,blockId) => (await rpc.query({request_type:"view_account",account_id:escrow,block_id:blockId})).code_hash,
      });
      console.log(JSON.stringify(result,null,2));
      process.exitCode = result.ok ? 0 : 1;
    } catch {
      console.error("The resolution proof could not be read.");
      process.exitCode = 2;
    }
  }
}
