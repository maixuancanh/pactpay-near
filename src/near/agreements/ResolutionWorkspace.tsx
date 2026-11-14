import {useEffect, useState} from "react";
import type {FormEvent} from "react";
import type {Booking, Position} from "../chain";
import type {SignChallenge} from "../EvidencePanel";
import {agreementDigest} from "./canonical";
import {readResolution} from "./chain-v2";
import {validateAgreement} from "./policy";
import ResolutionEvidence from "./ResolutionEvidence";
import type {EvidenceEntry} from "./evidence-manifest";
import type {AgreementV2} from "./types";
import type {AssessmentCase} from "./assessment-digest.mjs";
import type {analyzeResolutionEvidence} from "../claimguard";
import ResolutionExport from "./ResolutionExport";
import type {ResolutionEvidenceOpening} from "./proof";

const splitFields = [
  ["immediateBuyer", "Buyer refund now"], ["immediateMerchant", "Merchant payout now"],
  ["retained", "Keep in escrow"], ["successBuyer", "Buyer refund after completion"],
  ["successMerchant", "Merchant payout after completion"], ["fallbackBuyer", "Buyer refund at deadline"],
  ["fallbackMerchant", "Merchant payout at deadline"],
] as const;

function saveDeadline(escrow:string,id:number,index:number,deadline:string) {
  const date=(value:Date)=>value.toISOString().replace(/[-:]/g,"").replace(/\.\d{3}Z$/,"Z");
  const url=new URL("/booking",location.origin);
  url.search=new URLSearchParams({booking:String(id),escrow}).toString();
  const start=new Date(Number(deadline)*1000);
  const calendar=["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//PactPay//Booking//EN","BEGIN:VEVENT",
    `UID:${escrow}-${id}-${index}-${deadline}@pactpay`,`DTSTAMP:${date(new Date())}`,
    `DTSTART:${date(start)}`,"SUMMARY:PactPay agreement deadline",`URL:${url.href}`,
    "BEGIN:VALARM","TRIGGER:-PT30M","ACTION:DISPLAY","DESCRIPTION:Review your PactPay booking","END:VALARM","END:VEVENT","END:VCALENDAR",""].join("\r\n");
  const file=URL.createObjectURL(new Blob([calendar],{type:"text/calendar"}));
  const link=document.createElement("a");
  link.href=file;link.download="pactpay-deadline.ics";link.click();
  setTimeout(()=>URL.revokeObjectURL(file),1000);
}

