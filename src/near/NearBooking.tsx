import {useCallback, useEffect, useRef, useState} from "react";
import type {FormEvent} from "react";
import {NearConnector} from "@hot-labs/near-connect";
import {chainTime, commitment, DAY, escrow as legacyEscrow, finalizedBlock, finalTransaction, parseBookingId, rpcUrl, UnknownTransactionError, view} from "./chain";
import {v2Escrow} from "./agreements/chain-v2";
import {queueCaseReference, retryCaseReferences} from "./agreements/transaction-journal";
import ResolutionWorkspace from "./agreements/ResolutionWorkspace";
import type {Booking, Position, Remedy} from "./chain";
import {Wallet, ShieldCheck, ArrowRight, ArrowUpRight, UserRound, X, Search, Plus, FileText, Layers, CirclePlay, RefreshCw, Download} from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import {PortalHero, usePortalMotion} from "../commerce/PortalLanding";
import "../commerce/commerce.css";
import "../commerce/portal-theme.css";
import "../commerce/workspace-theme.css";
import EvidencePanel from "./EvidencePanel";
import IntentsQuote from "./IntentsQuote";
import NearLandingDetails from "./NearLandingDetails";
import {profileRequest, readSocialMpcAccount, signSocialBooking, useNearSocialLogin} from "./NearSocialLogin";
import {invitationUrl, needsInvitationReview, parseInvitation} from "./agreements/invitation";
import {ShareInvitation} from "./agreements/ShareInvitation";
import "./near.css";

let connector: NearConnector | undefined;
const walletConnector = () => connector ??= new NearConnector({
  network: "testnet", providers: {testnet: [rpcUrl]},
});
type Call = (receiver: string, method: string, args: Record<string, unknown>, deposit?: string) => Promise<string | undefined>;
type Attempt = {
  hash: string;
  sender: string;
  receiver: string;
  method: string;
  booking?: { fundingDeadline: number; termsCommitment: string };
};
const initialParams = new URLSearchParams(location.search);
const requestedEscrow = initialParams.get("escrow");
const initialBooking = initialParams.get("booking");
const resolutionV2 = Boolean(v2Escrow && requestedEscrow === v2Escrow && v2Escrow !== legacyEscrow);
const escrow = resolutionV2 ? v2Escrow : (!requestedEscrow || requestedEscrow === legacyEscrow ? legacyEscrow : "");
const claimPage = /^\/claim\/?$/.test(location.pathname);
const workspace = claimPage || /^\/booking\/?$/.test(location.pathname);
const sharedInvitation = (() => {
  try {
    return {scope: parseInvitation(initialParams, [legacyEscrow, v2Escrow]), error: ""};
  } catch {
    return {scope: null, error: "This booking invitation is invalid. Ask for a new link or look up the booking by ID."};
  }
})();

