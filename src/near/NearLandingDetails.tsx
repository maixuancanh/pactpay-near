import {ChevronDown} from "lucide-react";
import {PaymentOutcomes, WorkshopWorkflow} from "./NearPaymentWorkflows";
import {AgreementStory, ProofStory, ReliabilityStory} from "./NearTrustStories";

const steps = [
  ["new-booking", "Create and invite", "Set each buyer’s share and the deadlines. Share an invite link or QR code, and send the exact terms privately."],
  ["step-agree", "Verify and fund your share", "Each buyer verifies and accepts the terms, then funds their share in PDEMO using a NEAR Testnet wallet."],
  ["control-outcome", "Confirm funding and settle", "Once every share is funded, the merchant confirms funding on-chain before the service ends. Afterward, each share follows its own payout, refund or dispute path."],
];

const questions = [
  ["How do I know what happens if the fix is late?",
    "Open the Agreement tab and compare the three outcomes before approving. The preview shows immediate allocations, what happens after confirmation and the split at the review deadline. Both parties sign those exact terms; a settlement transaction is still needed when the deadline passes."],
  ["Will running AI again change the payment?",
    "No. AI produces a review for you to inspect. Only the agreed contract actions change allocations. PactPay shows your remaining daily attempts and warns before repeating the same evidence. A failed provider request may still use an attempt; you can continue with a manual agreement."],
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
    "Yes. Social sign-in can create a booking with a NEAR Testnet MPC account. You review the transaction before approving it. You can also link an external wallet; private evidence uses a connected NEAR wallet. Always use the account listed on the booking."],
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
    <AgreementStory />
    <section className="pt-section near-private-dispute" aria-labelledby="near-dispute-title">
      <img src="/art/pactpay/evidence-review.svg" alt="An encrypted excerpt goes to an AI reviewer, followed by separate buyer and merchant approvals" width="460" height="410" loading="lazy" />
      <div className="pt-section-heading">
        <h2 id="near-dispute-title">Resolve a dispute with private evidence</h2>
        <p>The buyer and merchant can release the undisputed amount and hold the rest while the merchant fixes the issue. Both sides agree on what counts as completion, when the merchant must submit proof, and how to split the remaining funds if the review deadline passes.</p>
        <ul>
          <li>Extract text from PDFs or images on your device. Review and mask sensitive details before sharing an encrypted excerpt.</li>
          <li>Review NEAR AI Cloud findings beside the cited excerpts. View evidence opens the supporting text; missing support is labeled Insufficient evidence. AI cannot sign an agreement or release funds.</li>
          <li>See your AI attempt budget before running a review. Each account gets up to three attempts per share per UTC day, with a warning before repeating the same inputs.</li>
          <li>Preview the exact excerpts before exporting a private proof. For a public proof, the <a href="/verify">Verify page</a> checks wallet approvals and finalized payouts without requiring private excerpts.</li>
        </ul>
        <a className="pp-secondary" href="/verify">Try the workshop proof</a>
      </div>
    </section>
    <WorkshopWorkflow />
    <ProofStory />
    <ReliabilityStory />
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
