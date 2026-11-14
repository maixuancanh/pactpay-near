import React from "react";
import ReactDOM from "react-dom/client";
import NearBooking from "./near/NearBooking";
import VerifyPage from "./near/agreements/VerifyPage";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{/^\/verify\/?$/.test(location.pathname) ? <VerifyPage/> : <NearBooking />}</React.StrictMode>,
);