export default function ResolutionWorkspace({escrow, booking, position, id, index, token, account, time, enabled, claimOnly, send, sign, verifiedTerms}:{
  escrow:string; booking:Booking; position:Position; id:number; index:number; token:string;
  account:string; time:number; enabled:boolean; claimOnly:boolean; verifiedTerms:string;
  send:(method:string,args:Record<string,unknown>)=>Promise<void>; sign:SignChallenge;
}) {
  const [data, setData] = useState<Awaited<ReturnType<typeof readResolution>>>();
  const [snapshot, setSnapshot] = useState<{entries:EvidenceEntry[];evidenceRoot:string}>();
  const [historicalSnapshot,setHistoricalSnapshot] = useState<typeof snapshot | null>();
  const [selected, setSelected] = useState<Partial<Record<EvidenceEntry["kind"], EvidenceEntry>>>({});
  const [assessment, setAssessment] = useState<{result:Awaited<ReturnType<typeof analyzeResolutionEvidence>>;scope:AssessmentCase}>();
  const [includeAssessment, setIncludeAssessment] = useState(false);
  const [openings,setOpenings] = useState<ResolutionEvidenceOpening[]>([]);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [sourcePdf, setSourcePdf] = useState<{file:File;url:string}>();
  const [payoutLookupStatus, setPayoutLookupStatus] = useState("");
  const [samplePayouts, setSamplePayouts] = useState<Record<string,string>>({});
  async function linkPayoutProof(file: File) {
    setPayoutLookupStatus("Checking finalized transactions...");
    try {
      if (file.size > 24_000) throw new Error("Choose a public proof JSON file up to 24 KB.");
      const proof = JSON.parse(await file.text());
      if (Object.hasOwn(proof, "authorized") || proof.escrow !== escrow ||
          proof.proposal?.booking !== String(id) || proof.proposal?.position !== String(index) ||
          !data?.agreement?.digest || proof.digest !== data.agreement.digest) {
        throw new Error("Choose a public proof for this signed agreement.");
      }
      const response = await fetch("/api/near-verify", {
        method:"POST", headers:{"content-type":"application/json"},
        body:JSON.stringify(proof), signal:AbortSignal.timeout(25000),
      });
      const result = await response.json();
      if (!response.ok || !Array.isArray(result.verifiedClaims) ||
          !result.checks?.some((check:{name:string;status:string}) => check.name === "claimPayments" && check.status === "Passed")) {
        throw new Error("The proof does not verify the finalized payouts for this agreement.");
      }
      setSamplePayouts(Object.fromEntries(result.verifiedClaims.map(
        ({id,hash}:{id:string;hash:string}) => [id,hash])));
      setPayoutLookupStatus("Finalized payout links are ready.");
    } catch (error) {
      setPayoutLookupStatus(error instanceof Error ? error.message : "Unable to verify payout proof.");
    }
  }
  useEffect(() => () => { if (sourcePdf) URL.revokeObjectURL(sourcePdf.url); }, [sourcePdf]);
  useEffect(() => {
    if (id !== 0 || index !== 0 || !data?.agreement?.digest) return;
    const controller = new AbortController();
    const {signal} = controller;
    void (async () => {
      const sample = await fetch("/pactpay-v2-sample-proof.json", {signal});
      if (!sample.ok) return;
      const proof = await sample.json();
      if (proof.escrow !== escrow || proof.digest !== data?.agreement?.digest) return;
      const response = await fetch("/api/near-verify", {
        method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(proof), signal,
      });
      if (!response.ok) return;
      const result = await response.json();
      if (!signal.aborted && Array.isArray(result.verifiedClaims)) {
        setSamplePayouts(Object.fromEntries(result.verifiedClaims.map(
          ({id,hash}:{id:string;hash:string}) => [id,hash])));
      }
    })().catch(() => {});
    return () => controller.abort();
  }, [escrow,id,index,data?.agreement?.digest]);
  useEffect(() => {
    let active = true;
    void readResolution(escrow,id,index).then(result => {
      if (active) {setData(result); setError("");}
    }).catch(() => {if (active) {setData(undefined); setError("Unable to read the finalized escrow state.");}});
    return () => {active = false;};
  }, [escrow,id,index,time,position]);
  async function run(task:()=>Promise<void>) {
    setWorking(true);
    setError("");
    try {
      await task();
      setData(await readResolution(escrow,id,index));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update the agreement.");
    } finally {setWorking(false);}
  }
  const buyer = account === position.buyer;
  const merchant = account === booking.merchant;
  const agreement = data?.agreement;
  const p = agreement?.proposal;
  const args = {version:p?.version};
  const open = agreement?.status === "Active" || agreement?.status === "CompletionSubmitted";
  const proposed = agreement?.status === "Proposed" && p && BigInt(p.acceptBy) > BigInt(time);
  const locked = !enabled || working || !data;
  const signedSnapshot = snapshot?.evidenceRoot === p?.evidenceRoot ? snapshot
    : historicalSnapshot?.evidenceRoot === p?.evidenceRoot ? historicalSnapshot : undefined;
  const hasReviewedTerms = signedSnapshot?.entries.some(entry =>
    entry.entryHash === selected.agreement_terms?.entryHash && entry.ciphertextHash === p?.privateTermsCommitment);
  const canPropose = (buyer || merchant) && position.dispute_until && time < Number(position.dispute_until)
    && !position.has_allocation && (!agreement || agreement.status === "Proposed" || agreement.status === "Expired");
  const nextVersion = String(BigInt(position.proposal_version)+1n);
  const currentAssessment = assessment?.scope.evidenceRoot === snapshot?.evidenceRoot &&
    assessment?.scope.version === nextVersion ? assessment?.result : undefined;
  const boundAssessment = p?.assessmentDigest === assessment?.result.digest ? assessment?.result : undefined;
  const displayedAssessment = currentAssessment ?? boundAssessment;
  const deadline = p && (proposed ? p.acceptBy : agreement?.status === "Active" && time < Number(p.deliverBy) ? p.deliverBy : open ? p.reviewUntil : undefined);
  const nextAction = !account ? "Connect your wallet to act." :
    data?.claims.some(claim=>claim.recipient===account && claim.status==="Available") ? "Claim your available payout or refund below." :
    proposed && (buyer || merchant) ? agreement.approvals & (buyer ? 1 : 2) ? "Waiting for the other party to sign." : "Open the private agreement terms, then review and sign." :
    open && p && time >= Number(p.reviewUntil) ? "Apply the signed deadline split." :
    agreement?.status === "Active" ? merchant ? "Upload and submit completion evidence by the delivery deadline." : "Waiting for the merchant to submit completion evidence." :
    agreement?.status === "CompletionSubmitted" ? buyer ? "Review the merchant’s evidence. Confirm completion or record an objection." : "Waiting for the buyer to review completion." :
    canPropose ? "Share and commit the evidence, then propose a split." : null;
  const objection = selected.evidence?.author===account ? selected.evidence : undefined;

  function propose(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run(async () => {
      const evidenceRoot = snapshot?.evidenceRoot;
      const privateTerms = selected.agreement_terms;
      if (!evidenceRoot || !privateTerms || !snapshot?.entries.some(entry => entry.entryHash === privateTerms.entryHash)) {
        throw new Error("Upload and select the encrypted agreement terms first.");
      }
      if (evidenceRoot !== position.evidence_commitment) throw new Error("Commit the reviewed evidence snapshot before proposing.");
      const identity = {
        network:"testnet" as const, escrow, booking:String(id), position:String(index),
        version:nextVersion, buyer:position.buyer,
        merchant:booking.merchant, token, termsCommitment:booking.terms_commitment,
      };
      const amount = (name:string) => String(form.get(name) ?? "");
      const seconds = (name:string) => String(Math.floor(new Date(amount(name)).getTime()/1000));
      const proposal:AgreementV2 = {
        ...identity, schema:"pactpay.resolution.v2", evidenceRoot,
        privateTermsCommitment:privateTerms.ciphertextHash, assessmentDigest:includeAssessment ? currentAssessment?.digest ?? null : null,
        immediateBuyer:amount("immediateBuyer"), immediateMerchant:amount("immediateMerchant"), retained:amount("retained"),
        successBuyer:amount("successBuyer"), successMerchant:amount("successMerchant"),
        fallbackBuyer:amount("fallbackBuyer"), fallbackMerchant:amount("fallbackMerchant"),
        acceptBy:seconds("acceptBy"), deliverBy:seconds("deliverBy"), reviewUntil:seconds("reviewUntil"),
        salt:Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,"0")).join(""),
      };
      validateAgreement(proposal,identity,position.share,String(time),position.dispute_until ?? "0");
      if (window.confirm("Sign these amounts and the deadline split shown in the form?")) await send("propose_agreement",{proposal});
    });
  }
  return <section className="near-evidence">
    <h4>{claimOnly ? "Claims" : "Resolution agreement"}</h4>
    {!claimOnly && nextAction && <div className="pp-note">
      <div><strong>What to do next</strong><p>{nextAction}</p>
        {deadline && <><p>Deadline <time dateTime={new Date(Number(deadline)*1000).toISOString()}>{new Date(Number(deadline)*1000).toLocaleString()}</time></p>
          <button type="button" className="pp-secondary" onClick={()=>saveDeadline(escrow,id,index,deadline)}>Add deadline to calendar</button></>}
      </div>
    </div>}
    {error && <p role="alert">{error}</p>}
    {data && <div className="near-summary">
      {(["funded","unallocated","retained","available","pending","paid"] as const).map(key =>
        <div key={key}><span>{key === "paid" ? "Received" : key}</span><strong>{data.ledger[key]} PDEMO</strong></div>)}
    </div>}
    {!claimOnly && data && data.ledger.retained !== "0" && <p className="pp-note">
      <strong>{data.ledger.retained} PDEMO held in escrow.</strong> The buyer can confirm completion after the merchant submits evidence. After the review deadline, either party can apply the signed deadline split.
    </p>}
    {data?.claims.map(claim => <div key={claim.claim_id}>
      <p>{claim.amount} PDEMO · {claim.recipient} · {claim.status === "Paid" ? "Received" : claim.status === "Pending" ? "Transfer pending" : "Available to claim"}</p>
      {claim.status === "Paid" && samplePayouts[claim.claim_id] && <a
        href={"https://testnet.nearblocks.io/txns/"+encodeURIComponent(samplePayouts[claim.claim_id])}
        target="_blank" rel="noreferrer">View finalized payout on NEAR</a>}
      {(claim.status === "Available" || data.retryable.includes(claim.claim_id)) && claim.recipient === account &&
        <button className="pp-primary" disabled={locked}
          onClick={()=>void run(()=>send(data.retryEnabled ? "claim_retryable_v2" : "claim_v2",{claim_id:claim.claim_id}))}>
          {claim.status==="Pending" ? "Retry payout" : `Claim ${claim.amount} PDEMO`}
        </button>}
    </div>)}
    {data?.agreement && data.claims.some(claim => claim.status === "Paid" && !samplePayouts[claim.claim_id]) && <div className="pp-form">
      <label>Show finalized payout links
        <input type="file" accept=".json,application/json" onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void linkPayoutProof(file);
        }} />
      </label>
      <p>Choose the public proof for this agreement. Verified transaction links appear beside their payouts.</p>
      <p role="status">{payoutLookupStatus}</p>
    </div>}
    {!claimOnly && position.dispute_until && (buyer || merchant) && <ResolutionEvidence account={account} escrow={escrow}
      booking={String(id)} position={index} sign={sign} onSnapshot={setSnapshot}
      historicalRoot={p?.evidenceRoot} onHistoricalSnapshot={setHistoricalSnapshot}
      verifiedTerms={verifiedTerms} assessmentCase={canPropose ? {
        network:"testnet",escrow,booking:String(id),position:String(index),version:nextVersion,
        termsCommitment:booking.terms_commitment,
      } : undefined}
      onAnalysis={(result,scope)=>{setAssessment({result,scope});setIncludeAssessment(false);}}
      onOpen={({entry,item,text,excerptKey})=>setOpenings(previous=>[
        ...previous.filter(opening=>opening.entryHash!==entry.entryHash),
        {entryHash:entry.entryHash,iv:item.iv,ciphertext:item.ciphertext,text,excerptKey},
      ])}
      onSelect={entry=>setSelected(previous=>({...previous,[entry.kind]:entry}))}/>}
    {!claimOnly && displayedAssessment && (() => {
      const result = displayedAssessment;
      const groups = [["Findings", result.assessment.claims], ["Conflicting claims", result.assessment.conflictingClaims]] as const;
      return <section className="near-evidence">
        <h4>AI assessment</h4>
        <p>{result.transcriptStatus === "encrypted-transcript-verified" ? "Encrypted transcript signature verified." : "Transcript verification unavailable."} Review the evidence before signing.</p>
        <label>Open a source PDF from this device
          <input type="file" accept=".pdf,application/pdf" onChange={event => {
            const file = event.currentTarget.files?.[0];
            setSourcePdf(file && /\.pdf$/i.test(file.name)
              ? {file,url:URL.createObjectURL(new Blob([file],{type:"application/pdf"}))} : undefined);
          }} />
        </label>
        {sourcePdf && <p>Selected local PDF: {sourcePdf.file.name}. Use the original document for the cited excerpt.</p>}
        {groups.map(([label, findings]) => findings.length > 0 && <div key={label}>
          <h5>{label}</h5>
          <ul>{findings.map((finding, index) => <li key={index}>
            <p>{finding.text}</p>
            {!finding.supported && <p>Insufficient evidence to support this finding.</p>}
            {finding.citations.filter(citation => citation.supported).map((citation, index) => {
                const source = openings.find(opening => opening.entryHash === citation.sourceId);
                const paragraph = source?.text.split(/\r?\n\s*\r?\n/).filter(text => text.trim())[citation.paragraph - 1];
                const page = /^Page (\d+)\b/.exec(paragraph ?? "")?.[1];
                const label = page ? "page " + page : "paragraph " + citation.paragraph;
                return <details key={index}><summary>View evidence ({label})</summary>
                  {page && sourcePdf && <a href={sourcePdf.url+"#page="+page} target="_blank" rel="noreferrer">Open local PDF at page {page}</a>}
                  <blockquote style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{paragraph ?? citation.excerpt}</blockquote>
                </details>;
              })}
          </li>)}</ul>
        </div>)}
        {result.assessment.missingFacts.length > 0 && <><h5>Missing information</h5>
          <ul>{result.assessment.missingFacts.map((fact, index) => <li key={index}>{fact}</li>)}</ul></>}
        {result.assessment.suggestedRemedy && <p>Suggested follow-up: {result.assessment.suggestedRemedy}</p>}
      </section>;
    })()}
    {!claimOnly && canPropose && <form className="pp-form" onSubmit={propose}>
      <p>Amounts are in the token’s smallest unit. Both parties sign the completion and deadline splits.</p>
      {currentAssessment && <label><input type="checkbox" checked={includeAssessment}
        onChange={event=>setIncludeAssessment(event.target.checked)}/> Include the AI assessment digest</label>}
      {snapshot && snapshot.evidenceRoot !== position.evidence_commitment && <button type="button" className="pp-secondary" disabled={locked}
        onClick={()=>void run(()=>send("revise_evidence",{commitment:snapshot.evidenceRoot}))}>Commit evidence snapshot</button>}
      <div className="near-grid">{splitFields.map(([key,label])=><label key={key}>{label}
        <input name={key} inputMode="numeric" pattern="[0-9]+" defaultValue="0" required/></label>)}</div>
      <div className="near-grid">{([["acceptBy","Sign by"],["deliverBy","Complete work by"],["reviewUntil","Review by"]] as const).map(([key,label])=>
        <label key={key}>{label}<input type="datetime-local" name={key} required/></label>)}</div>
      <button className="pp-primary" disabled={locked}>Propose and sign</button>
    </form>}
    {p && agreement && <div>
      <h4>Version {p.version} · {agreement.status}</h4>
      <p>Agree by {new Date(Number(p.acceptBy)*1000).toLocaleString()}. Complete by {new Date(Number(p.deliverBy)*1000).toLocaleString()}. Review by {new Date(Number(p.reviewUntil)*1000).toLocaleString()}.</p>
      <dl>{splitFields.map(([key,label])=><div key={key}><dt>{label}</dt><dd>{p[key]}</dd></div>)}</dl>
      <p>Buyer <code>{p.buyer}</code> · Merchant <code>{p.merchant}</code></p>
      <p>Signed evidence snapshot <code>{p.evidenceRoot}</code></p>
      {!claimOnly && proposed && (buyer || merchant) && !(agreement.approvals & (buyer ? 1 : 2)) &&
        <button className="pp-primary" disabled={locked || !hasReviewedTerms}
          onClick={()=>void run(async()=>{
            if (await agreementDigest(p) !== agreement.digest) throw new Error("Proposal digest does not match.");
            if (window.confirm("Accept the displayed payment and deadline splits?")) await send("approve_agreement",{...args,digest:agreement.digest});
          })}>Accept reviewed agreement</button>}
      {!claimOnly && agreement.status === "Active" && merchant && time < Number(p.deliverBy) &&
        <button className="pp-secondary" disabled={locked || !selected.completion}
          onClick={()=>void run(()=>send("submit_completion",{...args,evidence_root:selected.completion?.entryHash}))}>Submit selected completion evidence</button>}
      {!claimOnly && agreement.status === "CompletionSubmitted" && buyer && time < Number(p.reviewUntil) &&
        <button className="pp-primary" disabled={locked || selected.completion?.entryHash !== agreement.completion_evidence_root}
          onClick={()=>{if(window.confirm("Confirm completion and allocate the retained funds?"))
            void run(()=>send("confirm_agreement_completion",{...args,digest:agreement.digest}));}}>Confirm completion</button>}
      {open && time >= Number(p.reviewUntil) && account && <button className="pp-secondary" disabled={locked}
        onClick={()=>void run(()=>send("settle_agreement",args))}>Apply the signed deadline split</button>}
      {!claimOnly && agreement.objection_evidence_root && <p>Buyer objection recorded <code>{agreement.objection_evidence_root}</code></p>}
      {!claimOnly && agreement.status === "CompletionSubmitted" && buyer && time < Number(p.reviewUntil) && <>
        <p>To object, upload and select your evidence. An objection leaves the signed deadline split in place.</p>
        <button className="pp-secondary" disabled={locked || !objection || objection.entryHash===agreement.objection_evidence_root}
          onClick={()=>void run(()=>send("object_agreement",{...args,evidence_root:objection?.entryHash}))}>Record objection</button>
      </>}
      {!claimOnly && <ResolutionExport agreement={agreement} snapshot={signedSnapshot ?? undefined} openings={openings} account={account}
        assessment={boundAssessment && {...boundAssessment.proof,id:boundAssessment.id,model:boundAssessment.model,
          promptVersion:boundAssessment.promptVersion,inputHash:boundAssessment.inputHash,outputHash:boundAssessment.outputHash}}/>}
    </div>}
  </section>;
}
