import {Auth0Client} from "@auth0/auth0-spa-js";
import {PublicKey} from "@near-js/crypto";
import {actionCreators,createTransaction,encodeTransaction} from "@near-js/transactions";
import {baseDecode,baseEncode} from "@near-js/utils";
import {useEffect,useRef,useState} from "react";

const clientId = import.meta.env.VITE_NEAR_AUTH_TESTNET_CLIENT_ID || "";
const domain = import.meta.env.VITE_NEAR_AUTH_TESTNET_DOMAIN?.trim() || undefined;
type Profile = {name?: string; email?: string; picture?: string};
let provider: Promise<import("@auth0/auth0-spa-js").Auth0Client> | undefined;
const auth = () => provider ??= import("@auth0/auth0-spa-js")
  .then(({Auth0Client}) => new Auth0Client({
    domain: domain ?? "login.testnet.fast-auth.com",
    clientId,
    authorizationParams: {redirect_uri: window.location.origin, scope:"openid profile email"},
  }));
let restore: Promise<Profile | undefined> | undefined;

const sessionRestore = () => restore ??= restoreProfile();

async function restoreProfile() {
  const client = await auth();
  const params = new URLSearchParams(location.search);
  if (params.has("state") && (params.has("code") || params.has("error"))) {
    try {
      const {appState} = await client.handleRedirectCallback();
      const target = new URL(appState?.returnTo ?? "/booking", location.origin);
      history.replaceState(history.state, "", target.origin === location.origin ? target.href : "/booking");
    } catch (error) {
      history.replaceState(history.state, "", "/booking");
      throw error;
    }
  } else {
    await client.checkSession({timeoutInSeconds:8});
  }
  return client.getUser();
}

export async function profileRequest<T>(action: string, data: Record<string, unknown> = {}): Promise<T> {
  const claims = await (await auth()).getIdTokenClaims();
  if (!claims?.__raw) throw new Error("Sign in again to manage linked wallets.");
  const response = await fetch("/api/near-profile", {
    method:"POST",
    headers:{"Content-Type":"application/json", Authorization:"Bearer " + claims.__raw},
    body:JSON.stringify({action,...data}),
    signal:AbortSignal.timeout(20000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Profile request failed.");
  return result;
}

export async function readSocialMpcAccount(signal: AbortSignal, activate = false): Promise<{account:string; funded:boolean;publicKey?:string;nonce?:string;blockHash?:string}> {
  const claims = await (await auth()).getIdTokenClaims();
  if (!claims?.__raw) throw new Error("Sign in again to check your MPC account.");
  const response = await fetch("/api/near-auth-probe", {
    method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({action:activate ? "activate" : "prepare",token:claims.__raw}),signal,
  });
  const result = await response.json();
  if (!response.ok || !/^[a-f0-9]{64}$/.test(result.account) || typeof result.funded !== "boolean") {
    throw new Error(result.error || "MPC account is temporarily unavailable.");
  }
  return result;
}

export async function signSocialBooking(
  popup: Window, expectedAccount: string, escrow: string, args: Record<string,unknown>, deposit: string,
  track: (hash:string)=>void, clearRejected: ()=>void,
) {
  let ready=await readSocialMpcAccount(AbortSignal.timeout(12000));
  if (ready.account===expectedAccount && !ready.funded) {
    ready=await readSocialMpcAccount(AbortSignal.timeout(45000),true);
  }
  if (ready.account!==expectedAccount || !ready.funded || !ready.publicKey || !ready.nonce || !ready.blockHash) {
    throw new Error("The MPC account is not ready. Reload PactPay and try again.");
  }
  const tx=createTransaction(ready.account,PublicKey.fromString(ready.publicKey),escrow,BigInt(ready.nonce)+1n,
    [actionCreators.functionCall("create_booking",args,100000000000000n,BigInt(deposit))],baseDecode(ready.blockHash));
  const bytes=encodeTransaction(tx);
  if (bytes.length>740) throw new Error("This booking is too large for social signing. Reduce the number of buyers or use an external wallet.");
  const signing=new Auth0Client({
    domain:domain ?? "pactpay.us.auth0.com",clientId,cacheLocation:"memory",
    authorizationParams:{redirect_uri:location.origin},
  });
  const authorizationParams={
    audience:"auth0.pactpay-530c506b.testnet",scope:"transaction:sign",transaction:Array.from(bytes).join(","),
  };
  const hash=baseEncode(new Uint8Array(await crypto.subtle.digest("SHA-256",Uint8Array.from(bytes))));
  await signing.loginWithPopup({authorizationParams},{popup});
  const token=await signing.getTokenSilently({authorizationParams,cacheMode:"cache-only"});
  if (!token) throw new Error("Auth0 did not issue a signing token.");
  track(hash);
  const response=await fetch("/api/near-auth-probe",{
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"create",token}),
  });
  const result=await response.json();
  if (!response.ok) {
    if (!result.userHash && result.broadcastUncertain===false) clearRejected();
    throw new Error(result.error || "Check the pending transaction before retrying.");
  }
  if (result.userHash!==hash || result.account!==ready.account) throw new Error("Check the pending transaction before retrying.");
  return hash;
}

export function useNearSocialLogin() {
  const [profile,setProfile]=useState<Profile>();
  const connected = Boolean(profile);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const activeAttempt=useRef(false);

  useEffect(()=>{
    if (!clientId) return;
    let live=true;
    void sessionRestore().then(user=>{if(live && !activeAttempt.current)setProfile(user);}).catch(error=>{
      if (live && !activeAttempt.current) setError(error instanceof Error ? error.message : "NEAR Auth sign-in unavailable.");
    });
    return ()=>{live=false;};
  },[]);

  async function toggle() {
    if (activeAttempt.current || !clientId) return false;
    const popup = connected ? undefined : window.open("", "_blank", "popup,width=480,height=700");
    if (popup === null) {
      setError("Allow pop-ups for PactPay, then try again.");
      return false;
    }
    activeAttempt.current=true;
    setBusy(true);
    setError("");
    try {
      const p = await auth();
      // Auth0 delivers silent and popup authorization responses to the same window.
      // Let restoration settle before the popup starts listening for its response.
      await sessionRestore().catch(()=>undefined);
      if (connected) {
        await p.logout({openUrl:false});
        restore=Promise.resolve(undefined);
        setProfile(undefined);
      } else {
        if (popup?.closed) return false;
        await p.loginWithPopup({}, {popup,timeoutInSeconds:180});
        const user = await p.getUser();
        if (!user) throw new Error("No account information returned.");
        restore=Promise.resolve(user);
        setProfile(user);
      }
      return true;
    } catch (error) {
      if (!connected && error instanceof Error && "error" in error && error.error === "state_mismatch") {
        setError("This sign-in attempt expired or did not match. Try again from this dialog.");
      } else {
        setError(error instanceof Error ? error.message : "NEAR Auth sign-in unavailable.");
      }
      return false;
    } finally {
      popup?.close();
      activeAttempt.current=false;
      setBusy(false);
    }
  }

  return {available: Boolean(clientId), connected, profile, busy, error, toggle};
}
