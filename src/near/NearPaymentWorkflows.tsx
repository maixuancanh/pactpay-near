import {v2Escrow} from "./agreements/chain-v2";
import {useState} from "react";
import {ArrowRight} from "lucide-react";

const paths = [
  {
    label: "Merchant payout",
    trigger: "Buyer confirms completion, or 48 hours pass after the service ends without a dispute.",
    result: "The merchant claims the full share.",
    art: "control-outcome",
  },
  {
    label: "Buyer refund",
    trigger: "Funding falls short at the deadline, or the merchant misses capture before the service ends.",
    result: "The buyer can settle and claim their contribution back.",
    art: "feature-refund",
  },
  {
    label: "Disputed share",
    trigger: "The buyer opens a dispute within 48 hours after the service ends.",
    result: "Both wallets can approve an immediate payout and keep the rest in escrow. The signed agreement sets the split if the review deadline passes.",
    art: "private-dispute",
  },
];

const stages = [
  {label:"Fund", summary:"Three buyers deposit 20 PDEMO each. The merchant captures the booking after all shares are funded.", amounts:[60,0,0], status:["In escrow","In escrow","In escrow"]},
  {label:"Confirm or dispute", summary:"Two buyers confirm completion. Their 40 PDEMO becomes claimable while the third buyer’s 20 PDEMO remains in escrow.", amounts:[20,40,0], status:["Merchant payout","Merchant payout","Disputed"]},
  {label:"Pay 12, hold 8", summary:"Both parties sign. The merchant claims 12 PDEMO from the disputed share. Another 8 stays in escrow until the follow-up is reviewed.", amounts:[8,52,0], status:["Merchant payout","Merchant payout","12 released � 8 held"]},
  {label:"Confirm the follow-up", summary:"The buyer confirms the follow-up workshop. After claiming the last 8 PDEMO, the merchant has received all 60. If review expires, the signed deadline split applies instead.", amounts:[0,60,0], status:["Paid to merchant","Paid to merchant","Follow-up confirmed"]},
];

function Art({name}: {name:string}) {
  return <img src={`/art/pactpay/${name}.webp`} alt="" width="120" height="100" loading="lazy" />;
}

export function PaymentOutcomes() {
  const [selected, select] = useState(0);
  const path = paths[selected];
  return <section className="pt-section" aria-labelledby="near-outcomes-title">
    <div className="pt-section-heading pt-centered">
      <h2 id="near-outcomes-title">When funds can be claimed</h2>
      <p>Choose a path to see what happens to one funded share.</p>
    </div>
    <div className="near-flow-switch" role="group" aria-label="Payment outcome">
      {paths.map(({label}, index) => <button type="button" key={label} aria-pressed={selected === index} onClick={() => select(index)}>{label}</button>)}
    </div>
    <div className="near-flow-board near-outcome-flow" aria-live="polite">
      <div className="near-flow-node"><Art name="feature-consent" /><strong>Held in escrow</strong></div>
      <ArrowRight className="near-flow-arrow" aria-hidden="true" />
      <div key={path.label} className="near-flow-node near-flow-enter">
        <Art name={path.art} /><h3>{path.label}</h3><p>{path.trigger}</p>
      </div>
      <ArrowRight className="near-flow-arrow" aria-hidden="true" />
      <div key={`claim-${path.label}`} className="near-flow-node near-flow-enter">
        <Art name="feature-receipt" /><strong>Claim with a wallet</strong><p>{path.result}</p>
      </div>
    </div>
  </section>;
}

export function WorkshopWorkflow() {
  const [step, setStep] = useState(0);
  const stage = stages[step];
  const destinations = ["Held in escrow", step === 3 ? "Merchant received" : "Merchant can claim", step === 3 ? "Buyer received" : "Buyer can claim"];
  return <section className="pt-section" aria-labelledby="near-example-title">
    <div className="pt-section-heading pt-centered">
      <h2 id="near-example-title">A workshop booking, split three ways</h2>
      <p>Follow an example booking from three 20 PDEMO contributions to a payout after a service dispute.</p>
    </div>
    <div className="near-flow-switch" role="group" aria-label="Workshop workflow step">
      {stages.map(({label}, index) => <button type="button" key={label} aria-pressed={step === index} onClick={() => setStep(index)}>{label}</button>)}
    </div>
    <div className="near-flow-board near-workshop-flow" aria-live="polite">
      <div className="near-flow-buyers">
        {["planner","maker","explorer"].map((person,index) => <div className="near-flow-buyer" key={person}>
          <img src={`/art/pactpay/avatar-${person}.webp`} alt="" width="44" height="44" loading="lazy" />
          <div><strong>Buyer {index+1} · 20 PDEMO</strong><span>{stage.status[index]}</span></div>
        </div>)}
      </div>
      <ArrowRight className="near-flow-arrow" aria-hidden="true" />
      <div className="near-flow-totals">
        {destinations.map((label,index) => <div className="near-flow-total" key={index}>
          <Art name={["feature-consent","control-outcome","feature-refund"][index]} />
          <div><span>{label}</span><strong key={`${step}-${index}`} className="near-flow-enter">{stage.amounts[index]} PDEMO</strong></div>
        </div>)}
      </div>
      <p className="near-flow-summary">{stage.summary}</p>
    </div>
    <div className="near-flow-actions">
      <button type="button" className="pp-secondary" onClick={() => setStep((step + 1) % stages.length)}>
        {step === stages.length - 1 ? "Replay example" : "Next step"}
      </button>
      <a href={v2Escrow ? `/booking?booking=0&escrow=${encodeURIComponent(v2Escrow)}` : "/booking"}>Open testnet booking <ArrowRight size={16} aria-hidden="true" /></a>
    </div>
  </section>;
}
