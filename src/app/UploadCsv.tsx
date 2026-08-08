"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { uploadCsv } from "./actions";
import styles from "./page.module.css";

/**
 * Upload a small CSV and classify it live.
 *
 * The file input auto-submits on choose — the demo gesture is "pick the file,
 * watch it classify", not "pick, then find a second button". While the Server
 * Action runs (~15s for the sample), `useFormStatus` keeps the pending state
 * honest: the model really is being called, and the button says so instead of
 * pretending to be instant.
 */
export function UploadCsv() {
  const [state, formAction] = useActionState(uploadCsv, null);

  return (
    <form action={formAction} className={styles.uploadForm}>
      <UploadControls error={state?.error ?? null} />
    </form>
  );
}

function UploadControls({ error }: { error: string | null }) {
  const { pending } = useFormStatus();

  return (
    <>
      <label className={`${styles.uploadButton} ${pending ? styles.uploadButtonBusy : ""}`}>
        {pending ? "Classifying with Gemini…" : "Upload a survey CSV"}
        <input
          type="file"
          name="file"
          accept=".csv,text/csv"
          className={styles.uploadInput}
          disabled={pending}
          onChange={(event) => event.currentTarget.form?.requestSubmit()}
        />
      </label>
      <span className={styles.uploadHint}>
        {pending
          ? "Live model calls, sentence by sentence — the 24-row sample takes about 15 seconds."
          : "Small files only, up to 60 rows. data/demo_upload_sample.csv is ready to go."}
      </span>
      {error && !pending ? <span className={styles.uploadError}>{error}</span> : null}
    </>
  );
}
