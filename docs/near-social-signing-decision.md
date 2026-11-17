# NEAR Auth signing for PactPay

NEAR Auth provides an MPC signer backed by an on-chain JWT guard. The PactPay Auth0 session in NearSocialLogin.tsx and api/near-profile.mjs identifies a PactPay profile and can associate a wallet after the wallet proves ownership. The NEAR Auth browser SDK additionally requires a compatible signing authorization before it can provide a signer. [NEAR Auth SDKs](https://docs.auth.near.org/home/guides/choose-your-sdk)

## Testnet configuration and observed results

- Target origin and callback: `https://pactpay-near-testnet-web.vercel.app`. Verify this exact callback and Allowed Web Origins entry for any replacement Auth0 configuration.
- NEAR Auth contract `fast-auth.testnet`, signer contract `v1.signer-prod.testnet`, signing audience `auth0.jwt.fast-auth.testnet`. The shared development credentials are documented and testnet requires no production sign-off. [Official testnet configuration](https://docs.auth.near.org/resources/testnet)
- Live authorization preflight with the documented testnet client and the PactPay callback returned HTTP 403 with “Callback URL mismatch.” This request ended before any user login.
- Live authorization preflight with PactPay’s Auth0 client and the documented signing audience returned HTTP 302 to the PactPay callback with “Service not found: auth0.jwt.fast-auth.testnet.” This demonstrates the required signing audience is unavailable in the current tenant configuration. Adding a similarly named Auth0 API by itself would still leave issuer and guard compatibility to verify.

## Implementation prerequisite

Obtain a testnet Auth0 configuration that accepts the PactPay origin and returns signing JWTs accepted by the configured guard. This can be the shared NEAR Auth tenant after the exact callback is allowed or a compatible approved issuer route. Validate both Google and passkey at that origin. Keep the Auth0 profile subject separate from the derived NEAR account, and confirm the signer’s identity and account match the intended transaction sender.

Use the official browser signer for custody and recovery through the authenticated identity. Before enabling wallet actions, test account derivation, restoring the same account on a second device, popup cancellation, session expiry and authorization failure. Verify any account creation costs and relayer funding limits against the chosen testnet setup. [NEAR Auth architecture and fee behavior](https://auth.near.org/)

After the prerequisite passes, connect the signer to the existing confirmation and receipt journal. Check transaction intents with the user before calling the provider. Validate direct signer broadcasts and any delegated-action relayer receipt against the actual account and claim. Evidence access has a separate NEP-413 challenge. Use the browser SDK’s compatible message signer and verify the chain authority of the derived key before enabling this path for private evidence.

Task 9 remains pending. Both authorization attempts stopped before login, account derivation, signatures, or testnet broadcasts.