function workspaceLink(path: "/booking" | "/claim", contract: string, booking?: number) {
  const params = new URLSearchParams();
  if (contract && contract !== legacyEscrow) params.set("escrow", contract);
  if (booking !== undefined) params.set("booking", String(booking));
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
const attemptKey = "pactpay-near-testnet:pending:" + escrow;
const unknownKey = attemptKey + ":unknown";
const profileModeKey = "pactpay-near-testnet:profile-mode";
function loadAttempt(): Attempt | null {
  try { return JSON.parse(localStorage.getItem(attemptKey) || "null") as Attempt | null; }
  catch { return null; }
}

export default function NearBooking() {
  const {paused, toggle} = usePortalMotion();
  const [walletAccount, setWalletAccount] = useState("");
  const [profileMode, setProfileMode] = useState(() => localStorage.getItem(profileModeKey));
  const [connectOpen, setConnectOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [workspaceView, setWorkspaceView] = useState<"booking" | "lookup" | "quote">("booking");
  const [bookingView, setBookingView] = useState<"shares" | "terms" | "details">("shares");
  const [shareSelection, setShareSelection] = useState<{booking: number; index: number}>();
  const [reviewedInvitationVersion, setReviewedInvitationVersion] = useState<string>();
  const bookingHeading = useRef<HTMLHeadingElement>(null);
  const termsInput = useRef<HTMLTextAreaElement>(null);

  function showBooking() {
    setCreating(false);
    setWorkspaceView("booking");
    setBookingView("shares");
  }
  const [sponsorAvailable, setSponsorAvailable] = useState(false);
  const avatar = useRef<HTMLElement>(null);
  const connectTrigger = useRef<HTMLButtonElement>(null);
  const social = useNearSocialLogin();
  const [linkedWallets, setLinkedWallets] = useState<string[]>([]);
  const [socialMpc, setSocialMpc] = useState<{profile:typeof social.profile; account?:string; funded?:boolean; error?:string}>();
  const [linkStatus, setLinkStatus] = useState("");
  const [linking, setLinking] = useState(false);
  const [bookingInput, setBookingInput] = useState(initialBooking ?? "");
  const [loaded, setLoaded] = useState<{id: number; booking: Booking; token: string; time: number}>();
  const [busy, setBusy] = useState(false);
  const transactionInFlight = useRef(false);
  const [feedback, setFeedback] = useState("");
  const [pending, setPending] = useState(loadAttempt);
  const [terms, setTerms] = useState("");
  const [draftTerms, setDraftTerms] = useState("");
  const [verified, setVerified] = useState("");
  const [lastHash, setLastHash] = useState("");
  const [uncertain, setUncertain] = useState(() => localStorage.getItem(unknownKey) === "1");
  const socialActive = social.connected && (profileMode === "social" || (profileMode === null && !walletAccount));
  const walletActive = Boolean(walletAccount && (profileMode === "wallet" || profileMode === null));
  const account = socialActive
    ? (linkedWallets.includes(walletAccount) ? walletAccount : "")
    : walletActive ? walletAccount : "";
  const [copiedMpc, setCopiedMpc] = useState<{address:string; message:string}>();
  const mpcProfile = socialMpc?.profile === social.profile ? socialMpc : undefined;
  const mpcAddress = mpcProfile?.account;

  useEffect(() => {
    if (!socialActive || !social.profile) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal,AbortSignal.timeout(12000)]);
    const profile = social.profile;
    void readSocialMpcAccount(signal).then(result => {
      if (!controller.signal.aborted) setSocialMpc({profile,...result});
    }).catch(() => {
      if (!controller.signal.aborted) setSocialMpc({profile,error:"MPC account is temporarily unavailable."});
    });
    return () => controller.abort();
  }, [socialActive,social.profile]);

  function selectProfile(mode: "wallet" | "social") {
    localStorage.setItem(profileModeKey, mode);
    setProfileMode(mode);
  }

  useEffect(() => {
    setLinkedWallets([]);
    setLinkStatus("");
    if (!social.connected) return;
    let active = true;
    void profileRequest<{wallets:string[]}>("list").then(({wallets}) => {
      if (active) setLinkedWallets(wallets);
    }).catch(error => {
      if (active) setLinkStatus(error.message);
    });
    return () => { active = false; };
  }, [social.profile]);

  async function linkExternalWallet() {
    if (!walletAccount || !socialActive || linking) return;
    const account = walletAccount;
    setLinking(true);
    setLinkStatus("");
    try {
      const {wallet, accounts} = await walletConnector().getConnectedWallet();
      if (!accounts.some(item => item.accountId === account)) throw new Error("Wallet account changed.");
      const challenge = await profileRequest<{nonce:string; expires:number; proof:string; message:string; recipient:string}>("challenge",{account});
      const nonce = Uint8Array.from(challenge.nonce.match(/../g) ?? [], value => parseInt(value,16));
      const signed = await wallet.signMessage({nonce,message:challenge.message,recipient:challenge.recipient,signerId:account,network:"testnet"});
      if (signed.accountId !== account) throw new Error("Wallet account changed.");
      await profileRequest("link",{account,...challenge,publicKey:signed.publicKey,signature:signed.signature});
      setLinkedWallets(current => [...new Set([...current,account])]);
      setLinkStatus("Wallet linked to your PactPay profile.");
    } catch (error) {
      setLinkStatus(error instanceof Error ? error.message : "Unable to link this wallet.");
    } finally {
      setLinking(false);
    }
  }

  useEffect(() => {
    if (!escrow) return;
    let live = true;
    const client = walletConnector();
    const sync = () => {
      void client.getConnectedWallet().then(({accounts}) => {
        if (live) setWalletAccount(accounts[0]?.accountId || "");
      }).catch(() => { if (live) setWalletAccount(""); });
    };
    client.on("wallet:signIn", sync);
    client.on("wallet:signOut", sync);
    sync();
    return () => { live = false; client.off("wallet:signIn", sync); client.off("wallet:signOut", sync); };
  }, []);

  const viewedId=loaded?.id;
  useEffect(()=>{
    if(viewedId===undefined || busy)return;
    let cancelled=false;
    const timer=window.setInterval(async()=>{
      if(document.visibilityState!=="visible")return;
      try {
        const [booking,time]=await Promise.all([
          view<Booking|null>(escrow,"get_booking",{id:viewedId}),chainTime(),
        ]);
        if(!cancelled && booking) setLoaded(previous=>previous?.id===viewedId && previous.time<=time
          ? {...previous,booking,time} : previous);
      } catch {
        // Keep the last finalized snapshot until the next poll.
      }
    },15000);
    return ()=>{cancelled=true;window.clearInterval(timer);};
  },[viewedId,busy]);

  const run = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setFeedback("");
    try { await work(); }
    catch (error) { setFeedback(error instanceof Error ? error.message : "Operation failed"); }
    finally { setBusy(false); }
  }, []);

  const read = useCallback(async (id: number) => {
    const [booking, token, time] = await Promise.all([
      view<Booking | null>(escrow, "get_booking", {id}),
      view<string>(escrow, "get_token"),
      chainTime(),
    ]);
    if (!booking) throw new Error("Booking not found");
    setLoaded({id, booking, token, time});
    setBookingInput(String(id));
    const url = new URL(location.href);
    if (url.searchParams.get("booking") !== String(id)) {
      url.searchParams.delete("position");
      url.searchParams.delete("version");
    }
    url.searchParams.set("booking", String(id));
    if (resolutionV2) url.searchParams.set("escrow",escrow);
    history.replaceState(null, "", url);
    return booking;
  }, []);

  const openedSharedBooking = useRef(false);
  useEffect(() => {
    if (workspace && sharedInvitation.error) {
      setFeedback(sharedInvitation.error);
      return;
    }
    if (!workspace || !escrow || initialBooking === null || openedSharedBooking.current) return;
    openedSharedBooking.current = true;
    void run(async () => {
      const id = parseBookingId(initialBooking);
      const booking = await read(id);
      const scope = sharedInvitation.scope;
      if (!scope) return;
      if (!booking.positions[scope.position]) throw new Error("The participant share in this invitation could not be found.");
      setShareSelection({booking: id, index: scope.position});
    });
  }, [read, run]);

  useEffect(() => {
    if (!resolutionV2 || !workspace) return;
    const retry = () => {
      if (document.visibilityState === "visible") void retryCaseReferences(escrow);
    };
    retry();
    const timer = window.setInterval(retry,30000);
    return () => window.clearInterval(timer);
  }, []);

  async function reconcile(attempt: Attempt) {
    const result = await finalTransaction(attempt.hash, attempt.sender, resolutionV2 && attempt.method === "create_booking");
    const status = result.status;
    if (!status || (status.Failure === undefined && typeof status.SuccessValue !== "string")) {
      throw new Error("Transaction outcome is still pending. Check again before signing.");
    }
    setPending(null);
    localStorage.removeItem(attemptKey);
    if (status.Failure !== undefined) throw new Error("Transaction failed on NEAR. Review the current booking before trying again.");
    if (resolutionV2 && attempt.receiver === escrow) queueCaseReference(escrow,attempt);
    return status.SuccessValue;
  }

  async function recoverExpiredCreate(attempt: Attempt) {
    if (!resolutionV2 || attempt.receiver !== escrow || attempt.method !== "create_booking" || !attempt.booking) {
      throw new Error("NEAR has no record of this transaction yet. This older request lacks the information needed for automatic recovery.");
    }
    const {fundingDeadline, termsCommitment} = attempt.booking;
    const block = await finalizedBlock();
    if (!block.hash || block.time < fundingDeadline) {
      throw new Error("NEAR has no record of this transaction yet. Check again after the funding deadline.");
    }
    // V2 booking IDs are contiguous and bookings are retained by the contract.
    // Check them at one finalized block so the result cannot change during lookup.
    for (let start = 0; start < 128; start += 8) {
      const ids = Array.from({length:8}, (_, index) => start + index);
      const bookings = await Promise.all(ids.map(id => view<Booking|null>(escrow,"get_booking",{id},block.hash)));
      const match = bookings.findIndex(booking => booking?.merchant === attempt.sender &&
        booking.terms_commitment === termsCommitment && booking.fund_until === String(fundingDeadline));
      if (match >= 0) {
        await read(ids[match]);
        showBooking();
        if (loadAttempt()?.hash === attempt.hash) localStorage.removeItem(attemptKey);
        setPending(null);
        setFeedback("Found the booking on NEAR Testnet.");
        return;
      }
      if (bookings.some(booking => booking === null)) {
        if (loadAttempt()?.hash === attempt.hash) localStorage.removeItem(attemptKey);
        setPending(null);
        setFeedback("The funding deadline passed and no matching booking was found. Set new deadlines and try again.");
        return;
      }
    }
    throw new Error("The booking could not be ruled out within the recovery scan. The request is still pending.");
  }

  const call: Call = async (receiver, method, args, deposit = "0") => {
    if (transactionInFlight.current) throw new Error("A wallet request is already in progress.");
    transactionInFlight.current = true;
    try { return await signAndTrack(receiver,method,args,deposit); }
    finally { transactionInFlight.current = false; }
  };

  const signAndTrack: Call = async (receiver, method, args, deposit = "0") => {
    if (!account || pending || uncertain || localStorage.getItem(attemptKey) || localStorage.getItem(unknownKey)) throw new Error("Connect your wallet and resolve any pending transaction first.");
    const {wallet, accounts} = await walletConnector().getConnectedWallet();
    if (!accounts.some(a => a.accountId === account)) throw new Error("Wallet account changed. Reconnect before signing.");
    let outcome;
    localStorage.setItem(unknownKey, "1");
    try {
      outcome = await wallet.signAndSendTransaction({
        signerId: account, receiverId: receiver,
        actions: [{type: "FunctionCall", params: {methodName: method, args, deposit, gas: "100000000000000"}}],
      });
    } catch {
      setUncertain(true);
      throw new Error("The wallet returned no transaction hash. Check wallet activity before sending again.");
    }
    const hash = outcome?.transaction?.hash;
    if (!hash) {
      setUncertain(true);
      throw new Error("No transaction hash was returned. Check wallet activity before sending again.");
    }
    const attempt = {hash, sender: account, receiver, method};
    setLastHash(hash);
    setPending(attempt);
    localStorage.setItem(attemptKey, JSON.stringify(attempt));
    localStorage.removeItem(unknownKey);
    if (resolutionV2 && receiver === escrow) queueCaseReference(escrow,attempt);
    return reconcile(attempt);
  };

  async function action(method: string, args: Record<string, unknown>, receiver = escrow, deposit = "0") {
    if (!loaded) return;
    const result = await call(receiver, method, args, deposit);
    const booking = await read(loaded.id);
    const position = booking.positions[Number(args.index)];
    if (["claim","claim_v2","claim_retryable_v2"].includes(method) && result && atob(result) === "false") {
      setFeedback("Token transfer failed. The claim is available again. Check token registration before retrying.");
    } else if (method === "ft_transfer_call" && result && JSON.parse(atob(result)) !== args.amount) {
      setFeedback("The escrow did not accept the full contribution. Check your token balance and booking.");
    } else if (method === "claim" && position?.claims[args.refund ? 0 : 1] !== "Paid") {
      setFeedback("Claim outcome requires reconciliation. Check the transfer receipt before retrying.");
    } else setFeedback("Transaction finalized. Booking refreshed from NEAR.");
  }

  async function getDemoTokens(id: number, index: number) {
    const request = async (body: object, session?: string) => {
      const response = await fetch(session ? "/api/near-demo-tokens" : "/api/near-evidence", {
        method:"POST", headers:{"content-type":"application/json", ...(session ? {authorization:"Bearer "+session} : {})},
        body:JSON.stringify(body), signal:AbortSignal.timeout(55000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Demo token request failed.");
      return result;
    };
    const {wallet,accounts} = await walletConnector().getConnectedWallet();
    if (!accounts.some(item=>item.accountId===account)) throw new Error("Wallet account changed.");
    const challenge = await request({action:"challenge",account,escrow});
    const nonce = Uint8Array.from(challenge.nonce.match(/../g), (value: string) => parseInt(value,16));
    const signed = await wallet.signMessage({nonce,message:challenge.message,recipient:challenge.recipient,signerId:account,network:"testnet"});
    if (signed.accountId !== account) throw new Error("Wallet account changed.");
    const {session} = await request({action:"login",escrow,token:challenge.token,...signed});
    const result = await request({id,index},session);
    setFeedback(result.amount === "0" ? "Your wallet already has enough PDEMO for this share." :
      result.amount + " PDEMO delivered. You can now contribute.");
  }

  const socialCreator = resolutionV2 && socialActive && !account ? mpcAddress : undefined;

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    if (busy || pending || uncertain || localStorage.getItem(attemptKey) || localStorage.getItem(unknownKey)) return;
    const popup = socialCreator ? window.open("", "_blank", "popup,width=520,height=760") : undefined;
    if (popup === null) return setFeedback("Allow pop-ups for PactPay, then try again.");
    try {
      await run(async () => {
        const shares = String(fields.get("shares")).trim().split(/\r?\n/).map(line => {
          const [buyer, amount, extra] = line.trim().split(/\s+/);
          if (!buyer || !amount || !/^[1-9]\d*$/.test(amount) || extra) {
            throw new Error("Enter one account and a positive whole token amount per line");
          }
          return {buyer, amount};
        });
        if (shares.length > 32 || new Set(shares.map(s => s.buyer)).size !== shares.length ||
            shares.some(s => s.buyer === (socialCreator ?? account) || BigInt(s.amount) >= 2n ** 128n)) {
          throw new Error("Use up to 32 distinct buyer accounts and valid token amounts");
        }
        const date = (name: string) => Math.floor(new Date(String(fields.get(name))).getTime() / 1000);
        const fund = date("fund"), end = date("end");
        if (!(fund > await chainTime() && end > fund)) throw new Error("Choose future funding and service deadlines in order");
        if (!/(^|\n)Reference: [a-f0-9]{64}$/.test(draftTerms)) throw new Error("Add a private reference to the terms first");
        const terms_commitment = await commitment(draftTerms);
        const storageDeposit = resolutionV2
          ? await view<string>(escrow,"booking_storage_deposit",{positions:shares.length})
          : String(BigInt(512 + 512 * shares.length) * 10n ** 19n);
        const args = {terms_commitment, fund_until: String(fund), service_end: String(end), shares};
        let result;
        if (socialCreator && popup) {
          let attempt: Attempt | undefined;
          await signSocialBooking(popup,socialCreator,escrow,args,storageDeposit,hash=>{
            attempt = {hash,sender:socialCreator,receiver:escrow,method:"create_booking",
              booking:{fundingDeadline:fund,termsCommitment:terms_commitment}};
            localStorage.setItem(attemptKey,JSON.stringify(attempt));
            setPending(attempt);
            setLastHash(hash);
          },()=>{
            localStorage.removeItem(attemptKey);
            setPending(null);
            setLastHash("");
          });
          if (!attempt) throw new Error("Missing Testnet transaction reference.");
          result = await reconcile(attempt);
        } else {
          result = await call(escrow,"create_booking",args,storageDeposit);
        }
        const id = parseBookingId(atob(result || ""));
        await read(id);
        setTerms(draftTerms);
        setDraftTerms("");
        setVerified(terms_commitment);
        showBooking();
        setFeedback("Booking created. Share its URL and the exact terms privately with participants.");
      });
    } finally {
      popup?.close();
    }
  }

  useEffect(() => {
    if (!account || !loaded || !/^\/booking\/?$/.test(location.pathname)) return;
    const request = new AbortController();
    setSponsorAvailable(false);
    void fetch("/api/near-relay", {signal:request.signal})
      .then(async response => response.ok && (await response.json()).enabled === true)
      .then(enabled => { if (!request.signal.aborted) setSponsorAvailable(enabled); })
      .catch(() => {});
    return () => request.abort();
  }, [account, loaded?.id]);

  async function sponsorAcceptance(index: number) {
    if (!loaded || !account || !canSign || verified !== loaded.booking.terms_commitment) return;
    const {wallet, accounts} = await walletConnector().getConnectedWallet();
    if (!accounts.some(item => item.accountId === account) || !wallet.manifest.features.signDelegateActions) {
      throw new Error("This wallet does not support sponsored signatures. Use Accept verified terms.");
    }
    const {signedDelegateActions} = await wallet.signDelegateActions({
      network:"testnet", signerId:account, delegateActions:[{receiverId:escrow, actions:[{
        type:"FunctionCall", params:{methodName:"accept",args:{id:loaded.id,index,terms_commitment:verified},gas:"15000000000000",deposit:"0"},
      }]}],
    });
    if (signedDelegateActions.length !== 1) throw new Error("Expected one signed acceptance.");
    const response = await fetch("/api/near-relay", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({delegate:signedDelegateActions[0]}), signal:AbortSignal.timeout(25000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Sponsorship unavailable.");
    setLastHash(result.hash);
    const booking = await read(loaded.id);
    if (!booking.positions[index]?.accepted) throw new Error("Sponsored acceptance did not finalize. Refresh before trying again.");
    setFeedback("Acceptance finalized on NEAR. PactPay paid the network fee.");
  }

  const canSign = Boolean(account && !pending && !uncertain && !busy);
  function connectWallet(intent: "wallet" | "link" | "disconnect" = "wallet") {
    return run(async () => {
      const client = walletConnector();
      if (intent === "disconnect") {
        await client.disconnect();
        setWalletAccount("");
      } else {
        if (!walletAccount) await client.connect();
        selectProfile(intent === "link" ? "social" : "wallet");
      }
    });
  }
  const selectedBooking = loaded?.id ?? (/^(0|[1-9]\d*)$/.test(bookingInput) && Number.isSafeInteger(Number(bookingInput))
    ? Number(bookingInput) : undefined);
  const demoId = resolutionV2 ? 1 : 0;
  const total = loaded?.booking.positions.reduce((sum, p) => sum + BigInt(p.share), 0n);
  const funded = loaded?.booking.positions.reduce((sum, p) => sum + (p.funded ? BigInt(p.share) : 0n), 0n);
  const assignedShare = loaded?.booking.positions.findIndex(position => position.buyer === account) ?? -1;
  const selectedShare = shareSelection && shareSelection.booking === loaded?.id
    ? shareSelection.index : Math.max(0, assignedShare);
  const inviteScope = sharedInvitation.scope;
  const missingInvitedShare = Boolean(loaded && inviteScope?.booking === loaded.id &&
    !loaded.booking.positions[inviteScope.position]);
  const invitedVersion = inviteScope && inviteScope.booking === loaded?.id && inviteScope.position === selectedShare
    ? inviteScope.version : undefined;
  const selectedPosition = loaded?.booking.positions[selectedShare];
  const currentVersion = selectedPosition?.proposal_version;
  const staleInvitation = needsInvitationReview(invitedVersion, currentVersion, reviewedInvitationVersion);
  const shareLink = loaded && selectedPosition && (account === loaded.booking.merchant || account === selectedPosition.buyer)
    ? invitationUrl(location.origin, {escrow, booking: loaded.id, position: selectedShare, version: selectedPosition.proposal_version})
    : undefined;

  return <div className={workspace ? "pp-app pd-authenticated near-app" : "pp-app near-app"}>
    <a className="pp-skip" href="#pp-main">Skip to main content</a>
    <header className="pp-header">
      <a href="/" className="pp-brand"><img className="pactpay-logo" src="/art/pactpay/pactpay-logo.webp" width="144" height="48" alt="PactPay home" /></a>
      <nav className="pd-app-nav" aria-label="Main navigation">
        <a href="/" aria-current={workspace ? undefined : "page"}>Home</a>
        <a href={workspaceLink("/booking", escrow, claimPage ? selectedBooking : undefined)} aria-current={workspace && !claimPage ? "page" : undefined}>Booking workspace</a>
        {claimPage && <a href={workspaceLink("/claim", escrow, selectedBooking)} aria-current="page">Claim funds</a>}
      </nav>
      <Dialog.Root open={connectOpen} onOpenChange={setConnectOpen}>
      <div className="pp-account">
        {walletActive || socialActive ? <details className="near-account-menu"
          onBlur={event => {
            if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
          }}
          onKeyDown={event => {
            if (event.key === "Escape" && event.currentTarget.open) {
              event.currentTarget.open = false;
              avatar.current?.focus();
            }
          }}>
          <summary ref={avatar} aria-label="My account">
            <img src={socialActive && social.profile?.picture?.startsWith("https:") ? social.profile.picture : "/art/pactpay/profile-companion.webp"}
              referrerPolicy="no-referrer" alt="" width="36" height="36" />
          </summary>
          <div className="pp-panel near-account-options">
            <strong>{socialActive ? social.profile?.name || "Social account" : walletAccount}</strong>
            {socialActive && social.profile?.email && <span>{social.profile.email}</span>}
            {socialActive && account && <span>Signing wallet · {account}</span>}
            {socialActive && mpcAddress && <section className="near-mpc-account" aria-label="MPC account">
              <div className="near-mpc-heading">
                <strong>MPC account</strong>
                <small>NEAR Testnet</small>
              </div>
              <code>{mpcAddress}</code>
              <small>{mpcProfile?.funded ? "Testnet access key detected" : "Activates when you create a booking"}</small>
              <button type="button" className="near-mpc-copy" onClick={async () => {
                const address = mpcAddress;
                try {
                  await navigator.clipboard.writeText(address);
                  setCopiedMpc({address,message:"Address copied."});
                } catch {
                  setCopiedMpc({address,message:"Copy unavailable. Select the address to copy it manually."});
                }
              }}>Copy address</button>
              <span className="near-mpc-copy-status" role="status">
                {copiedMpc?.address === mpcAddress ? copiedMpc.message : ""}
              </span>
            </section>}
            {socialActive && mpcProfile?.error && <small>{mpcProfile.error}</small>}
            {socialActive && linkedWallets.length > 0 && <div>
              <strong>Linked NEAR Testnet wallets</strong>
              <ul>{linkedWallets.map(wallet => <li key={wallet}>{wallet}</li>)}</ul>
            </div>}
            {socialActive && escrow && !linkedWallets.includes(walletAccount) && <button className="pp-secondary"
              disabled={busy || linking} onClick={() => {
                if (walletAccount) void linkExternalWallet();
                else void connectWallet("link");
              }}>{linking ? "Verifying wallet…" : "Link external wallet"}</button>}
            {socialActive && !account && <small>{walletAccount ? `Verify ${walletAccount} to link it to this profile.` : "Choose a wallet, then sign to save the link."}</small>}
            {socialActive && linkStatus && <p role="status">{linkStatus}</p>}
            {socialActive && walletAccount && <button className="pp-secondary" disabled={busy || linking}
              onClick={() => selectProfile("wallet")}>Switch to wallet account</button>}
            {escrow && walletAccount && <button className="pp-secondary" disabled={busy || linking} onClick={event => {
              const menu = event.currentTarget.closest("details");
              avatar.current?.focus();
              if (menu) menu.open = false;
              void connectWallet("disconnect").then(() => (avatar.current ?? connectTrigger.current)?.focus());
            }}>{socialActive ? "Disconnect wallet" : "Sign out of wallet"}</button>}
            {social.available && <button className="pp-secondary" disabled={social.busy || linking} onClick={() => {
              if (!socialActive && social.connected) { selectProfile("social"); return; }
              if (!social.connected) { setConnectOpen(true); return; }
              void social.toggle().then(ok => {
                if (!ok) return;
                const menu = avatar.current?.closest("details");
                if (menu) menu.open = false;
                requestAnimationFrame(() => (avatar.current ?? connectTrigger.current)?.focus());
              });
            }}>{socialActive ? "Sign out of NEAR Auth" : social.connected ? "Switch to social account" : "Continue with NEAR Auth"}</button>}
            {social.error && !connectOpen && <p role="alert">{social.error}</p>}
          </div>
        </details> : (escrow || social.available) && <Dialog.Trigger asChild>
          <button ref={connectTrigger} className="pp-primary"><Wallet size={16} aria-hidden="true" />Connect</button>
        </Dialog.Trigger>}
      </div>
      <Dialog.Portal>
        <Dialog.Overlay className="pp-overlay" />
        <Dialog.Content className="pp-connect-dialog" onCloseAutoFocus={event => {
          if (avatar.current) {
            event.preventDefault();
            avatar.current.focus();
          }
        }}>
          <Dialog.Close className="pp-icon pp-connect-close" aria-label="Close connection options"><X size={18} aria-hidden="true" /></Dialog.Close>
          <div className="pp-connect-mark"><Wallet size={24} aria-hidden="true" /></div>
          <Dialog.Title>Connect to PactPay</Dialog.Title>
          <Dialog.Description>Choose how you would like to connect.</Dialog.Description>
          <div className="pp-connect-options">
            {escrow && !walletActive && <button disabled={busy} onClick={() => {
              setConnectOpen(false);
              void connectWallet();
            }}>
              <span className="pp-connect-symbol"><Wallet size={23} aria-hidden="true" /></span>
              <span><strong>Connect wallet</strong>
                <small>Use a NEAR wallet to sign booking transactions and access private evidence.</small></span>
              <ArrowUpRight size={18} aria-hidden="true" />
            </button>}
            {social.available && !social.connected && <button disabled={social.busy} onClick={() => {
              void social.toggle().then(ok => { if (ok) { selectProfile("social"); setConnectOpen(false); } });
            }}>
              <span className="pp-connect-symbol"><UserRound size={23} aria-hidden="true" /></span>
              <span><strong>Continue with NEAR Auth</strong>
                <small>Sign in with Google or another method offered by Auth0.</small></span>
              <ArrowUpRight size={18} aria-hidden="true" />
            </button>}
            {social.available && social.connected && !socialActive && <button onClick={() => {
              selectProfile("social");
              setConnectOpen(false);
            }}><strong>Switch to social account</strong></button>}
          </div>
          {social.busy && <p role="status">Finish signing in in the NEAR Auth window.</p>}
          {social.error && <p role="alert">{social.error}</p>}
        </Dialog.Content>
      </Dialog.Portal>
      </Dialog.Root>
      {!connectOpen && !account && !social.connected && social.error && <p role="alert">{social.error}</p>}
    </header>
    <main id="pp-main" className="pp-main">
      {!workspace && <><PortalHero signedIn={false} paused={paused} onToggleMotion={toggle}
        networkLabel="NEAR Testnet" exploreHref="/booking?booking=5&amp;escrow=escrow-v2.pactpay-530c506b.testnet"
        description="Book together. Keep each payment accountable. Share private evidence if something goes wrong, preview the agreement before signing, and check the final payout on NEAR Testnet."
        startLabel="Open booking workspace"
        onStart={() => location.assign("/booking")} />
        <NearLandingDetails />
      </>}
      {workspace && <div className="pd-dashboard near-workspace" id="booking-outcomes">
        <div className="pd-page-heading"><div><h1>{claimPage ? "Claim funds" : "Group bookings"}</h1>{!loaded && <p>{claimPage ? "Check a booking and claim an available payout or refund." : "Use a booking ID or create a new booking."}</p>}</div>
          <span className="pp-badge"><ShieldCheck size={15} /> NEAR testnet</span></div>
    {!escrow ? <section className="pp-panel"><h2>Escrow setup required</h2>
      <p>This workspace needs a PactPay contract on NEAR testnet before you can open a booking or connect a wallet.</p>
    </section> : <>
      <div className="near-workspace-tools" role="group" aria-label="Booking task">
        {loaded && <button type="button" disabled={busy} aria-pressed={!creating && workspaceView === "booking"} onClick={showBooking}>Booking #{loaded.id}</button>}
        {(!claimPage || loaded) && <button type="button" disabled={busy} aria-pressed={!creating && (workspaceView === "lookup" || (!loaded && workspaceView === "booking"))}
          onClick={() => {setCreating(false); setWorkspaceView("lookup");}}><Search size={17} aria-hidden="true" /> Find booking</button>}
        {!claimPage && <>
          <button type="button" disabled={busy} aria-pressed={creating} onClick={() => setCreating(true)}><Plus size={17} aria-hidden="true" /> Create booking</button>
          <button type="button" disabled={busy} aria-pressed={!creating && workspaceView === "quote"}
            onClick={() => {setCreating(false); setWorkspaceView("quote");}}>Cross-chain quote</button>
        </>}
      </div>
      {!creating && workspaceView !== "quote" && (!loaded || workspaceView === "lookup") && <section className="pp-panel near-open-booking" aria-labelledby="near-open-booking">
        <div className="near-lookup-main">
        <div>
          <h2 id="near-open-booking">Find a booking</h2>
          <p>{claimPage ? "Enter your booking ID to check for a payout or refund." : "Use the booking ID shared by your organizer to see your share and deadlines."}</p>
        </div>
        <form className="pp-form near-lookup" onSubmit={event => {
          event.preventDefault();
          void run(async () => {
            const id = parseBookingId(bookingInput);
            await read(id);
            setVerified("");
            setShareSelection(undefined);
            showBooking();
            requestAnimationFrame(() => bookingHeading.current?.focus());
          });
        }}>
          <label>Booking ID<input value={bookingInput} placeholder="e.g. 0" required inputMode="numeric" onChange={e => setBookingInput(e.target.value)} /></label>
          <button className="pp-primary" disabled={busy}>{busy ? "Loading…" : "Load booking"} <ArrowRight size={16} aria-hidden="true" /></button>
        </form>
        </div>
        <nav className="near-lookup-actions" aria-label="Booking shortcuts">
          {!claimPage && <a className="near-lookup-shortcut" href={workspaceLink("/claim",escrow,selectedBooking)}>
            <Wallet size={19} aria-hidden="true" /><span><strong>Claim payout or refund</strong><small>{selectedBooking === undefined ? "Find an amount you can claim" : `Check claims for booking #${selectedBooking}`}</small></span><ArrowRight size={16} aria-hidden="true" />
          </a>}
          {!claimPage && v2Escrow && v2Escrow !== legacyEscrow && <a className="near-lookup-shortcut"
            href={workspaceLink("/booking",resolutionV2 ? legacyEscrow : v2Escrow)}>
            <Layers size={19} aria-hidden="true" /><span><strong>{resolutionV2 ? "Original bookings" : "Resolution Agreement bookings"}</strong><small>{resolutionV2 ? "Find a booking in the original workspace" : "Open the workspace for agreements and split payouts"}</small></span><ArrowRight size={16} aria-hidden="true" />
          </a>}
          <a className="near-lookup-shortcut" href={workspaceLink(claimPage ? "/claim" : "/booking",escrow,demoId)}>
            <CirclePlay size={19} aria-hidden="true" /><span><strong>Open demo booking #{demoId}</strong><small>See a completed booking on testnet</small></span><ArrowRight size={16} aria-hidden="true" />
          </a>
        </nav>
      </section>}
      {pending && <p role="status">Pending {pending.method} · <code>{pending.hash}</code>{" "}
        <button className="pp-secondary" disabled={busy} onClick={() => void run(async () => {
          let result;
          try {
            result = await reconcile(pending);
          } catch (error) {
            if (!(error instanceof UnknownTransactionError) || pending.method !== "create_booking") throw error;
            await recoverExpiredCreate(pending);
            return;
          }
          if (pending.method === "create_booking") {
            await read(parseBookingId(atob(result || "")));
            showBooking();
          }
          else if (loaded) await read(loaded.id);
          setFeedback(pending.method === "claim" && result && atob(result) === "false"
            ? "Token transfer failed. Check token registration before claiming again."
            : "Transaction finalized. Check the booking for the resulting state.");
        })}>Check final outcome</button></p>}
      {uncertain && <section className="pp-panel"><p>Check your wallet and refresh the booking before signing again.</p>
        <button className="pp-secondary" disabled={busy} onClick={() => void run(async () => {
          if (loaded) await read(loaded.id);
          localStorage.removeItem(unknownKey);
          setUncertain(false);
        })}>I checked my wallet</button></section>}
      {feedback && <p className="pp-note" role="status">{feedback}</p>}
      {lastHash && <p>Last transaction <code>{lastHash}</code></p>}
      {creating && (account || socialActive) && <div className="near-create-layout">
        <section className="pp-panel pp-form near-terms" aria-labelledby="draft-terms-title">
          <h2 id="draft-terms-title"><FileText size={20} aria-hidden="true" /> Draft booking terms</h2>
          <label>Exact booking terms<textarea rows={6} value={draftTerms} onChange={e => setDraftTerms(e.target.value)}
            placeholder="Describe the service and what each buyer receives." /></label>
          <div className="near-terms-actions"><button className="pp-secondary" type="button" disabled={busy} onClick={() => {
            const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
            setDraftTerms(previous => previous ? `${previous}\n\nReference: ${nonce}` : `Reference: ${nonce}`);
          }}>Add private reference</button></div>
          <p>Share these exact terms privately with participants, including the reference.</p>
        </section>
        <section className="pp-panel near-create" aria-labelledby="draft-buyers-title">
        <h2 id="draft-buyers-title">Buyers and deadlines</h2>
        <form className="pp-form" onSubmit={event => void create(event)}>
          <label>Buyer and token amount, one per line<textarea name="shares" required rows={3} placeholder="buyer.testnet 20" /></label>
          <div className="near-create-dates">
            <label>Funding deadline<input type="datetime-local" name="fund" required /></label>
            <label>Service end<input type="datetime-local" name="end" required /></label>
          </div>
          <p>Buyers can open disputes within 48 hours after the service ends.</p>
          {socialCreator && <p className="near-note">Create with NEAR Auth. PactPay can cover Testnet fees for your first booking. Review and approve in the popup.</p>}
          {socialActive && !account && !resolutionV2 && v2Escrow &&
            <p><a href={workspaceLink("/booking",v2Escrow)}>Open Resolution Agreement workspace to create with NEAR Auth</a></p>}
          <button className="pp-primary" disabled={!(canSign || (socialCreator && !busy && !pending && !uncertain))}>Create <ArrowRight size={16} aria-hidden="true" /></button>
        </form>
      </section>
      </div>}
      {!creating && loaded && workspaceView === "booking" && <section className="pp-panel near-booking" aria-labelledby="near-booking-title">
        <div className="near-booking-header">
          <div className="near-booking-title"><h2 id="near-booking-title" ref={bookingHeading} tabIndex={-1}>Booking #{loaded.id}</h2><span className="pp-badge">{loaded.booking.captured ? "Captured" : "Collecting shares"}</span></div>
          <div className="near-booking-tools">
          <button className="pp-secondary" disabled={busy} onClick={() => void run(async () => {
            await read(loaded.id);
            setFeedback("Booking refreshed from finalized NEAR state.");
          })}><RefreshCw size={16} aria-hidden="true" /> Refresh</button>
          <button className="pp-secondary" disabled={busy} onClick={() => void run(async () => {
            const booking = await read(loaded.id);
            const receipt = {network:"testnet",escrow,token:loaded.token,bookingId:loaded.id,booking};
            const url=URL.createObjectURL(new Blob([JSON.stringify(receipt,null,2)],{type:"application/json"}));
            const link=document.createElement("a");
            link.href=url;link.download=`pactpay-testnet-booking-${loaded.id}.json`;link.click();
            setTimeout(()=>URL.revokeObjectURL(url),1000);
          })}><Download size={16} aria-hidden="true" /> Export receipt</button>
          </div>
        </div>
        {!claimPage && <div className="near-section-switch" role="group" aria-label="Booking sections">
          <button type="button" aria-pressed={bookingView === "shares"} onClick={() => setBookingView("shares")}>Shares &amp; payments</button>
          <button type="button" aria-pressed={bookingView === "terms"} onClick={() => setBookingView("terms")}>Booking terms</button>
          <button type="button" aria-pressed={bookingView === "details"} onClick={() => setBookingView("details")}>Booking details</button>
          <a href={workspaceLink("/claim",escrow,loaded.id)}>Claim funds <ArrowRight size={15} aria-hidden="true" /></a>
        </div>}
        {!claimPage && bookingView === "terms" && <section className="pp-panel pp-form near-terms" id="booking-terms">
        <h3><FileText size={20} aria-hidden="true" /> Booking terms</h3>
        <label>Exact booking terms<textarea ref={termsInput} rows={4} value={terms} onChange={e => {
          setTerms(e.target.value);
          setVerified("");
        }} placeholder="Paste the privately shared terms, including the reference." /></label>
        <div className="near-terms-actions"><button className="pp-primary" disabled={busy || !terms.trim()} onClick={() => void run(async () => {
          const hash = await commitment(terms);
          if (hash !== loaded.booking.terms_commitment) throw new Error("These terms do not match this booking.");
          setVerified(hash);
          setBookingView("shares");
          requestAnimationFrame(() => bookingHeading.current?.focus());
          setFeedback("The pasted terms match the on-chain commitment.");
        })}>Verify terms</button></div>
        <p>Paste the exact text shared by the merchant, including the reference and line breaks.</p>
      </section>}
        {(claimPage || bookingView === "details") && <div className="near-booking-overview">
          <dl className="near-booking-stats">
            <div><dt>Booking total</dt><dd>{total?.toString()} <small>PDEMO</small></dd></div>
            <div><dt>Contributions received</dt><dd>{funded?.toString()} <small>PDEMO</small></dd></div>
            <div><dt>Participants</dt><dd>{loaded.booking.positions.length}</dd></div>
          </dl>
          <dl className="near-booking-details">
            <div><dt>Merchant</dt><dd><code>{loaded.booking.merchant}</code></dd></div>
            <div><dt>Token contract</dt><dd><code>{loaded.token}</code></dd></div>
            <div><dt>Funding closes</dt><dd>{new Date(Number(loaded.booking.fund_until) * 1000).toLocaleString()}</dd></div>
            <div><dt>Service ends</dt><dd>{new Date(Number(loaded.booking.service_end) * 1000).toLocaleString()}</dd></div>
          </dl>
        </div>}
        <div className="near-share-panel" hidden={!claimPage && bookingView !== "shares"}>
        <div className="near-booking-shares-heading">
        <h3>{claimPage ? "Participant claims" : "Participant shares"}</h3>
        {!claimPage && !missingInvitedShare && shareLink && <ShareInvitation key={shareLink} url={shareLink} />}
        {!missingInvitedShare && loaded.booking.positions.length > 1 && <div className="near-share-picker"><label htmlFor="near-participant">Participant</label>
          <select id="near-participant" value={selectedShare} onChange={event => setShareSelection({booking: loaded.id, index: Number(event.target.value)})}>
            {loaded.booking.positions.map((position, index) => <option key={index} value={index}>
              {index + 1}. {position.buyer}{account === position.buyer ? " (you)" : ""} · {position.share} PDEMO
            </option>)}
          </select>
        </div>}
        {claimPage && !account && <button className="pp-primary" disabled={busy} onClick={() => void connectWallet()}>Connect wallet to claim</button>}
        {!claimPage && account === loaded.booking.merchant && !loaded.booking.captured && loaded.booking.positions.every(p => p.funded) &&
          loaded.time < Number(loaded.booking.service_end) &&
          <button className="pp-secondary" disabled={!canSign} onClick={() => void run(() => action("capture", {id: loaded.id}))}>Capture booking</button>}
        </div>
        {!claimPage && <div className="near-share-permissions">
          <strong>Who can see this share?</strong>
          <dl>
            <div><dt>Public</dt><dd>Wallet addresses, amounts, status and public receipts.</dd></div>
            <div><dt>Buyer and merchant</dt><dd>Evidence shared with their authorized NEAR wallet.</dd></div>
          </dl>
          <small>Removing access affects future requests. It cannot delete copies already saved.</small>
        </div>}
        {staleInvitation && <div className="near-share-permissions">
          <p role="status">This link points to agreement version {invitedVersion}. The current version is {currentVersion}.</p>
          <button type="button" className="pp-secondary" onClick={() => setReviewedInvitationVersion(currentVersion)}>
            View current version
          </button>
        </div>}
        {missingInvitedShare && <a className="pp-secondary" href={workspaceLink("/booking", escrow, loaded.id)}>Open booking without invitation</a>}
        {!missingInvitedShare && !staleInvitation && <div className="near-booking-shares">{loaded.booking.positions.map((position, index) =>
          <div key={`${loaded.id}:${index}`} hidden={index !== selectedShare}><PositionCard position={position} index={index}
            onReviewTerms={() => {
              setBookingView("terms");
              requestAnimationFrame(() => termsInput.current?.focus());
            }}
            booking={loaded.booking} bookingId={loaded.id} account={account} time={loaded.time} enabled={canSign}
            claimOnly={claimPage}
            v2={resolutionV2}
            workspace={resolutionV2 && <ResolutionWorkspace key={account} escrow={escrow} booking={loaded.booking}
              position={position} id={loaded.id} index={index} token={loaded.token} account={account}
              time={loaded.time} enabled={canSign} claimOnly={claimPage}
              verifiedTerms={verified === loaded.booking.terms_commitment ? terms : ""}
              send={async(method,args)=>{
                await action(method, ["claim_v2","claim_retryable_v2"].includes(method) ? args : {id:loaded.id,index,...args});
              }}
              sign={async params=>{
                const {wallet,accounts}=await walletConnector().getConnectedWallet();
                if (!accounts.some(item=>item.accountId===account)) throw new Error("Wallet account changed.");
                return wallet.signMessage({...params,signerId:account,network:"testnet"});
              }}/>}
            sponsor={!resolutionV2 && sponsorAvailable && !claimPage ? () => void run(() => sponsorAcceptance(index)) : undefined}
            verified={verified === loaded.booking.terms_commitment}
            verifiedTerms={verified === loaded.booking.terms_commitment ? terms : ""}
            send={(method, args = {}, receiver, deposit) => void run(() => action(method,
              receiver ? args : {id: loaded.id, index, ...args}, receiver, deposit))}
            demoTokens={resolutionV2 && !claimPage ? () => void run(() => getDemoTokens(loaded.id,index)) : undefined}
            fund={() => void run(() => action("ft_transfer_call", {
              receiver_id: escrow, amount: position.share, msg: JSON.stringify({booking: loaded.id, position: index}),
            }, loaded.token, "1"))}
            register={() => void run(async () => {
              const bounds = await view<{min: string}>(loaded.token, "storage_balance_bounds");
              await action("storage_deposit", {account_id: account, registration_only: true}, loaded.token, bounds.min);
            })} /></div>
        )}</div>}
        </div>
      </section>}
      {!claimPage && !creating && <div hidden={workspaceView !== "quote"}><IntentsQuote /></div>}
      {creating && !account && !socialActive && <section className="pp-panel near-open-booking">
        <h2>Connect a wallet to create a booking</h2>
        <p>Your NEAR Testnet wallet sets the merchant account and signs the booking.</p>
        <button className="pp-primary" disabled={busy} onClick={() => void connectWallet()}><Wallet size={16} aria-hidden="true" /> Connect wallet</button>
      </section>}
    </>}
      </div>}
    </main>
    <footer className="pp-footer near-footer"><img src="/art/pactpay/pactpay-logo.webp" width="108" height="36" alt="PactPay" /><span>NEAR testnet · Demo tokens</span></footer>
  </div>;
}

function PositionCard({position: p, index, booking, bookingId, account, time, enabled, verified, verifiedTerms, send, fund, register, demoTokens, claimOnly, sponsor, v2, workspace, onReviewTerms}: {
  position: Position; index: number; booking: Booking; bookingId: number; account: string; time: number;
  enabled: boolean; verified: boolean; verifiedTerms: string; send: (method: string, args?: Record<string, unknown>, receiver?: string, deposit?: string) => void;
  onReviewTerms: () => void; fund: () => void; demoTokens?: () => void; register: () => void; claimOnly: boolean; sponsor?: () => void;
  v2:boolean; workspace:React.ReactNode;
}) {
  const buyer = account === p.buyer;
  const merchant = account === booking.merchant;
  const serviceEnded = time >= Number(booking.service_end);
  const fundingOpen = time < Number(booking.fund_until);
  const complaintOpen = serviceEnded && time < Number(booking.service_end) + 2 * DAY;
  const allocated = v2 ? Boolean(p.has_allocation) : Boolean(p.allocation);
  const active = Boolean(p.dispute_until && time < Number(p.dispute_until) && !allocated);
  const canSettle = p.funded && !allocated && (!booking.captured
    ? serviceEnded || (!fundingOpen && booking.positions.some(s => !s.funded))
    : p.dispute_until ? !active : serviceEnded && !complaintOpen);
  const [refund, setRefund] = useState("");
  const [evidence, setEvidence] = useState("");
  const proposal = p.proposal;
  const actor = buyer ? 1 : 2;
  const [remedy, setRemedy] = useState<Remedy | null>(null);
  const [remedyDue, setRemedyDue] = useState("");
  useEffect(() => {
    if (v2 || claimOnly || !p.dispute_until || (!buyer && !merchant)) return;
    let current = true;
    void view<Remedy | null>(escrow, "get_remedy", {id:bookingId,index}).then(record => {
      if (current) setRemedy(record);
    }).catch(() => {});
    return () => { current = false; };
  }, [bookingId,index,p,time,buyer,merchant,claimOnly,v2]);
  const currentRemedy = remedy && remedy.revision === p.evidence_revision && time < Number(remedy.due) ? remedy : null;
  const due = Math.floor(new Date(remedyDue).getTime()/1000);
  const proposed = /^\d{1,39}$/.test(refund) && BigInt(refund) <= BigInt(p.share);
  const status = allocated ? "Allocated" : p.dispute_until ? "Disputed · funds held" :
    p.funded ? "Funds held" : p.accepted ? "Awaiting contribution" : "Awaiting acceptance";
  return <article className="pp-panel near-card">
    <div className="near-share-header">
      <div><h4>Share {index + 1}</h4><code>{p.buyer}</code></div>
      <div className="near-share-status">
        <strong>{p.share} <small>PDEMO</small></strong>
        <span className={p.dispute_until && !allocated ? "pp-badge near-dispute" : "pp-badge"}>{status}</span>
      </div>
    </div>
    {!claimOnly && buyer && fundingOpen && !p.accepted && !verified &&
      <button className="pp-primary" type="button" onClick={onReviewTerms}>Review booking terms</button>}
    {!claimOnly && buyer && fundingOpen && !p.accepted && <button className="pp-secondary" disabled={!enabled || !verified} onClick={() =>
      send("accept", {terms_commitment: booking.terms_commitment})}>Accept verified terms</button>}
    {sponsor && buyer && fundingOpen && !p.accepted && <button className="pp-secondary"
      disabled={!enabled || !verified} onClick={sponsor}>Accept with sponsored fee</button>}
    {demoTokens && buyer && fundingOpen && p.accepted && !p.funded && <button type="button"
      className="pp-secondary" disabled={!enabled} onClick={demoTokens}>Get demo PDEMO</button>}
    {!claimOnly && buyer && fundingOpen && p.accepted && !p.funded && <button className="pp-primary" disabled={!enabled} onClick={fund}>Contribute {p.share}</button>}
    {!claimOnly && buyer && booking.captured && serviceEnded && !allocated && !p.dispute_until && <>
      <button className="pp-secondary" disabled={!enabled} onClick={() => {
        if (window.confirm("Confirm completion and authorize payment of your full share?")) send("confirm_completion");
      }}>Confirm completion</button>
      {complaintOpen && <button className="pp-secondary" disabled={!enabled} onClick={() => send("open_dispute")}>Open dispute</button>}
    </>}
    {account && canSettle && <button className="pp-secondary" disabled={!enabled} onClick={() => send("settle")}>Apply settlement policy</button>}
    {active && <p>Resolve by {new Date(Number(p.dispute_until) * 1000).toLocaleString()}</p>}
    {workspace}
    {!v2 && !claimOnly && p.dispute_until && (buyer || merchant) && <EvidencePanel key={account + ":" + p.evidence_revision + ":" + verifiedTerms.length}
      verifiedTerms={verifiedTerms}
      account={account} isBuyer={buyer} booking={bookingId} position={index} active={active && enabled}
      sign={async params => {
        const {wallet,accounts} = await walletConnector().getConnectedWallet();
        if (!accounts.some(item => item.accountId === account)) throw new Error("Wallet account changed.");
        return wallet.signMessage({...params, signerId:account, network:"testnet"});
      }} onCommit={commitment => send("revise_evidence",{commitment})} />}
    {!v2 && !claimOnly && active && (buyer || merchant) && <>
      <h4>Resolve dispute</h4>
      <label>Evidence commitment<input maxLength={64} value={evidence} onChange={e => setEvidence(e.target.value)} /></label>
      <button className="pp-secondary" disabled={!enabled || !/^[a-f0-9]{64}$/i.test(evidence)} onClick={() =>
        send("revise_evidence", {commitment: evidence})}>Update commitment</button>
      {!p.extended && <button className="pp-secondary" disabled={!enabled || Boolean(p.extension_approvals & actor)} onClick={() => send("approve_extension")}>Approve 7-day extension</button>}
      <label>Refund amount<input inputMode="numeric" value={refund} onChange={e => setRefund(e.target.value)} /></label>
      {proposed && <p>Refund {BigInt(refund).toString()} · Merchant receives {(BigInt(p.share) - BigInt(refund)).toString()}</p>}
      <button className="pp-secondary" disabled={!enabled || !proposed} onClick={() => send("approve_resolution", {
        refund: BigInt(refund).toString(), payout: (BigInt(p.share) - BigInt(refund)).toString(),
        expires: p.dispute_until, evidence_revision: p.evidence_revision, expected_proposal_version: p.proposal_version,
      })}>Sign proposed split</button>
      <div className="near-evidence">
        <h4>On-chain service remedy</h4>
        {currentRemedy ? <>
          <p>Due {new Date(Number(currentRemedy.due)*1000).toLocaleString()} · Refund {currentRemedy.refund} PDEMO · Payout {currentRemedy.payout} PDEMO</p>
          <p>{currentRemedy.approvals === 3 ? "Both parties accepted" : "Awaiting the other party"} · Evidence <code>{currentRemedy.commitment}</code></p>
          {!(currentRemedy.approvals & actor) && <button className="pp-secondary" disabled={!enabled} onClick={() =>
            send("accept_remedy",{revision:currentRemedy.revision,due:currentRemedy.due})}>Accept remedy on NEAR</button>}
          {buyer && currentRemedy.approvals === 3 && <button className="pp-primary" disabled={!enabled} onClick={() => {
            if (window.confirm("Confirm the remedy was completed and allocate the agreed payout and refund?"))
              send("complete_remedy",{revision:currentRemedy.revision,due:currentRemedy.due});
          }}>Confirm remedy and allocate funds</button>}
        </> : <>
          <p>Commit the encrypted remedy terms above. Use the refund amount and set a deadline within the dispute window.</p>
          <label>On-chain remedy deadline<input type="datetime-local" value={remedyDue} onChange={event => setRemedyDue(event.target.value)} /></label>
          <button className="pp-secondary" disabled={!enabled || !p.evidence_commitment || !proposed || !(due > time && due <= Number(p.dispute_until))}
            onClick={() => send("propose_remedy",{due:String(due),refund,payout:(BigInt(p.share)-BigInt(refund)).toString()})}>
            Propose remedy on NEAR
          </button>
        </>}
      </div>
      {proposal && time < Number(proposal.expires) && <div>
        <p>Proposed refund {proposal.refund} · Merchant payout {proposal.payout} · Approved by {proposal.approvals === 1 ? "buyer" : "merchant"}</p>
        <button className="pp-secondary" disabled={!enabled || Boolean(proposal.approvals & actor)} onClick={() => send("approve_resolution", {
          refund: proposal.refund, payout: proposal.payout, expires: proposal.expires,
          evidence_revision: p.evidence_revision, expected_proposal_version: p.proposal_version,
        })}>Approve this split</button>
      </div>}
    </>}
    {!v2 && p.allocation?.some(amount => amount !== "0") && <ul className="near-share-transfers">
      {p.allocation.map((amount, slot) => amount !== "0" &&
      <li key={slot} className="near-share-transfer"><span>{slot === 0 ? "Buyer refund" : "Merchant payout"}</span>
        <strong>{amount} <small>PDEMO</small></strong>
        <span className={`near-transfer-status${p.claims[slot] === "Paid" ? " near-transfer-received" : ""}`}>{p.claims[slot] === "Unclaimed" ? "Available to claim" : p.claims[slot] === "Pending" ? "Transfer pending" : "Received"}</span>
        {p.claims[slot] === "Unclaimed" && (slot === 0 ? buyer : merchant) &&
          <button className="pp-primary" disabled={!enabled} onClick={() => send("claim", {refund: slot === 0})}>Claim {amount}</button>}
      </li>)}
    </ul>}
    {(buyer || merchant) && <button className="pp-secondary" disabled={!enabled} onClick={register}>Register to receive token</button>}
  </article>;
}
