import {useState} from "react";
import type {FormEvent} from "react";
import {publicResolutionProof} from "./proof";
import {verifyPrivateFields} from "./verify-private";
import "../near.css";
import "../../commerce/commerce.css";
import "../../commerce/portal-theme.css";

type Check = {name:string; status:string; detail?:string};
const labels:Record<string,string> = {
  proofIdentity:"Testnet and escrow",agreementDigest:"Signed agreement digest",bilateralApproval:"Approval by both wallets",
  contractVersionAndCode:"Contract version and code hash",claimPayments:"Finalized payouts",evidenceSnapshot:"Private evidence snapshot",
  privateTermsCommitment:"Private terms",evidencePlaintext:"Private evidence contents",
  aiTranscript:"Signed AI transcript",aiPlaintextBinding:"AI plaintext binding",
};

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
      setChecks(result.checks.map((check:Check)=>local.find(item=>item.name===check.name)??check));
    }catch(err){setError(err instanceof Error ? err.message : "Unable to verify.");}
    finally{setBusy(false);}
  }
  return <main className="pt-marketing near-landing-details">
    <section className="pt-section pp-panel">
      <a href="/">PactPay home</a>
      <h1>Verify a Resolution Agreement</h1>
      <p>Check public transactions on NEAR Testnet. Private excerpts and their decryption keys stay in your browser.</p>
      <form className="pp-form" onSubmit={event=>void verify(event)}>
        <label>Agreement proof<input name="proof" type="file" accept=".json,application/json" required/></label>
        <button className="pp-primary" disabled={busy}>{busy ? "Checking…" : "Verify agreement"}</button>
      </form>
      <button type="button" className="pp-secondary" disabled={busy} onClick={()=>void verify()}>Verify sample booking</button>
      <button type="button" className="pp-secondary" disabled={busy} onClick={()=>void verify(undefined, true)}>Verify modified sample</button>
      {modifiedSample && <p>Sample booking with the immediate merchant payout changed from 12 to 13 PDEMO. The original signatures and transaction references are preserved.</p>}
      {payouts.length > 0 && <ul aria-label="Finalized payout transactions">{payouts.map(({id,hash,amount})=>
        <li key={id}><a href={"https://testnet.nearblocks.io/txns/"+encodeURIComponent(hash)} target="_blank" rel="noreferrer">
          View {amount} PDEMO payout on NEAR
        </a></li>)}</ul>}
      {error && <p role="alert">{error}</p>}
      {checks.length>0 && <ul aria-live="polite">{checks.map(check=><li key={check.name}>
        <strong>{labels[check.name] ?? check.name}</strong> · {check.status}
        {check.detail && <p>{check.detail}</p>}
      </li>)}</ul>}
    </section>
  </main>;
}
