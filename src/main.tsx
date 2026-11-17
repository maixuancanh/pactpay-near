import React from "react";
const AuthConsentCheck = React.lazy(() => import("./near/AuthConsentCheck"));
import ReactDOM from "react-dom/client";
import NearBooking from "./near/NearBooking";
import VerifyPage from "./near/agreements/VerifyPage";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{location.pathname === "/auth-consent-check" ? <React.Suspense fallback="Đang tải…"><AuthConsentCheck/></React.Suspense> : /^\/verify\/?$/.test(location.pathname) ? <VerifyPage/> : <NearBooking />}</React.StrictMode>,
);
