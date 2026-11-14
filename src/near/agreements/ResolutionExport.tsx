import {useState, type FormEvent} from "react";
import type {EvidenceEntry} from "./evidence-manifest";
import {authorizedResolutionProof, publicResolutionProof, type ResolutionEvidenceOpening, type ResolutionTransactionReference, type ResolutionTranscript} from "./proof";
import type {AgreementV2} from "./types";

interface ExportProps {
  agreement: {proposal: AgreementV2; digest: string};
  snapshot?: {entries: readonly EvidenceEntry[]; evidenceRoot: string};
  openings?: readonly ResolutionEvidenceOpening[];
  assessment?: ResolutionTranscript;
  account?: string;
}

const base58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const accountPattern = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;
const optionalRef = (hash: string, signer: string): ResolutionTransactionReference | undefined => {
  if (!hash && !signer) return undefined;
  if (!base58.test(hash) || signer.length < 2 || signer.length > 64 || !accountPattern.test(signer)) {
    throw new Error("Each receipt reference needs a transaction hash and its signer account.");
  }
  return {hash,signer};
};

function download(proof: object, name: string) {
  const objectUrl = URL.createObjectURL(new Blob([JSON.stringify(proof,null,2)], {type:"application/json"}));
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

export default function ResolutionExport(props: ExportProps) {
  const {proposal,digest} = props.agreement;
  return <ScopedExport key={JSON.stringify([proposal.escrow,proposal.booking,proposal.position,digest,props.account])} {...props}/>;
}

function ScopedExport({agreement,snapshot,openings=[],assessment,account}: ExportProps) {
  const [error,setError] = useState("");
  const [privateExport,setPrivateExport] = useState(false);
  const [selected,setSelected] = useState(new Set<string>());
  const [includeAssessment,setIncludeAssessment] = useState(false);
  const [consent,setConsent] = useState(false);
  const {proposal,digest} = agreement;
  const canRead = account === proposal.buyer || account === proposal.merchant;
  const signedSnapshot = canRead && snapshot?.evidenceRoot === proposal.evidenceRoot ? snapshot : undefined;
  const authorizedOpenings = openings.filter(opening => signedSnapshot?.entries.some(entry => entry.entryHash === opening.entryHash));
  const selectedOpenings = authorizedOpenings.filter(opening => selected.has(opening.entryHash));
  const canExportPrivate = Boolean(signedSnapshot);
  const showPrivate = privateExport && canExportPrivate;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    try {
      const fields = new FormData(event.currentTarget);
      const read = (field: string) => String(fields.get(field) ?? "").trim();
      let codeHash = read("codeHash");
      const proposalTx = optionalRef(read("proposalHash"),read("proposalSigner"));
      const approvalTx = optionalRef(read("approvalHash"),read("approvalSigner"));
      if (!codeHash && approvalTx) {
        const publicLookup = publicResolutionProof({proposal,digest,codeHash:"",receipts:{approval:approvalTx,claims:[]}});
        const response=await fetch("/api/near-verify",{method:"POST",headers:{"content-type":"application/json"},
          body:JSON.stringify({...publicLookup,codeHash:null}),signal:AbortSignal.timeout(25000)});
        const result=await response.json();
        if (!response.ok) throw new Error(result.error || "Approval block unavailable.");
        codeHash=result.codeHash;
      }
      if (!base58.test(codeHash)) throw new Error("Enter the approval transaction or the historical contract code hash.");
      const claims = read("claims").split(/\r?\n/).filter(line => line.trim()).map(line => {
        const fields = line.trim().split(/\s+/);
        const [hash,signer,reconciliation] = fields;
        if (fields.length < 2 || fields.length > 3) throw new Error("Enter the claim hash, signer and optional reconciliation hash.");
        return {...optionalRef(hash,signer)!,
          ...(reconciliation ? {reconciliation:optionalRef(reconciliation,proposal.escrow)!} : {})};
      });
      if (claims.length > 4) throw new Error("An agreement has a maximum of four payout receipts.");
      const publicProof = publicResolutionProof({proposal,digest,codeHash,receipts:{proposal:proposalTx,approval:approvalTx,claims}});
      const proof = showPrivate && signedSnapshot
        ? authorizedResolutionProof(publicProof,{
            manifest:[...signedSnapshot.entries],
            openings:selectedOpenings,
            transcript:includeAssessment ? assessment : undefined,
          },consent)
        : publicProof;
      download(proof,"pactpay-"+proposal.booking+"-"+proposal.position+"-v"+proposal.version+(showPrivate ? "-authorized.json" : "-public.json"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to export the agreement.");
    }
  }

  return <section>
    <h5>Export agreement proof</h5>
    <p>A public proof includes the signed payment terms, commitments and transaction references. A verifier also needs the signed evidence snapshot and complete receipts to check the full case.</p>
    <form className="pp-form" onSubmit={submit}>
      {error && <p role="alert">{error}</p>}
      <label>Contract code hash (optional with approval transaction)<input name="codeHash" autoComplete="off"/></label>
      <div className="near-grid">
        <label>Proposal transaction hash<input name="proposalHash" autoComplete="off"/></label>
        <label>Proposal signer<input name="proposalSigner" autoComplete="off"/></label>
        <label>Approval transaction hash<input name="approvalHash" autoComplete="off"/></label>
        <label>Approval signer<input name="approvalSigner" autoComplete="off"/></label>
      </div>
      <label>Claim receipts<textarea name="claims" rows={3}/></label>
      <p>Enter one claim hash and signer per line. For a reconciled claim, add the reconciliation transaction hash on the same line.</p>
      {canExportPrivate && <label>
        <input type="checkbox" checked={privateExport} onChange={event=>{setPrivateExport(event.target.checked); setConsent(false);}}/>
        Include authorized evidence
      </label>}
      {showPrivate && <fieldset>
        <legend>Review before sharing</legend>
        <p>The file includes the signed snapshot manifest. Each selected excerpt adds its readable text and decryption key. Anyone holding the file can read the included excerpts.</p>
        {authorizedOpenings.map(opening => {
          const entry = signedSnapshot?.entries.find(item => item.entryHash === opening.entryHash);
          return <div key={opening.entryHash}>
            <label>
              <input type="checkbox" checked={selected.has(opening.entryHash)} onChange={event=>{
                const checked = event.target.checked;
                setSelected(previous => {
                  const next = new Set(previous);
                  if (checked) next.add(opening.entryHash);
                  else next.delete(opening.entryHash);
                  return next;
                });
                setConsent(false);
              }}/>
              {entry?.kind === "agreement_terms" ? "Agreement terms" : "Evidence"} shared by {entry?.author}
            </label>

          </div>;
        })}
        {assessment && proposal.assessmentDigest && <label>
          <input type="checkbox" checked={includeAssessment} onChange={event=>{setIncludeAssessment(event.target.checked); setConsent(false);}}/>
          Include signed encrypted AI transcript
        </label>}
        <section aria-label="Private export preview">
          <h6>What the recipient can read</h6>
          {selectedOpenings.length ? selectedOpenings.map(opening =>
            <blockquote key={opening.entryHash} style={{whiteSpace:"pre-wrap", overflowWrap:"anywhere"}}>{opening.text}</blockquote>
          ) : <p>No readable excerpts selected. The file still includes the signed manifest.</p>}
          {includeAssessment && assessment && <p>The signed encrypted AI transcript is included.</p>}
        </section>
        <label><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/>
          I approve sharing this manifest and the selected materials.
        </label>
      </fieldset>}
      <button type="submit" className="pp-secondary" disabled={showPrivate && !consent}>
        Download {showPrivate ? "authorized" : "public"} proof
      </button>
    </form>
  </section>;
}
