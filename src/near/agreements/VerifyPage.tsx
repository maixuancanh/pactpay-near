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
  const [modifiedSample, setModifiedSample] = useState(false);
  async function verify(event?:FormEvent<HTMLFormElement>, tampered = false){
    event?.preventDefault();
    const file=event ? new FormData(event.currentTarget).get("proof") : null;
    setPayouts([]);setChecks([]);setError("");setBusy(true);setModifiedSample(tampered);
    try{
      if(event && (!(file instanceof File) || !file.size || file.size>4_000_000))throw Error("Select a PactPay proof JSON file.");
      const source = file instanceof File ? await file.text() : await (await fetch("/pactpay-v2-sample-proof.json")).text();
      const {codeHash,proposal,digest,receipts,authorized}=JSON.parse(source);
      if (tampered) proposal.immediateMerchant = "13";
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
        <p>Booking #0 is a scripted Testnet case. Check the two wallet approvals and the finalized payouts. No wallet is needed.</p>
        <div className="near-verify-actions">
          <button type="button" className="pp-primary" disabled={busy} onClick={()=>void verify()}>Verify sample booking</button>
          <button type="button" className="pp-secondary" disabled={busy} onClick={()=>void verify(undefined, true)}>Check a modified proof</button>
          <a href="/pactpay-v2-sample-proof.json" download>Download sample JSON</a>
        </div>
        <p>Booking #2 is the separate two-wallet demo. It shows how the buyer and merchant agreed to release 12 PDEMO and hold 8 until the buyer confirmed the fix.</p>
        <a href="/booking?booking=2&escrow=escrow-v2.pactpay-530c506b.testnet">Open Booking #2</a>
      </section>
      <section aria-labelledby="privacy-boundary-title">
        <h2 id="privacy-boundary-title">Who can see the evidence?</h2>
        <p>NEAR records wallet addresses, amounts and commitments. The buyer and merchant can open the excerpts shared with them. When a participant requests an assessment, PactPay encrypts the selected excerpts and terms for NEAR AI Cloud. The assessment cannot release funds.</p>
        <p>The public sample contains no AI transcript or private excerpts. To check a private export, load it below. The browser sends only the public agreement to the verification API.</p>
      </section>
      <h2>Check your own proof</h2>
      <form className="pp-form" onSubmit={event=>void verify(event)}>
        <label>Agreement proof<input name="proof" type="file" accept=".json,application/json" required/></label>
        <button className="pp-primary" disabled={busy}>{busy ? "Checking…" : "Verify agreement"}</button>
      </form>
      {modifiedSample && <p>Sample changes the immediate merchant payout from 12 to 13 PDEMO. The verifier checks it against the original agreement. This test sends no transaction.</p>}
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
