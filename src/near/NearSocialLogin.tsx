import {useEffect,useState} from "react";

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
    await client.checkSession();
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

export function useNearSocialLogin() {
  const [profile,setProfile]=useState<Profile>();
  const connected = Boolean(profile);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");

  useEffect(()=>{
    if (!clientId) return;
    let live=true;
    void (restore ??= restoreProfile()).then(user=>{if(live)setProfile(user);}).catch(error=>{
      if (live) setError(error instanceof Error ? error.message : "NEAR Auth sign-in unavailable.");
    });
    return ()=>{live=false;};
  },[]);

  async function toggle() {
    const popup = connected ? undefined : window.open("", "_blank", "popup,width=480,height=700");
    if (popup === null) {
      setError("Allow pop-ups for PactPay, then try again.");
      return false;
    }
    setBusy(true);
    setError("");
    try {
      const p = await auth();
      if (connected) {
        await p.logout({openUrl:false});
        setProfile(undefined);
      } else {
        await p.loginWithPopup({}, {popup});
        const user = await p.getUser();
        if (!user) throw new Error("No account information returned.");
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
      setBusy(false);
    }
  }

  return {available: Boolean(clientId), connected, profile, busy, error, toggle};
}
