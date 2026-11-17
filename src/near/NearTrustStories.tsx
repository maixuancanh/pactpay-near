import {useState} from "react";
import {ArrowRight, Check, LockKeyhole, ShieldCheck, X} from "lucide-react";
import {v2Escrow} from "./agreements/chain-v2";
import "./near-trust-stories.css";

export const workshopCase = `/booking?booking=5&escrow=${encodeURIComponent(v2Escrow || "escrow-v2.pactpay-530c506b.testnet")}`;
const outcomes = [
  {label:"Both sides agree",buyer:0,merchant:12,held:8,caption:"Both parties approve the same terms. The merchant can claim 12; 8 stays in escrow for the missing recording."},
  {label:"Buyer confirms the fix",buyer:0,merchant:20,held:0,caption:"The merchant supplies the recording and the buyer confirms it before the review deadline. The remaining 8 becomes claimable."},
  {label:"Review deadline passes",buyer:5,merchant:15,held:0,caption:"If the remedy is not confirmed in time, a settlement transaction applies this example’s signed fallback: 5 back to the buyer and 3 more to the merchant."},
];

export function AgreementStory() {
  const [selected,setSelected]=useState(0);
  const outcome=outcomes[selected];
  return <section className="pt-section" id="agreement-preview" aria-labelledby="agreement-story-title">
    <div className="pt-section-heading pt-centered"><span className="near-story-eyebrow">Know what you are signing</span>
      <h2 id="agreement-story-title">One agreement. Three clear outcomes.</h2>
      <p>Before you approve, see who can claim what now, after the fix, or after the deadline. Explore this 20 PDEMO workshop example.</p></div>
    <div className="near-story-sheet">
      <div className="near-story-top"><span>Illustrated example · 20 PDEMO</span><span><LockKeyhole size={16}/> No transaction is sent</span></div>
      <div className="near-flow-switch" role="group" aria-label="Explore agreement outcomes">
        {outcomes.map((item,i)=><button key={item.label} aria-pressed={i===selected} onClick={()=>setSelected(i)}>{item.label}</button>)}
      </div>
      <div className="near-story-allocation" aria-live="polite">
        <div className="near-story-person"><img src="/art/pactpay/avatar-planner.webp" alt="" width="88" height="88" loading="lazy"/><span>Buyer can claim</span><strong key={`b${selected}`} className="near-story-pop">{outcome.buyer}<small> PDEMO total</small></strong></div>
        <div className="near-story-vault"><img src="/art/pactpay/private-dispute.webp" alt="Locked escrow holding the retained part of the payment" width="190" height="150" loading="lazy"/><strong>{outcome.held} PDEMO held</strong><div className="near-story-coins" aria-label={`${outcome.merchant} allocated to merchant, ${outcome.buyer} to buyer, ${outcome.held} retained`}>{Array.from({length:20},(_,i)=><span key={i} className={i<outcome.merchant?"merchant":i<outcome.merchant+outcome.buyer?"buyer":"held"}/>)}</div><small>Each dot = 1 PDEMO</small></div>
        <div className="near-story-person"><img src="/art/pactpay/avatar-maker.webp" alt="" width="88" height="88" loading="lazy"/><span>Merchant can claim</span><strong key={`m${selected}`} className="near-story-pop">{outcome.merchant}<small> PDEMO total</small></strong></div>
        <p className="near-story-caption" key={selected}>{outcome.caption}</p>
      </div>
      <p className="near-story-note">Totals include the first 12 PDEMO allocation. Each recipient claims separately. A claimable amount is not yet a received payment.</p>
      <a className="pp-primary" href={workshopCase}>Explore the real workshop case <ArrowRight size={18}/></a>
    </div>
  </section>;
}

const proofStates = [
  {label:"Matching receipt",heading:"The payout checks match",description:"Check the recipient, amount and finalized NEAR transaction against the signed agreement.",amount:"12 PDEMO",icon:Check,tone:"match"},
  {label:"Changed amount",heading:"A changed amount is rejected",description:"Changing 12 to 13 in the exported agreement breaks its digest. The verifier identifies the check that failed.",amount:"13 PDEMO",icon:X,tone:"invalid"},
  {label:"Missing approval",heading:"Missing is not the same as false",description:"Without both approval references, the file is incomplete. It does not prove that the other party never approved.",amount:"Approval missing",icon:ShieldCheck,tone:"missing"},
];
export function ProofStory() {
  const [selected,setSelected]=useState(0);
  const state=proofStates[selected], Icon=state.icon;
  return <section className="pt-section" id="proof-checks" aria-labelledby="proof-story-title">
    <div className="pt-section-heading pt-centered"><span className="near-story-eyebrow">Follow the evidence</span><h2 id="proof-story-title">A receipt you can check yourself.</h2><p>Open the proof without a wallet. Follow the approvals and finalized payouts, or see which evidence still needs checking.</p></div>
    <div className="near-proof-story">
      <div className="near-proof-illustration"><img src="/art/pactpay/proof-inspector.svg" width="420" height="340" alt="A receipt and magnifying glass inspecting a signed payment" loading="lazy"/><div className={`near-proof-stamp ${state.tone}`} aria-live="polite"><Icon size={22}/>{state.amount}</div></div>
      <div><div className="near-flow-switch" role="group" aria-label="Receipt illustration">{proofStates.map((item,i)=><button key={item.label} aria-pressed={selected===i} onClick={()=>setSelected(i)}>{item.label}</button>)}</div>
        <div aria-live="polite"><h3>{state.heading}</h3><p>{state.description}</p></div>
        <p className="near-story-note">This illustration explains the checks. The live verifier runs seven altered-proof cases: amount, recipient, booking, evidence snapshot, approval, attestation nonce and duplicate payout receipt.</p>
        <a className="pp-primary" href="/verify">Run the proof checks <ArrowRight size={18}/></a>
      </div>
    </div>
  </section>;
}

export function ReliabilityStory() {
  return <section className="pt-section near-reliability-story" aria-labelledby="reliability-story-title">
    <div className="pt-section-heading"><h2 id="reliability-story-title">Keep track, even after an interruption.</h2><p>See when a payout is available, pending or received. Follow the transaction before trying again; history recovery is separate from sending money.</p></div>
    <ol className="near-status-track">{[["feature-consent","Available","Your allocation is ready to claim."],["feature-review","Pending","The transfer is being checked."],["feature-receipt","Received","A finalized receipt confirms payment."]].map(([art,title,body])=><li key={title}><img src={`/art/pactpay/${art}.webp`} width="100" height="90" alt="" loading="lazy"/><h3>{title}</h3><p>{body}</p></li>)}</ol>
    <p className="near-story-note">The replay tool rebuilds known history from finalized receipts without sending payments. Sandbox checks cover interrupted writes, duplicate events, funded-state upgrades and recovery after a lost payout callback.</p>
    <a className="pp-secondary" href="https://github.com/maixuancanh/pactpay-near/blob/feat/privacy-case-verification/docs/near/RELIABILITY-UPDATE.md" target="_blank" rel="noreferrer">Read the tests and measured costs <ArrowRight size={18}/></a>
  </section>;
}
