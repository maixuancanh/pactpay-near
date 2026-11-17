import workshopProofUrl from "../../../docs/near/testnet-workshop-ai-proof.json?url";
import {useState} from "react";
import type {FormEvent} from "react";
import {publicResolutionProof} from "./proof";
import {verifyPrivateFields} from "./verify-private";
import {summarizeCaseChecks} from "./case-model";
import type {VerificationCheck} from "./case-model";
import "../near.css";
import "../../commerce/commerce.css";
import "../../commerce/portal-theme.css";

type Check = VerificationCheck;
const labels:Record<string,string> = {
  proofIdentity:"Testnet and escrow",agreementDigest:"Signed agreement digest",bilateralApproval:"Approval by both wallets",
  contractVersionAndCode:"Contract version and code hash",claimPayments:"Finalized payouts",evidenceSnapshot:"Private evidence snapshot",
  privateTermsCommitment:"Private terms",evidencePlaintext:"Private evidence contents",
  evidenceSource:"Evidence source",aiTranscript:"Signed AI transcript",aiAttestationNonce:"Attestation challenge",aiPlaintextBinding:"AI plaintext binding",
};

const caseCheckNames = {
  commitment:"evidenceSnapshot",source:"evidenceSource",encryptedTranscript:"aiTranscript",
  plaintextBinding:"aiPlaintextBinding",approval:"bilateralApproval",payout:"claimPayments",
} as const;

function displayChecks(remote: Check[], local: Check[]): Check[] {
  const byName = new Map(remote.map(check=>[check.name,check]));
  for (const check of local) byName.set(check.name,check);
  const summary = summarizeCaseChecks([...byName.values()]);
  for (const key of Object.keys(caseCheckNames) as (keyof typeof caseCheckNames)[]) {
    const name = caseCheckNames[key];
    const result = summary[key];
    if (!byName.has(name)) byName.set(name,{
      name,status:"Unavailable",reason:result.reason,
      detail:"This check could not be completed with the material in this proof.",
    });
  }
  return [...byName.values()];
}

export default function VerifyPage(){
  const [payouts, setPayouts] = useState<{id:string;hash:string;amount:string}[]>([]);
  const [checks,setChecks]=useState<Check[]>([]);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const [mode, setMode] = useState<"workshop" | "sample" | "modified" | "upload">("workshop");
  async function verify(nextMode: typeof mode, event?:FormEvent<HTMLFormElement>){
    event?.preventDefault();
    const file=event ? new FormData(event.currentTarget).get("proof") : null;
    setPayouts([]);setChecks([]);setError("");setBusy(true);setMode(nextMode);
    try{
      if(event && (!(file instanceof File) || !file.size || file.size>4_000_000))throw Error("Select a PactPay proof JSON file.");
      let source: string;
      if (file instanceof File) {
        source = await file.text();
      } else {
        const sample = await fetch(nextMode === "workshop" ? workshopProofUrl : "/pactpay-v2-sample-proof.json", {
          signal:AbortSignal.timeout(10000),
        });
        if (!sample.ok) throw Error("The sample proof could not be loaded.");
        source = await sample.text();
      }
      const {codeHash,proposal,digest,receipts,authorized}=JSON.parse(source);
      if (nextMode === "modified") proposal.immediateMerchant = "13";
      const proof=publicResolutionProof({codeHash,proposal,digest,receipts});
      const response=await fetch("/api/near-verify",{method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify(proof),
        signal:AbortSignal.timeout(25000)});
      const result=await response.json();
      if(!response.ok || !Array.isArray(result.checks))throw Error(result.error || "Verification is unavailable.");
      const local=authorized && result.checks.some((check:Check)=>check.name==="bilateralApproval" && check.status==="Passed") &&
        result.checks.some((check:Check)=>check.name==="agreementDigest" && check.status==="Passed")
        ? await verifyPrivateFields({...proof,authorized}) : [];
      setPayouts(Array.isArray(result.verifiedClaims) ? result.verifiedClaims : []);
      setChecks(displayChecks(result.checks,local));
    }catch(err){setError(err instanceof Error ? err.message : "Unable to verify.");}
    finally{setBusy(false);}
  }
  return <main className="pt-marketing near-landing-details">
    <section className="pt-section pp-panel">
      <a href="/">PactPay home</a>
      <h1>Verify a Resolution Agreement</h1>
      <p>Check public transactions on NEAR Testnet. Private excerpts and their decryption keys stay in your browser.</p>
      <section aria-labelledby="workshop-demo-title">
        <h2 id="workshop-demo-title">Try a workshop dispute</h2>
        <p>Booking #5 links synthetic workshop evidence to a signed NEAR AI Cloud transcript and two finalized Testnet payouts. No wallet is needed.</p>
        <div className="near-verify-actions">
          <button type="button" className="pp-primary" disabled={busy} onClick={()=>void verify("workshop")}>Verify Booking #5</button>
          <button type="button" className="pp-secondary" disabled={busy} onClick={()=>void verify("modified")}>Check a modified proof</button>
          <a href={workshopProofUrl} download="pactpay-booking-5-proof.json">Download Booking #5 proof</a>
        </div>
        <p>The modified example uses Booking #0 and checks whether a changed amount is rejected.</p>
        <button type="button" className="pp-secondary" disabled={busy} onClick={()=>void verify("sample")}>Verify original Booking #0</button>
        <p>Booking #2 is the separate two-wallet demo. It shows how the buyer and merchant agreed to release 12 PDEMO and hold 8 until the buyer confirmed the fix.</p>
        <a href="/booking?booking=2&escrow=escrow-v2.pactpay-530c506b.testnet">Open Booking #2</a>
      </section>
      <section aria-labelledby="privacy-boundary-title">
        <h2 id="privacy-boundary-title">Who can see the evidence?</h2>
        <p>NEAR records wallet addresses, amounts and commitments. The buyer and merchant can open the excerpts shared with them. When a participant requests an assessment, PactPay encrypts the selected excerpts and terms for NEAR AI Cloud. The assessment cannot release funds.</p>
        <p>Booking #5 includes copies of synthetic evidence and the keys for those excerpts. When you load your own export, the browser sends only the public agreement to the verification API.</p>
      </section>
      <h2>Check your own proof</h2>
      <form className="pp-form" onSubmit={event=>void verify("upload", event)}>
        <label>Agreement proof<input name="proof" type="file" accept=".json,application/json" required/></label>
        <button className="pp-primary" disabled={busy}>{busy ? "Checking…" : "Verify agreement"}</button>
      </form>
      {mode === "modified" && <p>Sample changes the immediate merchant payout from 12 to 13 PDEMO. The verifier checks it against the original agreement. This test sends no transaction.</p>}
      {checks.length > 0 && <h2>{mode === "workshop" ? "Booking #5 results" : mode === "modified" ? "Modified proof results" : "Verification results"}</h2>}
      {payouts.length > 0 && <ul aria-label="Finalized payout transactions">{payouts.map(({id,hash,amount})=>
        <li key={id}><a href={"https://testnet.nearblocks.io/txns/"+encodeURIComponent(hash)} target="_blank" rel="noreferrer">
          View {amount} PDEMO payout on NEAR
        </a></li>)}</ul>}
      {busy && <p role="status">Checking proof…</p>}
      {error && <p role="alert">{error}</p>}
      {checks.length>0 && <ul aria-live="polite">{checks.map(check=><li key={check.name}>
        <strong>{labels[check.name] ?? check.name}</strong> · {check.status}
        {check.detail && <p>{check.detail}</p>}
      </li>)}</ul>}
    </section>
  </main>;
}
