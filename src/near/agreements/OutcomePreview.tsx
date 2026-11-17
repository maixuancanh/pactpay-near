import {useId, useState} from "react";
import type {AgreementRecord} from "./chain-v2";
import {previewAllocation, type OutcomeBranch} from "./outcome-preview";
import "./outcome-preview.css";

const branches = [["immediate", "Both parties agree"], ["success", "Remedy confirmed"],
  ["fallback", "Review deadline passes"]] as const;

function timestamp(value: string | number) {
  return new Date(Number(value) * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC");
}

export default function OutcomePreview({agreement, account, time}: {
  agreement: AgreementRecord; account: string; time: number;
}) {
  const [branch, setBranch] = useState<OutcomeBranch>("immediate");
  const panelId = useId();
  const p = agreement.proposal;
  const allocation = previewAllocation(p, branch);
  const closed = agreement.status === "Completed" || agreement.status === "FallbackAllocated";
  const expired = agreement.status === "Expired" ||
    (agreement.status === "Proposed" && BigInt(p.acceptBy) <= BigInt(time));
  return <section className="near-outcome-preview" aria-label="Agreement outcome forecast">
    <header><h5>Explore this agreement</h5><span className="pp-badge">Forecast · version {p.version}</span></header>
    <p>Choose a scenario to see the exact proposal amounts. Browsing does not sign or move funds.</p>
    <p className="near-outcome-context">Chain time: {timestamp(time)}<br/>
      Viewing as: <code>{account || "No wallet connected"}</code><br/>
      Current agreement: <strong>{agreement.status}</strong></p>
    {closed && <p className="near-outcome-state">{agreement.status === "Completed" ? "Completion was confirmed" : "The deadline split was applied"}.
      These scenarios are for reference; this agreement cannot be settled again. Check Payments for available, pending and received funds.</p>}
    {expired && <p className="near-outcome-state">This proposal has expired. Its scenarios are for reference; a new proposal must be reviewed before signing.</p>}
    <div className="near-outcome-choices" role="group" aria-label="Forecast scenario">
      {branches.map(([value, label]) => <button key={value} type="button" aria-pressed={branch === value}
        aria-controls={panelId} onClick={() => setBranch(value)}>{label}</button>)}
    </div>
    <div id={panelId} className="near-outcome-result" aria-live="polite" aria-atomic="true">
      <h5>{branches.find(([value]) => value === branch)?.[1]}</h5>
      {branch === "immediate" ? <p>Before {timestamp(p.acceptBy)}, the buyer and merchant must both approve the same proposal.
        The second approval allocates the immediate claims and keeps the retained amount in escrow.</p>
        : branch === "success" ? <p>Only <code>{p.merchant}</code> can submit completion evidence, before {timestamp(p.deliverBy)}.
          After submission, only <code>{p.buyer}</code> can confirm it, before {timestamp(p.reviewUntil)}.
          Confirmation allocates the retained funds as shown below.</p>
        : <p>At or after {timestamp(p.reviewUntil)}, if the agreement is still active or awaiting review,
          any account can send a settlement transaction to apply this signed split. Time passing alone does not release funds.
          A buyer objection does not change this split.</p>}
      <dl className="near-outcome-amounts">
        <div><dt>Buyer {branch === "immediate" ? "claim" : "additional claim"}</dt><dd>{allocation.buyer} <small>PDEMO</small></dd><dd><code>{p.buyer}</code></dd></div>
        <div><dt>Merchant {branch === "immediate" ? "claim" : "additional claim"}</dt><dd>{allocation.merchant} <small>PDEMO</small></dd><dd><code>{p.merchant}</code></dd></div>
        <div><dt>Remaining in escrow</dt><dd>{allocation.retained} <small>PDEMO</small></dd></div>
      </dl>
      <p>{branch !== "immediate" && "These amounts are in addition to the immediate allocation; the two retained-fund scenarios are alternatives. "}
        Only each recipient can claim their nonzero allocation in a separate transaction. Allocation does not mean payment has been received.</p>
    </div>
    <div className="near-outcome-context"><p>Token: <code>{p.token}</code></p><p>Digest: <code>{agreement.digest}</code></p>
      <p>Signing rechecks this proposal’s digest, version and expiry against fresh chain state.</p></div>
  </section>;
}
