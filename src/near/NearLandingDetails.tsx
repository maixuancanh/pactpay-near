import {ChevronDown} from "lucide-react";
import {PaymentOutcomes, WorkshopWorkflow} from "./NearPaymentWorkflows";

const steps = [
  ["new-booking", "Create the booking", "The merchant sets each buyer’s share, the funding deadline and the service end time, then shares the exact terms privately."],
  ["step-agree", "Verify and fund your share", "Each buyer verifies and accepts the terms, then funds their share in PDEMO using a NEAR Testnet wallet."],
  ["control-outcome", "Confirm funding and settle", "Once every share is funded, the merchant confirms funding on-chain before the service ends. Afterward, each share follows its own payout, refund or dispute path."],
];

const questions = [
  ["Someone sent me a booking link. Where do I start?",
    "Open the shared link. If you received only a booking ID, enter it in the booking workspace and select Load booking. Check your share and the funding deadline. Connect the wallet address the organizer added to the booking, then ask them for the exact terms if you don’t have them yet."],
  ["Why can’t I accept the terms or contribute?",
    "Paste the exact terms from the organizer, including the private reference and line breaks, then select Verify terms. Accept the verified terms with your wallet before selecting Contribute. If the funding deadline has passed, ask the organizer whether there’s a new booking."],
  ["What do I need before I contribute?",
    "Connect a NEAR Testnet wallet with enough PDEMO to cover your share and testnet NEAR for the network fee. PDEMO is a demo token with no monetary value. Review the amount in your wallet before signing."],
  ["What if someone in the group doesn’t pay?",
    "If the group hasn’t funded every share by the funding deadline, buyers who contributed can get their shares back. You can also get your share back if the merchant doesn’t confirm funding before the service ends. Open the booking, select Apply settlement policy when it appears, then claim the refund with the wallet you used to contribute."],
  ["When can I receive my payout as the merchant?",
    "Once everyone has contributed, select Capture booking before the service ends. Afterward, each buyer’s share becomes claimable when they confirm completion or the 48-hour dispute period ends without a dispute. If you waited out that period, select Apply settlement policy before claiming the share."],
  ["The service wasn’t what we agreed to. What can I do?",
    "If the merchant captured the booking, select Open dispute within 48 hours after the service ends. Share the relevant part of your evidence with the merchant. You can agree to release part of your contribution and hold the rest while they fix the issue. If you sign that agreement, check its review deadline and the split you chose for when that deadline passes."],
  ["What happens if we can’t agree on a disputed payment?",
    "Check the resolution deadline in the booking. If it passes before you sign an agreement, you can apply the settlement policy and claim your disputed share back. If both sides already signed an agreement and the review deadline passes without confirmation, the split you signed for that deadline applies."],
  ["My payout or refund is available. Why isn’t it in my wallet?",
    "Open Claim payout or refund from your booking, connect the wallet listed as the recipient and select Claim. If your wallet hasn’t been registered to receive PDEMO, use Register to receive token first. If the transfer is pending, wait for the outcome before signing again. For a Resolution Agreement payout, use the public proof to check the finalized transaction."],
  ["Can I sign in with Google and use my wallet later?",
    "Yes. Google signs you into your PactPay profile. Link the NEAR Testnet wallet listed on your booking when you are ready to sign transactions or open private evidence."],
  ["How do I check what the AI found?",
    "Open View evidence under a finding to read the supporting excerpt. If the excerpt includes a page number, choose your local copy of the source PDF to open that page. PactPay labels findings with insufficient evidence. The buyer and merchant decide whether to sign the agreement."],
  ["How can I confirm a payout on NEAR?",
    "Open Verify with the public agreement proof, or load that proof inside the booking. After PactPay verifies the finalized payouts, you can open their transactions on NEAR."],
  ["Can I share just part of a document in a dispute?",
    "Yes. Review the excerpt and remove details the other party doesn’t need before sharing it. PactPay encrypts the excerpt before upload. Wallet addresses, amounts and payment status are visible on NEAR, so share the full booking terms privately."],
];

export default function NearLandingDetails() {
  return <div className="pt-marketing near-landing-details">
    <section className="pt-section near-private-dispute" id="why-pactpay" aria-labelledby="near-why-title">
      <img src="/art/pactpay/feature-shares.webp" alt="" width="360" height="280" loading="lazy" />
      <div className="pt-section-heading">
        <h2 id="near-why-title">One booking can have several payment outcomes</h2>
        <p>For a shared workshop, the organizer has to track who agreed to the terms, who paid and which receipts match each payment. If one participant disputes the service, the merchant still needs to close out everyone else’s share.</p>
        <p>PactPay records a fixed share for each buyer. NEAR escrow holds the contributions and tracks each share separately, so a dispute holds the affected share while eligible payouts can proceed.</p>
        <a className="pp-secondary" href="/judge.html">Try the judge walkthrough</a>
      </div>
    </section>
    <section className="pt-section" id="how-it-works" aria-labelledby="near-how-title">
      <div className="pt-section-heading pt-centered">
        <h2 id="near-how-title">How a group booking works</h2>
      </div>
      <ol className="pt-journey-track near-landing-steps">
        {steps.map(([art, title, description]) => <li className="pt-journey-stop" key={art}>
          <div className="pt-journey-art"><img src={`/art/pactpay/${art}.webp`} alt="" width="230" height="160" loading="lazy" /></div>
          <h3>{title}</h3><p>{description}</p>
        </li>)}
      </ol>
    </section>
    <PaymentOutcomes />
    <section className="pt-section near-private-dispute" aria-labelledby="near-dispute-title">
      <img src="/art/pactpay/private-dispute.webp" alt="" width="660" height="520" loading="lazy" />
      <div className="pt-section-heading">
        <h2 id="near-dispute-title">Resolve a dispute with private evidence</h2>
        <p>In Resolution Agreement V2, the buyer and merchant can release the undisputed amount and hold the rest while the merchant fixes the issue. Both sides agree on what counts as completion, when the merchant must submit proof, and how to split the remaining funds if the review deadline passes.</p>
        <ul>
          <li>Extract text from PDFs or images on your device. Review and mask sensitive details before sharing an encrypted excerpt.</li>
          <li>Review findings from NEAR AI against cited excerpts. Both parties sign the payment split, and the buyer can confirm the fix after reviewing completion evidence.</li>
          <li>Preview the exact excerpts before exporting a private proof. For a public proof, the <a href="/verify">Verify page</a> checks wallet approvals and finalized payouts without requiring private excerpts.</li>
        </ul>
        <a className="pp-secondary" href="/verify">Try the workshop proof</a>
      </div>
    </section>
    <WorkshopWorkflow />
    <section className="pt-section pt-faq" id="pt-faq" aria-labelledby="near-faq-title">
      <div className="pt-section-heading pt-centered">
        <h2 id="near-faq-title">Booking and payment <span className="pt-underline">questions.</span></h2>
      </div>
      <div className="pt-faq-list">
        {questions.map(([question, answer]) => <details key={question}>
          <summary>{question}<ChevronDown size={20} aria-hidden="true" /></summary>
          <p>{answer}</p>
        </details>)}
      </div>
    </section>
  </div>;
}
