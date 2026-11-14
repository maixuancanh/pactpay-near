import EvidenceRecoveryCode from "./EvidenceRecoveryCode";
import {useState} from "react";
import {escrow, view} from "./chain";
import type {Booking, Remedy as OnChainRemedy} from "./chain";
import {createEvidenceKey, restoreEvidenceKey, encryptEvidence, decryptEvidence, openEvidence} from "./evidence-crypto";

type Profile = Awaited<ReturnType<typeof createEvidenceKey>>["profile"];
type Remedy = {id:string;offer:{by:string;due:number;evidenceId:string;at:number};
  acceptance:{by:string;at:number}|null;completion:{by:string;at:number}|null};
type Signature = {accountId:string;publicKey:string;signature:string};
export type SignChallenge = (params:{message:string;recipient:string;nonce:Uint8Array})=>Promise<Signature>;

async function request<T>(action:string, args:object, session?:string):Promise<T> {
  const response = await fetch("/api/near-evidence", {
    method:"POST", headers:{"Content-Type":"application/json",...(session ? {Authorization:"Bearer "+session} : {})},
    body:JSON.stringify({action,...args}), signal:AbortSignal.timeout(20000),
  });
  const data = await response.json().catch(()=>null);
  if (!response.ok || !data) throw new Error(data?.error || "Private evidence service unavailable.");
  return data as T;
}

