import * as React from "react";
import { Button, Text } from "@shopify/polaris";

/** Native modal semantics provide focus trapping, Escape and focus restoration. */
export function DetailDrawer({ open, onClose, title, children }: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);
  const titleId = React.useId();
  React.useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [open]);
  return (
    <dialog ref={ref} className="ce-drawer" aria-labelledby={titleId} onCancel={onClose} onClose={onClose}>
      <div className="ce-drawer-header">
        <div id={titleId}><Text as="h2" variant="headingLg">{title}</Text></div>
        <Button onClick={onClose} accessibilityLabel="Close details">Close</Button>
      </div>
      <div className="ce-drawer-content">{open ? children : null}</div>
    </dialog>
  );
}
