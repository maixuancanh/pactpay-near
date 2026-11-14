import {useState} from "react";

export default function IntentsQuote(){
  const [quote,setQuote]=useState<{amountIn:string;amountOut:string;recipient:string;timeEstimate:number}>();
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  return <section className="pp-panel near-intents" aria-labelledby="near-intents-title">
    <h2 id="near-intents-title">Cross-chain quote · Mainnet</h2>
    <p>Preview a Base USDC swap to a NEAR mainnet account. This quote does not fund your testnet booking.</p>
    <form className="pp-form" onSubmit={async event=>{
      event.preventDefault();
      const form=new FormData(event.currentTarget);
      setBusy(true);setError("");setQuote(undefined);
      try{
        const response=await fetch("/api/near-intents-quote",{method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify(Object.fromEntries(form)),signal:AbortSignal.timeout(12000)});
        const data=await response.json();
        if(!response.ok)throw new Error(data.error);
        setQuote(data);
      }catch(e){setError(e instanceof Error?e.message:"Quote unavailable.");}
      finally{setBusy(false);}
    }}>
      <label>Base refund address<input name="refundTo" required /></label>
      <label>NEAR mainnet recipient<input name="recipient" required /></label>
      <label>USDC to receive<input name="amount" inputMode="decimal" defaultValue="5" required /></label>
      <button className="pp-secondary" disabled={busy}>{busy?"Getting quote…":"Get mainnet quote"}</button>
    </form>
    {error&&<p role="alert">{error}</p>}
    {quote&&<p role="status">{quote.amountIn} USDC on Base → {quote.amountOut} USDC on NEAR for <code>{quote.recipient}</code>. Estimated {quote.timeEstimate}s.</p>}
  </section>;
}
