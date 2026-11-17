import EvidenceRecoveryCode from "../EvidenceRecoveryCode";
import {useEffect, useLayoutEffect, useRef, useState} from "react";
import type {SignChallenge} from "../EvidencePanel";
import {createEvidenceKey, decode, encryptEvidence, openEvidence, restoreEvidenceKey} from "../evidence-crypto";
import {verifyEvidenceManifest} from "./evidence-manifest";
import type {EvidenceCase, EvidenceEntry, EvidenceKind} from "./evidence-manifest";
import type {AssessmentCase} from "./assessment-digest.mjs";

type Profile = Awaited<ReturnType<typeof createEvidenceKey>>["profile"];
type KeySetup = Awaited<ReturnType<typeof createEvidenceKey>>;
type Peer = {account:string;key:JsonWebKey|null};
type Envelope = {ciphertext:string;iv:string;wrapped:string};
type AiBudget = {limit:number;remaining:number;resetsAt:string;maxOutputTokens:number};
type PendingUpload = Awaited<ReturnType<typeof encryptEvidence>> & {
  kind: EvidenceKind;
  sequence: number;
  previousEntryHash: string|null;
  supersedes: string|null;
  idempotencyKey: string;
};
export type EvidenceSnapshot = {entries:EvidenceEntry[];evidenceRoot:string};
export type OpenedEvidence = {entry:EvidenceEntry;item:Envelope;text:string;excerptKey:string};
export type EvidenceAssessment = Awaited<ReturnType<typeof import("../claimguard").analyzeResolutionEvidence>>;
type Props = {
  account:string; escrow:string; booking:string; position:number; sign:SignChallenge;
  onSnapshot:(snapshot:EvidenceSnapshot)=>void;
  onSelect:(entry:EvidenceEntry)=>void;
  onOpen?:(opened:OpenedEvidence)=>void;
  assessmentCase?:Omit<AssessmentCase,"evidenceRoot">;
  verifiedTerms?:string;
  onAnalysis?:(analysis:EvidenceAssessment,scope:AssessmentCase)=>void;
  historicalRoot?:string;
  onHistoricalSnapshot?:(snapshot:EvidenceSnapshot|null)=>void;
};

const kinds: Record<EvidenceKind,string> = {
  evidence:"Evidence",
  agreement_terms:"Private agreement terms",
  completion:"Completion evidence",
};

class EvidenceRequestError extends Error {
  constructor(message:string, readonly status:number) { super(message); }
}

async function request<T>(scope:EvidenceCase, action:string, args:object, session:string, signal:AbortSignal):Promise<T> {
  const response = await fetch("/api/near-evidence",{
    method:"POST",
    headers:{"Content-Type":"application/json",...(session ? {Authorization:"Bearer "+session} : {})},
    body:JSON.stringify({action,...args,...scope}),
    signal:AbortSignal.any([signal,AbortSignal.timeout(20000)]),
  });
  const data = await response.json().catch(()=>null);
  if (!response.ok || !data) throw new EvidenceRequestError(data?.error || "Private evidence service unavailable.",response.status);
  return data as T;
}

export default function ResolutionEvidence(props:Props) {
  const {account,escrow,booking,position} = props;
  return <ResolutionEvidenceCase key={JSON.stringify([account,escrow,booking,position])} {...props} />;
}

