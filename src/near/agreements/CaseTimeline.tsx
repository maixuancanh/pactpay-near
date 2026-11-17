import {useEffect, useState} from "react";
import {readCaseHistory} from "./transaction-journal";

const labels = {
  proposal: "Agreement proposed", approval: "Agreement approved",
  completion: "Completion recorded", allocation: "Funds allocated", claim: "Payout transaction",
};

type History = Awaited<ReturnType<typeof readCaseHistory>>;

export default function CaseTimeline({escrow, booking, position, version}: {
  escrow: string; booking: string; position: string; version: string;
}) {
  const [history, setHistory] = useState<History>();
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const scope = {network: "testnet" as const, escrow, booking, position, version};

  useEffect(() => {
    const controller = new AbortController();
    setHistory(undefined);
    setError(false);
    const scope = {network: "testnet" as const, escrow, booking, position, version};
    const timeout = setTimeout(() => {setError(true); controller.abort();}, 20000);
    readCaseHistory(scope, undefined, controller.signal).then(result => {
      if (!controller.signal.aborted) setHistory(result);
    }).catch(() => {
      if (!controller.signal.aborted) setError(true);
    }).finally(() => clearTimeout(timeout));
    const refresh = () => setRetry(value => value + 1);
    window.addEventListener("pactpay:case-indexed", refresh);
    return () => {
      clearTimeout(timeout);
      controller.abort();
      window.removeEventListener("pactpay:case-indexed", refresh);
    };
  }, [escrow, booking, position, version, retry]);

  async function loadMore() {
    const cursor = history?.nextCursor;
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setError(false);
    try {
      const page = await readCaseHistory(scope, cursor);
      setHistory(current => current?.nextCursor === cursor ? {
        ...page, references: [...current.references, ...page.references],
      } : current);
    } catch {
      setError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  return <section className="near-proof-card">
    <h4>Activity on NEAR</h4>
    {error ? <p>Activity is temporarily unavailable.</p> : !history ? <p role="status">Checking activity…</p> : <>
      <p className="near-panel-caption">Some older transactions may be missing from this history.</p>
      {history.references.length === 0 ? <p>No verified transactions are indexed for this agreement yet.</p> :
        <ul>{history.references.map(reference => <li key={`${reference.kind}:${reference.transactionHash}:${reference.receiptIds.join(",")}`}>
          <a href={`https://testnet.nearblocks.io/txns/${encodeURIComponent(reference.transactionHash)}`} target="_blank" rel="noreferrer">
            {labels[reference.kind]} <span>↗</span>
          </a>
        </li>)}</ul>}
      {history.nextCursor && <button type="button" className="pp-secondary" disabled={loadingMore}
        onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Load more activity"}</button>}
    </>}
    <button type="button" className="pp-secondary" onClick={() => setRetry(value => value + 1)}>Refresh activity</button>
  </section>;
}