export default function EvidencePanel({account,booking,position,active,isBuyer,sign,onCommit,verifiedTerms}:{
  account:string; booking:number; position:number; active:boolean; isBuyer:boolean;
  sign:SignChallenge; verifiedTerms:string; onCommit:(id:string)=>void;
}) {
  const [session,setSession]=useState("");
  const [profile,setProfile]=useState<Profile|null>();
  const [created,setCreated]=useState<Awaited<ReturnType<typeof createEvidenceKey>>>();
  const [code,setCode]=useState("");
  const [key,setKey]=useState<CryptoKey>();
  const [remedies,setRemedies]=useState<Remedy[]>([]);
  const [due,setDue]=useState("");
  const [redactions,setRedactions]=useState("");
  const [reviewed,setReviewed]=useState(false);
  const [draft,setDraft]=useState("");
  const [category,setCategory]=useState("Evidence");
  const [items,setItems]=useState<string[]>([]);
  const [opened,setOpened]=useState<{id:string;text:string}>();
  const [uploaded,setUploaded]=useState("");
  const [analysis,setAnalysis]=useState<Awaited<ReturnType<typeof import("./claimguard").analyzeEvidence>>>();
  const [status,setStatus]=useState("");
  const [busy,setBusy]=useState(false);
  const scope={booking,position};
  async function run(work:()=>Promise<void>) {
    setBusy(true);setStatus("");
    try {await work();}
    catch(error){setStatus(error instanceof Error ? error.message : "Unable to process evidence.");}
    finally {setBusy(false);}
  }
  async function login(){
    setKey(undefined);setOpened(undefined);setAnalysis(undefined);setCode("");setCreated(undefined);
    const challenge=await request<{token:string;nonce:string;message:string;recipient:string}>("challenge",{account});
    const nonce=Uint8Array.from(challenge.nonce.match(/../g) || [],b=>parseInt(b,16));
    const signature=await sign({nonce,message:challenge.message,recipient:challenge.recipient});
    const result=await request<{session:string}>("login",{token:challenge.token,...signature});
    const records=await request<{profile:Profile|null}>("restore",{},result.session);
    const listing=await request<{items:string[]}>("list",scope,result.session);
    setSession(result.session);setProfile(records.profile);setItems(listing.items);
    await listRemedies(result.session);
  }
  async function unlock(){
    const record=created?.profile || profile;
    if(!record) return;
    const restored=await restoreEvidenceKey(record,code);
    if(created){
      await request("register",record,session);
      setProfile(record);setCreated(undefined);
    }
    setKey(restored);setCode("");
    setStatus("Evidence key unlocked on this device.");
  }
  async function listRemedies(token=session) {
    setRemedies((await request<{offers:Remedy[]}>("remedy_list",scope,token)).offers);
  }
  async function downloadCase(){
    if(!opened || !key)return;
    const [{item}, chain, timeline, onChainRemedy]=await Promise.all([
      request<{item:{ciphertext:string;iv:string;wrapped:string}|null}>("read",{...scope,id:opened.id},session),
      view<Booking|null>(escrow,"get_booking",{id:booking}),
      request<{offers:Remedy[]}>("remedy_list",scope,session),
      view<OnChainRemedy | null>(escrow,"get_remedy",{id:booking,index:position}),
    ]);
    if(!item || !chain)throw new Error("The evidence or on-chain booking is unavailable.");
    const {text,excerptKey}=await openEvidence(item,key,opened.id);
    downloadJson("pactpay-private-case.json",{network:"testnet",escrow,account,booking,position,
      evidence:{id:opened.id,text,excerptKey,ciphertext:item.ciphertext,iv:item.iv},
      analysis:analysis??null,remedies:timeline.offers,onChainRemedy,publicPosition:chain.positions[position],
      exportedAt:new Date().toISOString()});
  }
  function downloadJson(name:string,value:unknown) {
    const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:"application/json"}));
    const link=document.createElement("a");
    link.href=url;link.download=name;link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function downloadBackup(record:Profile){
    const url=URL.createObjectURL(new Blob([JSON.stringify({account,profile:record})],{type:"application/json"}));
    const link=document.createElement("a");
    link.href=url;link.download="pactpay-encrypted-evidence-key.json";link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function upload(){
    if(!profile || !key) return;
    const peer=await request<{account:string;key:JsonWebKey|null}>("peer",scope,session);
    if(!peer.key) throw new Error("The other party must set up an evidence key before you can share.");
    const envelope=await encryptEvidence(category + ":\n" + draft,{[account]:profile.key,[peer.account]:peer.key});
    const {id}=await request<{id:string}>("upload",{...scope,...envelope},session);
    setUploaded(id);setDraft("");setReviewed(false);setItems(previous=>[...new Set([...previous,id])]);
    setStatus("Encrypted evidence shared. Record the commitment on NEAR separately.");
  }
  async function open(id:string){
    if(!key)return;
    setAnalysis(undefined);
    const {item}=await request<{item:{ciphertext:string;iv:string;wrapped:string}|null}>("read",{...scope,id},session);
    if(!item)throw new Error("Evidence not found.");
    setOpened({id,text:await decryptEvidence(item,key,id)});
  }
  return <section className="near-evidence">
    <h4>Private evidence</h4>
    <p className="pp-muted">Evidence is encrypted for the merchant and the buyer.</p>
    <button className="pp-secondary" disabled={busy} onClick={()=>void run(login)}>{session?"Renew evidence sign-in":"Sign in with NEAR wallet"}</button>
    {session && profile===null && !created && <button className="pp-secondary" disabled={busy} onClick={()=>void run(async()=>setCreated(await createEvidenceKey()))}>Create evidence key</button>}
    {created && <><EvidenceRecoveryCode key={created.code} code={created.code}/>
      <button type="button" className="pp-secondary" onClick={()=>downloadBackup(created.profile)}>Download encrypted key backup</button></>}
    {session && !created && <label>Import encrypted key backup<input type="file" accept=".json,application/json" disabled={busy} onChange={event=>{
      const file=event.currentTarget.files?.[0];event.currentTarget.value="";
      if(!file)return;
      void run(async()=>{
        if(file.size>20000) throw new Error("Invalid evidence backup.");
        const backup=JSON.parse(await file.text());
        if(backup.account!==account || !backup.profile?.key?.n || (profile && profile.key.n!==backup.profile.key.n))
          throw new Error("This backup does not match your evidence account.");
        setKey(undefined);setOpened(undefined);setAnalysis(undefined);setProfile(backup.profile);
      });
    }}/></label>}
    {(created || profile) && !key && <label>Recovery code<input type="password" autoComplete="off" value={code} onChange={e=>setCode(e.target.value)} /></label>}
    {(created || profile) && !key && <button className="pp-primary" disabled={busy || !code} onClick={()=>void run(unlock)}>Unlock evidence</button>}
    {key && <>
      <button className="pp-secondary" disabled={busy} onClick={()=>void run(async()=>setItems((await request<{items:string[]}>("list",scope,session)).items))}>Refresh evidence</button>
      {items.map(id=><button className="pp-secondary" key={id} disabled={busy} onClick={()=>void run(()=>open(id))}>Open {id.slice(0,10)}</button>)}
      <button className="pp-secondary" disabled={busy} onClick={()=>void run(()=>listRemedies())}>Refresh remedies</button>
      {remedies.map(({id,offer,acceptance,completion})=><div className="pp-note" key={id}>
        <p>Remedy from {offer.by} · due {new Date(offer.due*1000).toLocaleString()}</p>
        <p>{completion ? "Buyer confirmed completion" : offer.due*1000<=Date.now() ? "Deadline passed" : acceptance ? "Accepted" : "Awaiting the other party"}</p>
        <button className="pp-secondary" disabled={busy} onClick={()=>void run(()=>open(offer.evidenceId))}>Read remedy terms</button>
        {active && !acceptance && opened?.id===offer.evidenceId && offer.by!==account &&
          <button className="pp-secondary" disabled={busy} onClick={()=>void run(async()=>{
            await request("remedy_accept",{...scope,id},session);await listRemedies();
          })}>Accept remedy</button>}
        {active && acceptance && !completion && <button className="pp-secondary" disabled={busy || !isBuyer} onClick={()=>void run(async()=>{
          await request("remedy_complete",{...scope,id},session);await listRemedies();
        })}>Confirm remedy completed</button>}
      </div>)}
      {opened && <div className="near-opened"><p>Evidence {opened.id.slice(0,10)}</p><pre>{opened.text}</pre>
        <button className="pp-secondary" disabled={busy || !verifiedTerms} onClick={()=>void run(async()=>{
          if(new TextEncoder().encode(verifiedTerms + opened.text).length > 16000) throw new Error("Select a shorter evidence excerpt for analysis.");
          setAnalysis(undefined);
          const {ticket}=await request<{ticket:string}>("ai_ticket",scope,session);
          const {analyzeEvidence}=await import("./claimguard");
          setAnalysis(await analyzeEvidence(ticket,verifiedTerms,opened.text));
        })}>Analyze with NEAR AI</button>
        {!verifiedTerms && <p>Verify the booking terms before analysis.</p>}
        <button className="pp-secondary" disabled={busy} onClick={()=>void run(downloadCase)}>Export private case (readable JSON)</button>
        <p>Share this file only with authorized reviewers. It contains the readable excerpt and its verification key. If analyzed, it also contains the signed encrypted AI transcript.</p>
        {active && <><label>Remedy deadline<input type="datetime-local" value={due} onChange={e=>setDue(e.target.value)} /></label>
        <button className="pp-secondary" disabled={busy || !due} onClick={()=>void run(async()=>{
          await request("remedy_propose",{...scope,due:Math.floor(new Date(due).getTime()/1000),evidenceId:opened.id},session);
          await listRemedies();
        })}>Propose remedy with this evidence</button>
        <p>Remedy records do not extend the dispute window or move funds. Use the settlement controls to approve a payment split.</p></>}
        {analysis && <><p>Verified model response · <code>{analysis.id}</code></p><pre>{analysis.text}</pre></>}
      </div>}
      {active && <label>Import evidence<input type="file" accept=".txt,.md,.pdf,.png,.jpg,.jpeg,.webp" disabled={busy} onChange={event=>{
        const file=event.currentTarget.files?.[0];event.currentTarget.value="";
        if(file) void run(async()=>{
          const {readEvidenceFile}=await import("./evidence-import");
          setDraft((await readEvidenceFile(file)).slice(0,150000));setReviewed(false);
          setStatus("Review the extracted text and remove sensitive details before sharing.");
        });
      }}/></label>}
      {active && <label>Record type<select value={category} onChange={event=>setCategory(event.target.value)}>
        <option>Evidence</option><option>Service milestone</option><option>Response</option><option>Proposed remedy</option>
      </select></label>}
      {active && <label>Evidence text<textarea value={draft} onChange={e=>{setDraft(e.target.value);setReviewed(false);}} placeholder="Paste the relevant excerpt or notes" /></label>}
      {active && <><label>Additional text to hide, one value per line<textarea value={redactions} onChange={e=>setRedactions(e.target.value)} /></label>
        <button className="pp-secondary" disabled={busy || !draft.trim()} onClick={()=>void run(async()=>{
          const {redactEvidence}=await import("./evidence-import");
          setDraft(redactEvidence(draft,redactions));setReviewed(false);
        })}>Mask emails, numbers and selected text</button>
        <label className="pp-check"><input type="checkbox" checked={reviewed} onChange={e=>setReviewed(e.target.checked)} />I reviewed the exact text shared with the other party.</label>
      </>}
      {active && <button className="pp-primary" disabled={busy || !draft.trim() || !reviewed} onClick={()=>void run(upload)}>Encrypt and share</button>}
      {active && uploaded && <button className="pp-secondary" disabled={busy} onClick={()=>onCommit(uploaded)}>Record commitment on NEAR</button>}
    </>}
    {status && <p role="status">{status}</p>}
  </section>;
}
