"use client";

import { useState } from "react";
import styles from "./page.module.css";

export type CopyQueueProps = {
  /** Rich body — what Outlook receives when the HTML flavour survives. */
  html: string;
  /** Plain fallback, and what a plain-text editor gets. Never a stripped afterthought. */
  text: string;
  recipientName: string;
};

/**
 * Copy one recipient's queue to the clipboard, both flavours.
 *
 * `writeText` on an HTML string pastes visible markup, so this writes a
 * `ClipboardItem` carrying `text/html` *and* `text/plain` — MDN is explicit
 * that an HTML write should ship a plain alternate, and receivers switch on
 * the flavour.
 *
 * The item is built synchronously inside the handler. After an `await` the
 * user-gesture context is gone and the write rejects — which is why nothing is
 * fetched or computed before `navigator.clipboard.write`.
 *
 * The button reports which flavour landed rather than claiming success:
 * degrading silently to plain text is the failure worth surfacing, because it
 * looks identical in the app and wrong in Outlook.
 */
export function CopyQueue({ html, text, recipientName }: CopyQueueProps) {
  const [state, setState] = useState<"idle" | "rich" | "plain" | "failed">("idle");

  async function copy() {
    try {
      if (typeof ClipboardItem === "function" && navigator.clipboard?.write) {
        const item = new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        });
        await navigator.clipboard.write([item]);
        setState("rich");
        return;
      }
      await navigator.clipboard.writeText(text);
      setState("plain");
    } catch {
      setState("failed");
    }
  }

  const label = {
    idle: "Copy for Outlook",
    rich: "Copied — paste into Outlook",
    plain: "Copied as plain text",
    failed: "Copy failed — select the text below",
  }[state];

  return (
    <button
      type="button"
      className={`${styles.copyButton} ${state === "rich" ? styles.copyButtonDone : ""}`}
      onClick={copy}
      aria-label={`Copy the ${recipientName} queue to the clipboard`}
    >
      {label}
    </button>
  );
}
