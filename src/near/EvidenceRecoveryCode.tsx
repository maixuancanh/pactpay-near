import {useState} from "react";
import {Copy} from "lucide-react";

export default function EvidenceRecoveryCode({code}: {code: string}) {
  const [status, setStatus] = useState("");
  return <div className="near-recovery-code">
    <strong>Save your recovery code</strong>
    <p>Keep it somewhere private, then paste it into the Recovery code field below.</p>
    <div className="near-recovery-value">
      <code>{code}</code>
      <button type="button" className="pp-secondary" onClick={async () => {
        try {
          await navigator.clipboard.writeText(code);
          setStatus("Copied to clipboard.");
        } catch {
          setStatus("Select the code and copy it manually.");
        }
      }}><Copy size={16} aria-hidden="true" /> Copy</button>
    </div>
    <span role="status">{status}</span>
  </div>;
}
