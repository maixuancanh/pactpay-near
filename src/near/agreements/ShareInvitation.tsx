import {useState} from "react";
import * as Dialog from "@radix-ui/react-dialog";

export function ShareInvitation({url}: {url: string}) {
  const [qr, setQr] = useState("");
  const [notice, setNotice] = useState("");

  async function loadQr() {
    try {
      const {toDataURL} = await import("qrcode");
      setQr(await toDataURL(url, {width: 208, margin: 4}));
    } catch {
      setNotice("The QR code could not be generated. Copy the link below.");
    }
  }

  return <Dialog.Root onOpenChange={open => { if (open && !qr) void loadQr(); }}>
    <Dialog.Trigger asChild><button type="button" className="pp-secondary">Share link</button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="pp-overlay" />
      <Dialog.Content className="pp-panel near-share-invite-dialog">
        <Dialog.Title>Share this booking share</Dialog.Title>
        <Dialog.Description>The link opens this share. Private evidence still requires an authorized wallet.</Dialog.Description>
        {qr && <img src={qr} width="208" height="208" alt="QR code for the invitation link below" />}
        <label>Invitation link<input value={url} readOnly onFocus={event => event.currentTarget.select()} /></label>
        <div className="near-share-invite-actions">
          <button type="button" className="pp-primary" onClick={async () => {
            try {
              await navigator.clipboard.writeText(url);
              setNotice("Link copied.");
            } catch {
              setNotice("Select and copy the link above.");
            }
          }}>Copy link</button>
          <Dialog.Close asChild><button type="button" className="pp-secondary">Close</button></Dialog.Close>
        </div>
        {notice && <p role="status">{notice}</p>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
