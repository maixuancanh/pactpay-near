import * as Dialog from "@radix-ui/react-dialog";
import {copySourceReceipt} from "../../../lib/near-source-proof.mjs";
import type {SourceReceipt} from "../../../lib/near-source-proof.mjs";
import {useEffect, useState, type FormEvent} from "react";
import type {EvidenceEntry} from "./evidence-manifest";
import {authorizedResolutionProof, publicResolutionProof, type ResolutionEvidenceOpening, type ResolutionTransactionReference, type ResolutionTranscript} from "./proof";
import type {AgreementV2} from "./types";
import {readCaseHistory, type IndexedReference} from "./transaction-journal";

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
  const [receiptDraft,setReceiptDraft] = useState<Record<string,string>>({});
  const [open,setOpen] = useState(false);
  const [exporting,setExporting] = useState(false);
  const [error,setError] = useState("");
  const [privateExport,setPrivateExport] = useState(false);
  const [selected,setSelected] = useState(new Set<string>());
  const [includeAssessment,setIncludeAssessment] = useState(false);
  const [consent,setConsent] = useState(false);
  const {proposal,digest} = agreement;
  const [indexed,setIndexed] = useState<IndexedReference[]>([]);
  const [lookingUp,setLookingUp] = useState(false);
  const {escrow,booking,position,version} = proposal;
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    setIndexed([]);
    setLookingUp(true);
    let mounted = true;
    async function collectReferences() {
      let cursor: string | undefined;
      for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
        const page = await readCaseHistory({network:"testnet",escrow,booking,position,version},cursor,controller.signal);
        if (!mounted || controller.signal.aborted) return;
        setIndexed(current => [...current,...page.references]);
        if (!page.nextCursor || page.nextCursor === cursor) return;
        cursor = page.nextCursor;
      }
    }
    collectReferences().catch(() => { /* Manual recovery fields are still available. */ }).finally(() => {
      clearTimeout(timeout);
      if (mounted) setLookingUp(false);
    });
    return () => { mounted = false; clearTimeout(timeout); controller.abort(); };
  }, [open,escrow,booking,position,version]);
  const indexedProposal = indexed.find(item => item.kind === "proposal" && item.digest === digest);
  const indexedApproval = indexed.find(item => item.kind === "approval" && item.digest === digest);
  const toProofRef = (value?: IndexedReference) => value && ({hash:value.transactionHash,signer:value.signer});
  const canRead = account === proposal.buyer || account === proposal.merchant;
  const signedSnapshot = canRead && snapshot?.evidenceRoot === proposal.evidenceRoot ? snapshot : undefined;
  const authorizedOpenings = openings.filter(opening => signedSnapshot?.entries.some(entry => entry.entryHash === opening.entryHash));
  const selectedOpenings = authorizedOpenings.filter(opening => selected.has(opening.entryHash));
  const canExportPrivate = Boolean(signedSnapshot);
  const showPrivate = privateExport && canExportPrivate;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (exporting || lookingUp) return;
    setExporting(true);
    setError("");
    try {
      const fields = new FormData(event.currentTarget);
      const read = (field: string) => String(fields.get(field) ?? "").trim();
      let codeHash = read("codeHash");
      const proposalTx = optionalRef(read("proposalHash"),read("proposalSigner")) ?? toProofRef(indexedProposal);
      const approvalTx = optionalRef(read("approvalHash"),read("approvalSigner")) ?? toProofRef(indexedApproval);
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
      if (!claims.length) {
        const claimsById = new Map<string, ResolutionTransactionReference>();
        for (const item of indexed) {
          if (item.kind === "claim" && item.digest === digest && item.claimId) {
            claimsById.set(item.claimId, {hash:item.transactionHash,signer:item.signer});
          }
        }
        claims.push(...claimsById.values());
      }
      if (claims.length > 4) throw new Error("An agreement has a maximum of four payout receipts.");
      const publicProof = publicResolutionProof({proposal,digest,codeHash,receipts:{proposal:proposalTx,approval:approvalTx,claims}});
      const file = fields.get("sourceReceipt");
      let sourceReceipt:SourceReceipt|undefined;
      if (showPrivate && file instanceof File && file.size) {
        if (file.size > 8192) throw new Error("The signed delivery receipt is too large.");
        const receipt = copySourceReceipt(JSON.parse(await file.text()));
        const scope = receipt.payload.scope;
        if (scope.network !== proposal.network || scope.escrow !== escrow || scope.booking !== booking ||
            scope.position !== position || scope.version !== version || receipt.payload.recipient !== proposal.buyer) {
          throw new Error("The delivery receipt belongs to another agreement or recipient.");
        }
        if (!selectedOpenings.some(opening=>opening.entryHash===receipt.entryHash)) {
          throw new Error("Select the excerpt named by the delivery receipt.");
        }
        sourceReceipt = receipt;
      }
      const proof = showPrivate && signedSnapshot
        ? authorizedResolutionProof(publicProof,{
            manifest:[...signedSnapshot.entries],
            openings:selectedOpenings,
            transcript:includeAssessment ? assessment : undefined,
            sourceReceipt,
          },consent)
        : publicProof;
      download(proof,"pactpay-"+proposal.booking+"-"+proposal.position+"-v"+proposal.version+(showPrivate ? "-authorized.json" : "-public.json"));
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to export the agreement.");
    } finally {
      setExporting(false);
    }
  }

  return <section className="near-proof-card">
    <h4>Export agreement proof</h4>
    <p>Download the signed terms and transaction references as a JSON file.</p>
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild><button className="pp-primary" type="button">Prepare download</button></Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="pp-overlay" />
        <Dialog.Content className="near-proof-dialog">
          <header className="near-panel-heading">
            <Dialog.Title>Prepare agreement proof</Dialog.Title>
            <Dialog.Close asChild><button className="near-dialog-close" type="button">Close</button></Dialog.Close>
          </header>
          <Dialog.Description>Verified transaction references are included when available. You can enter a receipt manually to recover missing history.</Dialog.Description>
          {lookingUp ? <p role="status">Looking up verified transactions…</p> : indexedApproval && <p role="status">Verified approval found. You can leave the approval fields blank.</p>}
          <form className="pp-form" onSubmit={submit} onChange={event => {
            const field = event.target as HTMLInputElement | HTMLTextAreaElement;
            if (field.name && field.name !== "sourceReceipt") setReceiptDraft(previous => ({...previous, [field.name]:field.value}));
          }}>
            <fieldset className="near-proof-reference">
              <legend>Approval</legend>
              <label>Approval transaction hash<input name="approvalHash" defaultValue={receiptDraft.approvalHash} autoComplete="off"/></label>
              <label>Approval signer<input name="approvalSigner" defaultValue={receiptDraft.approvalSigner} autoComplete="off"/></label>
            </fieldset>
            <label>Historical contract code hash <span className="near-field-hint">Optional with approval transaction</span>
              <input name="codeHash" defaultValue={receiptDraft.codeHash} autoComplete="off"/></label>
            <fieldset className="near-proof-reference">
              <legend>Proposal</legend>
              <label>Proposal transaction hash<input name="proposalHash" defaultValue={receiptDraft.proposalHash} autoComplete="off"/></label>
              <label>Proposal signer<input name="proposalSigner" defaultValue={receiptDraft.proposalSigner} autoComplete="off"/></label>
            </fieldset>
            <label>Claim receipts<textarea name="claims" defaultValue={receiptDraft.claims} rows={3} aria-describedby="near-claim-receipt-format"/></label>
            <p id="near-claim-receipt-format">One transaction hash and signer per line. Add the reconciliation hash on the same line when applicable.</p>
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
        <label>Signed delivery receipt <span className="near-field-hint">Optional JSON from the delivery service</span>
          <input name="sourceReceipt" type="file" accept=".json,application/json" onChange={()=>setConsent(false)}/>
        </label>
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
      <button type="submit" className="pp-secondary" disabled={exporting || lookingUp || (showPrivate && !consent)}>
        {exporting ? "Preparing proof…" : showPrivate ? "Download authorized proof" : "Download public proof"}
      </button>
            {error && <p role="alert">{error}</p>}
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </section>;
}
