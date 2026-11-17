import {useState} from "react";
import {ArrowRight} from "lucide-react";
import {workshopCase} from "./NearTrustStories";

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
  {label:"Fund the booking", summary:"A buyer contributes 20 PDEMO. The merchant captures the funded workshop booking, then the buyer disputes the missing recording.", amounts:[20,0,0], status:["20 PDEMO funded"]},
  {label:"Review private evidence", summary:"The demo encrypts sample excerpts and checks the AI findings. The review alone releases nothing: all 20 PDEMO stays in escrow.", amounts:[20,0,0], status:["AI reviewed · funds still held"]},
  {label:"Agree: 12 now, 8 held", summary:"Both parties approve the same agreement. The merchant claims 12 PDEMO; 8 remains held while the recording is supplied and reviewed.", amounts:[8,12,0], status:["Both parties approved"]},
  {label:"Confirm and receive", summary:"The buyer confirms the remedy. The merchant claims the remaining 8 PDEMO. Booking #5 records both finalized payouts; the alternative deadline split was not used.", amounts:[0,20,0], status:["Remedy confirmed"]},
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
  const destinations = ["Held in escrow", "Merchant received", "Buyer received"];
  return <section className="pt-section" aria-labelledby="near-example-title">
    <div className="pt-section-heading pt-centered">
      <h2 id="near-example-title">From a missing recording to a resolved payment.</h2>
      <p>Follow Booking #5: a synthetic workshop dispute with real NEAR Testnet transactions. This illustration traces the completed case.</p>
    </div>
    <div className="near-flow-switch" role="group" aria-label="Workshop workflow step">
      {stages.map(({label}, index) => <button type="button" key={label} aria-pressed={step === index} onClick={() => setStep(index)}>{label}</button>)}
    </div>
    <div className="near-flow-board near-workshop-flow" aria-live="polite">
      <div className="near-flow-buyers">
        {["planner"].map((person,index) => <div className="near-flow-buyer" key={person}>
          <img src={`/art/pactpay/avatar-${person}.webp`} alt="" width="44" height="44" loading="lazy" />
          <div><strong>Workshop buyer · 20 PDEMO</strong><span>{stage.status[index]}</span></div>
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
      <a href={workshopCase}>Open Booking #5 <ArrowRight size={16} aria-hidden="true" /></a>
    </div>
  </section>;
}
