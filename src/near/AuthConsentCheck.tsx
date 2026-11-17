import {useState} from "react";
import {Auth0Client} from "@auth0/auth0-spa-js";
import {createRemoteJWKSet, jwtVerify} from "jose";
import {createTransaction, encodeTransaction, actionCreators} from "@near-js/transactions";
import {PublicKey} from "@near-js/crypto";
import {baseDecode} from "@near-js/utils";

const domain = "pactpay.us.auth0.com";
const issuer = `https://${domain}/`;
const audience = "auth0.pactpay-530c506b.testnet";
const clientId = "2mxCN1epr2VDuLUv9Pff7b3faVbVd5E6";
const jwks = createRemoteJWKSet(new URL(".well-known/jwks.json",issuer));
const probe = new Auth0Client({domain,clientId,cacheLocation:"memory",authorizationParams:{redirect_uri:location.origin}});

type Prepared = {account:string; funded:boolean; publicKey?:string;nonce?:string;blockHash?:string};
async function request(action:string,token:string) {
  const response = await fetch("/api/near-auth-probe",{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action,token}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error([data.error,data.signingHash,data.userHash].filter(Boolean).join(" "));
  return data;
}

export default function AuthConsentCheck() {
  const [busy,setBusy] = useState(false);
  const [status,setStatus] = useState("Chọn một bài thử để mở form Auth0.");
  const [prepared,setPrepared] = useState<Prepared>();

  async function prepare() {
    const popup = window.open("","_blank","popup,width=520,height=760");
    if (!popup) return setStatus("Hãy cho phép popup trên PactPay.");
    setBusy(true);
    setPrepared(undefined);
    try {
      setStatus("Đang mở đăng nhập để tạo địa chỉ MPC Testnet…");
      await probe.loginWithPopup({authorizationParams:{scope:"openid"}},{popup});
      const claims = await probe.getIdTokenClaims();
      if (!claims?.__raw) throw new Error("Thiếu ID token.");
      const data:Prepared = await request("prepare",claims.__raw);
      setPrepared(data);
      setStatus(data.funded ? "Tài khoản MPC sẵn sàng. Bấm Ký và gửi 0 NEAR."
        : "Nạp 0,05 NEAR Testnet vào địa chỉ dưới đây. Sau đó bấm Chuẩn bị tài khoản MPC lại để cập nhật.");
    } catch(error) {
      setStatus(error instanceof Error ? error.message : "Không chuẩn bị được tài khoản MPC.");
    } finally {
      popup.close();
      setBusy(false);
    }
  }

  async function run(expected: "approve" | "deny" | "broadcast") {
    const live = expected === "broadcast" ? prepared : undefined;
    if (expected === "broadcast" && !live?.funded) return;
    const popup = window.open("","_blank","popup,width=520,height=760");
    if (!popup) {
      setStatus("Hãy cho phép popup trên PactPay.");
      return;
    }
    setBusy(true);
    const key = PublicKey.fromString(live?.publicKey ?? "ed25519:BXDnkF1odJwQA7sEYPH7ToasycqFvUcw3xwmaY4rj1hF");
    const account = Array.from(key.data, byte=>byte.toString(16).padStart(2,"0")).join("");
    const sample = createTransaction(account,key,account,live?.nonce ? BigInt(live.nonce)+1n : 0n,
      [actionCreators.transfer(0n)],live?.blockHash ? baseDecode(live.blockHash) : crypto.getRandomValues(new Uint8Array(32)));
    const bytes = encodeTransaction(sample);
    const auth = new Auth0Client({domain,clientId,cacheLocation:"memory",
      authorizationParams:{redirect_uri:location.origin}});
    const authorizationParams = {audience,scope:"transaction:sign",transaction:Array.from(bytes).join(",")};
    try {
      setStatus(expected === "deny" ? "Chọn Deny trong form xác nhận." : "Chọn Approve trong form xác nhận.");
      await auth.loginWithPopup({authorizationParams},{popup});
      const token = await auth.getTokenSilently({authorizationParams,cacheMode:"cache-only"});
      if (expected === "deny") {
        setStatus(token ? "FAIL · Auth0 cấp token trong lượt thử Deny." : "Chưa xác minh được kết quả Deny.");
        return;
      }
      if (!token) throw new Error("Auth0 chưa cấp token ký.");
      const {payload} = await jwtVerify(token,jwks,{issuer,audience,algorithms:["RS256"],requiredClaims:["exp","sub"]});
      const claim = payload.fatxn;
      if (!Array.isArray(claim) || claim.length !== bytes.length || !bytes.every((byte,i)=>byte === claim[i])) {
        setStatus("FAIL · fatxn thiếu hoặc không khớp giao dịch mẫu.");
        return;
      }
      if (live) {
        setPrepared(undefined);
        setStatus("Đang chờ chữ ký MPC và receipt Testnet…");
        const result = await request("submit",token);
        setStatus(`PASS · Giao dịch Testnet FINAL: ${result.userHash}. Yêu cầu ký: ${result.signingHash}.`);
        return;
      }
      setStatus("PASS · Chữ ký JWT hợp lệ và fatxn khớp từng byte với giao dịch mẫu.");
    } catch (error) {
      const code = error instanceof Error && "error" in error ? String(error.error) : "";
      const message = error instanceof Error ? error.message : "Lỗi không xác định.";
      setStatus(expected === "deny" && code === "access_denied" && /user rejected the signing request/i.test(message)
        ? "PASS · Auth0 từ chối cấp token vì người dùng chọn Deny."
        : "Chưa đạt · " + message);
    } finally {
      popup.close();
      setBusy(false);
    }
  }

  return <main style={{maxWidth:640,margin:"64px auto",padding:24,fontFamily:"system-ui"}}>
    <h1>Kiểm tra xác nhận ký PactPay</h1>
    <p>Hai bài thử Approve và Deny kiểm tra token Auth0. Bài thử phát giao dịch tự chuyển 0 NEAR trên Testnet dùng gas từ tài khoản MPC và relayer.</p>
    <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
      <button disabled={busy} onClick={()=>void run("approve")}>Thử Approve</button>
      <button disabled={busy} onClick={()=>void run("deny")}>Thử Deny</button>
      <button disabled={busy} onClick={()=>void prepare()}>Chuẩn bị tài khoản MPC</button>
      <button disabled={busy || !prepared?.funded} onClick={()=>void run("broadcast")}>Ký và gửi 0 NEAR</button>
    </div>
    <p role="status">{status}</p>
    {prepared && <p style={{overflowWrap:"anywhere"}}>Địa chỉ MPC Testnet <code>{prepared.account}</code></p>}
    <a href="/booking">Quay lại PactPay</a>
  </main>;
}