function ResolutionEvidenceCase({account,escrow,booking,position,sign,onSnapshot,onSelect,onOpen,assessmentCase,verifiedTerms,onAnalysis,historicalRoot,onHistoricalSnapshot}:Props) {
  const scope:EvidenceCase = {network:"testnet",escrow,booking,position};
  const [session,setSession] = useState("");
  const [profile,setProfile] = useState<Profile|null>(null);
  const [created,setCreated] = useState<KeySetup>();
  const [recoveryCode,setRecoveryCode] = useState("");
  const [privateKey,setPrivateKey] = useState<CryptoKey>();
  const [peer,setPeer] = useState<Peer>();
  const [snapshot,setSnapshot] = useState<EvidenceSnapshot>();
  const [opened,setOpened] = useState<OpenedEvidence>();
  const [historicalStatus,setHistoricalStatus] = useState("");
  const [historyRefresh,setHistoryRefresh] = useState(0);
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [draft,setDraft] = useState("");
  const [kind,setKind] = useState<EvidenceKind>("evidence");
  const [supersedes,setSupersedes] = useState("");
  const [reviewed,setReviewed] = useState(false);
  const [pending,setPending] = useState<PendingUpload>();
  const [revoke,setRevoke] = useState<EvidenceEntry>();
  const [busy,setBusy] = useState(false);
  const [status,setStatus] = useState("");
  const [aiBudget,setAiBudget] = useState<AiBudget>();
  const assessedInputs = useRef(new Set<string>());
  const active = useRef<AbortController|null>(null);
  useLayoutEffect(()=>()=>active.current?.abort(),[]);
  const historicalListener = useRef(onHistoricalSnapshot);
  useLayoutEffect(()=>{historicalListener.current = onHistoricalSnapshot;},[onHistoricalSnapshot]);
  useEffect(()=>{
    if (!session || !historicalRoot) {
      setHistoricalStatus("");
      return;
    }
    const controller = new AbortController();
    const historicalCase:EvidenceCase = {network:"testnet",escrow,booking,position};
    async function load() {
      setHistoricalStatus("Checking the signed evidence snapshot.");
      try {
        const result = await request<EvidenceSnapshot>(historicalCase,"list",{evidenceRoot:historicalRoot},session,controller.signal);
        if (result.evidenceRoot !== historicalRoot || await verifyEvidenceManifest(historicalCase,result.entries) !== historicalRoot) {
          throw new Error("Invalid snapshot.");
        }
        controller.signal.throwIfAborted();
        historicalListener.current?.(result);
        setHistoricalStatus("Signed evidence snapshot verified.");
      } catch {
        if (!controller.signal.aborted) {
          historicalListener.current?.(null);
          setHistoricalStatus("Signed evidence snapshot is unavailable or could not be verified.");
        }
      }
    }
    void load();
    return ()=>controller.abort();
  },[session,historicalRoot,escrow,booking,position,historyRefresh]);

  async function run(work:(signal:AbortSignal)=>Promise<void>) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setStatus("");
    try { await work(controller.signal); }
    catch(error) {
      if (!controller.signal.aborted) setStatus(error instanceof Error ? error.message : "Unable to complete the evidence request.");
    }
    finally {
      active.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  async function refresh(token:string,signal:AbortSignal) {
    const next = await request<EvidenceSnapshot>(scope,"list",{},token,signal);
    if (await verifyEvidenceManifest(scope,next.entries) !== next.evidenceRoot) throw new Error("Evidence history failed verification.");
    signal.throwIfAborted();
    setSnapshot(next);
    onSnapshot(next);
    return next;
  }

  async function login(signal:AbortSignal) {
    const challenge = await request<{token:string;message:string;recipient:string;nonce:string}>(scope,"challenge",{account},"",signal);
    const signature = await sign({message:challenge.message,recipient:challenge.recipient,
      nonce:Uint8Array.from(challenge.nonce.match(/../g) || [],byte=>parseInt(byte,16))});
    signal.throwIfAborted();
    if (signature.accountId !== account) throw new Error("The signing wallet changed. Sign in again.");
    const {session:token} = await request<{session:string}>(scope,"login",{token:challenge.token,...signature},"",signal);
    const [{profile:stored},peerRecord] = await Promise.all([
      request<{profile:Profile|null}>(scope,"restore",{},token,signal),
      request<Peer>(scope,"peer",{},token,signal),
    ]);
    await refresh(token,signal);
    signal.throwIfAborted();
    setSession(token);
    if (stored?.key.n !== profile?.key.n) setPrivateKey(undefined);
    setProfile(stored);
    if (stored) setCreated(undefined);
    setPeer(peerRecord);
    setReviewed(false);
    setStatus("Evidence sign-in is active for this wallet.");
  }

  async function unlock(signal:AbortSignal) {
    const record = created?.profile || profile;
    if (!record) return;
    const key = await restoreEvidenceKey(record,recoveryCode);
    signal.throwIfAborted();
    if (created) {
      await request(scope,"register",record,session,signal);
      signal.throwIfAborted();
      setProfile(record);
      setCreated(undefined);
    }
    setPrivateKey(key);
    setRecoveryCode("");
    setStatus("Evidence key restored on this device.");
  }

  async function share(signal:AbortSignal) {
    if (!profile || !privateKey || !peer?.key || !snapshot) return;
    let requestBody = pending;
    if (!requestBody) {
      const currentPeer = await request<Peer>(scope,"peer",{},session,signal);
      if (currentPeer.account !== peer.account || currentPeer.key?.n !== peer.key.n) {
        setPeer(currentPeer);
        setReviewed(false);
        throw new Error("The recipient key changed. Review the recipient before sharing.");
      }
      const last = snapshot.entries.filter(entry=>entry.author===account).at(-1);
      const text = kind === "agreement_terms" ? draft.trim() + "\n\nAcceptance criteria\n" + acceptanceCriteria.trim() : draft;
      const envelope = await encryptEvidence(text,{[account]:profile.key,[peer.account]:peer.key});
      signal.throwIfAborted();
      requestBody = {...envelope,kind,sequence:(last?.sequence ?? 0)+1,previousEntryHash:last?.entryHash ?? null,
        supersedes:supersedes || null,idempotencyKey:crypto.randomUUID()};
      setPending(requestBody);
    }
    try {
      const {entry} = await request<{entry:EvidenceEntry}>(scope,"upload",requestBody,session,signal);
      const next = await refresh(session,signal);
      const confirmed = next.entries.find(record=>record.entryHash === entry.entryHash);
      if (!confirmed) throw new Error("Upload is awaiting confirmation. Retry the same encrypted upload.");
      setPending(undefined);
      setDraft("");
      setAcceptanceCriteria("");
      setReviewed(false);
      setSupersedes("");
      setStatus("Encrypted evidence shared.");
    } catch (error) {
      if (error instanceof EvidenceRequestError && error.status === 409) {
        await refresh(session,signal);
        setPending(undefined);
        setReviewed(false);
      }
      throw error;
    }
  }

  async function read(entry:EvidenceEntry,signal:AbortSignal) {
    if (!privateKey) return;
    setOpened(undefined);
    const result = await request<{item:Envelope|null;entry:EvidenceEntry|null}>(scope,"read",
      {author:entry.author,sequence:entry.sequence},session,signal);
    if (!result.item || result.entry?.entryHash !== entry.entryHash) throw new Error("Evidence history changed. Refresh the record.");
    const decrypted = await openEvidence(result.item,privateKey,entry.ciphertextHash);
    signal.throwIfAborted();
    const next = {entry,item:result.item,...decrypted};
    setOpened(next);
    onOpen?.(next);
  }

  async function assess(source:OpenedEvidence,signal:AbortSignal) {
    if (!snapshot || !assessmentCase || !verifiedTerms || !onAnalysis) return;
    if (assessmentCase.network !== scope.network || assessmentCase.escrow !== escrow ||
        assessmentCase.booking !== booking || assessmentCase.position !== String(position) ||
        !snapshot.entries.some(entry=>entry.entryHash===source.entry.entryHash)) {
      throw new Error("Refresh the evidence and verify the booking terms before requesting assessment.");
    }
    if (new TextEncoder().encode(verifiedTerms+source.text).length > 16000) {
      throw new Error("Select a shorter excerpt for the encrypted assessment.");
    }
    const inputKey = JSON.stringify([assessmentCase,snapshot.evidenceRoot,source.entry.entryHash]);
    const current = await request<{budget:AiBudget}>(scope,"ai_budget",{},session,signal);
    signal.throwIfAborted();
    setAiBudget(current.budget);
    if (!current.budget.remaining) throw new Error("Today's AI attempts for this share are used. You can still agree manually.");
    const repeated = assessedInputs.current.has(inputKey);
    if (!window.confirm(`${repeated ? "You already requested analysis of this evidence and agreement version. Run it again?\n\n" : "Run an encrypted AI review?\n\n"}${current.budget.remaining} of ${current.budget.limit} attempts remain for your account on this share today (UTC). This reserves one attempt, even if the provider fails. Output is capped at ${current.budget.maxOutputTokens} tokens. AI cannot approve or pay an agreement.`)) return;
    const {ticket,budget} = await request<{ticket:string;budget:AiBudget}>(scope,"ai_ticket",{},session,signal);
    signal.throwIfAborted();
    setAiBudget(budget);
    assessedInputs.current.add(inputKey);
    const {analyzeResolutionEvidence} = await import("../claimguard");
    signal.throwIfAborted();
    const reviewScope = {...assessmentCase,evidenceRoot:snapshot.evidenceRoot};
    const paragraphs = source.text.split(/\r?\n\s*\r?\n/).filter(paragraph=>paragraph.trim());
    try {
      const analysis = await analyzeResolutionEvidence(ticket,reviewScope,verifiedTerms,[{id:source.entry.entryHash,paragraphs}]);
      signal.throwIfAborted();
      onAnalysis(analysis,reviewScope);
      setStatus(`AI assessment ready to review. ${(analysis.metrics.elapsedMs/1000).toFixed(1)} seconds including verification.${analysis.metrics.usage ? ` Provider reports ${analysis.metrics.usage.totalTokens} tokens used.` : " Provider token usage unavailable."}`);
    } catch {
      throw new Error("Verified AI assessment is unavailable. You can continue with a manual agreement.");
    }
  }

  return <section className="near-evidence" aria-label="Private evidence">
    <h4>Private evidence</h4>
    <p className="pp-muted">Upload excerpts using wallet-linked encryption for the buyer and merchant.</p>
    {onAnalysis && <p className="pp-muted">AI review: up to 3 attempts per account and share each UTC day. Each attempt reserves quota, including failed requests; no automatic retries.
      {aiBudget && <> {aiBudget.remaining} remaining. Resets <time dateTime={aiBudget.resetsAt}>{new Date(aiBudget.resetsAt).toLocaleString()}</time>.</>}
    </p>}
    <button type="button" className="pp-secondary" disabled={busy || !account} onClick={()=>void run(login)}>
      {session ? "Renew evidence sign-in" : "Sign in with NEAR wallet"}
    </button>
    {session && !profile && !created && <button type="button" className="pp-secondary" disabled={busy}
      onClick={()=>void run(async signal=>{
        const setup = await createEvidenceKey();
        signal.throwIfAborted();
        setCreated(setup);
      })}>Create evidence key</button>}
    {created && <><EvidenceRecoveryCode key={created.code} code={created.code}/></>}
    {session && (created || profile) && !privateKey && <>
      <label>Recovery code<input type="password" autoComplete="off" value={recoveryCode} disabled={busy}
        onChange={event=>setRecoveryCode(event.currentTarget.value)} /></label>
      <button type="button" className="pp-primary" disabled={busy || !recoveryCode} onClick={()=>void run(unlock)}>Unlock evidence</button>
    </>}
    {session && <button type="button" className="pp-secondary" disabled={busy} onClick={()=>void run(async signal=>{
      const recipient = await request<Peer>(scope,"peer",{},session,signal);
      await refresh(session,signal);
      setPeer(recipient);
      setReviewed(false);
      setHistoryRefresh(previous=>previous+1);
    })}>Refresh evidence</button>}

    {snapshot && (snapshot.entries.length ? <ol>
      {snapshot.entries.map(entry=><li key={entry.entryHash}>
        <p style={{overflowWrap:"anywhere"}}>{kinds[entry.kind]} · {entry.author} · #{entry.sequence} · <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleString()}</time></p>
        <button type="button" className="pp-secondary" disabled={busy || !privateKey} onClick={()=>void run(signal=>read(entry,signal))}
          aria-label={"Open "+kinds[entry.kind]+" from "+entry.author+" number "+entry.sequence}>Open excerpt</button>
        {opened?.entry.entryHash === entry.entryHash && <>
          <div className="near-opened"><pre>{opened.text}</pre></div>
          <button type="button" className="pp-secondary" disabled={busy} onClick={()=>onSelect(entry)}>Select for agreement</button>
          {onAnalysis && assessmentCase && <button type="button" className="pp-secondary" disabled={busy || !verifiedTerms}
            onClick={()=>void run(signal=>assess(opened,signal))}>Analyze excerpt with encrypted AI</button>}
        </>}
        {entry.author === account && <button type="button" className="pp-secondary" disabled={busy} onClick={()=>setRevoke(entry)}>
          Revoke shared key
        </button>}
        {revoke?.entryHash === entry.entryHash && <div className="pp-note">
          <p>Revoking blocks future key requests. The recipient can still open copies they already downloaded.</p>
          <button type="button" className="pp-secondary" disabled={busy} onClick={()=>void run(async signal=>{
            await request(scope,"revoke",{sequence:entry.sequence},session,signal);
            signal.throwIfAborted();
            setRevoke(undefined);
            setStatus("Future requests for this shared key are blocked.");
          })}>Confirm revocation</button>
          <button type="button" className="pp-secondary" disabled={busy} onClick={()=>setRevoke(undefined)}>Cancel</button>
        </div>}
      </li>)}
    </ol> : <p>No evidence has been shared for this position.</p>)}

    {privateKey && peer && !peer.key && <p>The other party needs to set up their evidence key before receiving excerpts.</p>}
    {privateKey && peer?.key && snapshot && <>
      <label>Record type<select value={kind} disabled={busy || !!pending}
        onChange={event=>{setKind(event.currentTarget.value as EvidenceKind);setReviewed(false);}}>
        {Object.entries(kinds).map(([value,label])=><option key={value} value={value}>{label}</option>)}
      </select></label>
      {!!snapshot.entries.some(entry=>entry.author === account) && <label>Previous record to supersede<select value={supersedes}
        disabled={busy || !!pending} onChange={event=>{setSupersedes(event.currentTarget.value);setReviewed(false);}}>
        <option value="">None</option>
        {snapshot.entries.filter(entry=>entry.author===account).map(entry=>
          <option key={entry.entryHash} value={entry.entryHash}>{kinds[entry.kind]} #{entry.sequence}</option>)}
      </select></label>}
      <label>Import an excerpt<input type="file" accept=".txt,.md,.pdf,.png,.jpg,.jpeg,.webp" disabled={busy || !!pending}
        onChange={event=>{
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void run(async signal=>{
            const {readEvidenceFile}=await import("../evidence-import");
            const text = await readEvidenceFile(file);
            signal.throwIfAborted();
            setDraft(text);
            setReviewed(false);
          });
        }} /></label>
      <label>Exact excerpt to share<textarea value={draft} disabled={busy || !!pending} onChange={event=>{
        setDraft(event.currentTarget.value);
        setReviewed(false);
      }} /></label>
      {kind === "agreement_terms" && <label>Acceptance criteria
        <textarea value={acceptanceCriteria} disabled={busy || !!pending}
          placeholder="Describe what the buyer must see before confirming completion."
          onChange={event=>{setAcceptanceCriteria(event.currentTarget.value);setReviewed(false);}} />
      </label>}
      <p style={{overflowWrap:"anywhere"}}>Recipient <strong>{peer.account}</strong></p>
      <label className="pp-check"><input type="checkbox" checked={reviewed} disabled={busy || !!pending} onChange={event=>setReviewed(event.currentTarget.checked)} />
        I reviewed the excerpt and removed details the recipient should not receive.
      </label>
      <button type="button" className="pp-primary" disabled={busy || (!pending && (!draft.trim() || !reviewed || (kind === "agreement_terms" && !acceptanceCriteria.trim())))}
        onClick={()=>void run(share)}>{pending ? "Retry encrypted upload" : "Encrypt and share"}</button>
    </>}
    {historicalStatus && <p role="status">{historicalStatus}</p>}
    <p role="status">{status}</p>
  </section>;
}
