"use client";

// ============================================================
// Foodo — Customer Dispute: "Report a problem" (shared modal)
// ============================================================
// The AI arbitration tier's customer door. Three phases:
//   form    the complaint (+ an optional photo)
//   waiting the case sits on an SQS queue while the agent graph runs
//   verdict the agent's outcome, in plain language
//
// Cases are found by ORDER, not by a case id the browser keeps: the
// order page asks the server whether this order already has one, so a
// customer on a new device still finds their case. Polling stops as
// soon as the newest case settles.
//
// The agent's thought graph, telemetry flags and trust score are
// deliberately NOT shown here — they are machine evidence for the
// reviewer, surfaced on the admin queue. Customers get the decision,
// the reason and what happens next.

import { useEffect, useRef, useState } from "react";
import { AiModal } from "@/components/shared/ai-modal";
import { ApiError } from "@/lib/api-client";
import { isSettled, useFileDispute, useOrderDisputes, type DisputeCase } from "../api";
import {
  AlertTriangle,
  Check,
  ImagePlus,
  LifeBuoy,
  Loader2,
  ShieldQuestion,
  Ticket,
  Undo2,
  X,
} from "lucide-react";

const MIN_COMPLAINT = 5;
/** Client cap: the whole JSON body must fit Lambda's 6MB sync payload. */
const MAX_IMAGE_CHARS = 4_000_000;

// ─── Money ───────────────────────────────────────────────────

const rupees = (value: number): string =>
  `₹${(Number.isFinite(value) ? value : 0).toLocaleString("en-IN", {
    maximumFractionDigits: 2,
  })}`;

// ─── Error copy ──────────────────────────────────────────────

function fileErrorMessage(error: unknown): string {
  const status = error instanceof ApiError ? error.status : undefined;
  if (status === 413) return "That photo is too large — try a smaller one.";
  if (status === 429) return "You've reported a few issues already. Try again in a minute.";
  if (status === 503) return "We couldn't store the photo right now. Try again in a moment.";
  if (status === 502) return "Support is unavailable right now. Try again in a moment.";
  if (status === 400) return "Add a few more words so support can act on this.";
  if (status === 401) return "Your session expired — sign in again to report this.";
  return "Couldn't send this report. Check your connection and try again.";
}

// ─── Trigger + modal ─────────────────────────────────────────

interface ReportProblemProps {
  orderId: string;
  customerId: string;
}

export function ReportProblem({ orderId, customerId }: ReportProblemProps) {
  const [open, setOpen] = useState(false);
  // The 202 carries the case id before the consumer Lambda has written
  // the row — holding it keeps this surface in the waiting phase through
  // that gap instead of dropping back to the form.
  const [filedId, setFiledId] = useState<string | null>(null);

  const disputes = useOrderDisputes(
    orderId,
    (cases) => filedId !== null && !cases.some((c) => isSettled(c.status)),
  );

  // The service returns newest first.
  const newest = disputes.data?.[0] ?? null;
  const caseId = filedId ?? newest?.caseId ?? null;
  const activeCase = caseId && newest?.caseId === caseId ? newest : null;

  const settled = isSettled(activeCase?.status);
  const label = !caseId
    ? "Report a problem"
    : settled
      ? "See the outcome"
      : "Report under review";

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-border px-4 text-xs font-medium transition-colors hover:bg-accent"
      >
        {caseId && !settled ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
        ) : (
          <LifeBuoy className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        {label}
      </button>

      <ReportProblemDialog
        open={open}
        onClose={() => setOpen(false)}
        orderId={orderId}
        customerId={customerId}
        caseId={caseId}
        disputeCase={activeCase}
        caseError={disputes.isError}
        onFiled={setFiledId}
      />
    </>
  );
}

// ─── Dialog ──────────────────────────────────────────────────

function ReportProblemDialog({
  open,
  onClose,
  orderId,
  customerId,
  caseId,
  disputeCase,
  caseError,
  onFiled,
}: {
  open: boolean;
  onClose: () => void;
  orderId: string;
  customerId: string;
  caseId: string | null;
  disputeCase: DisputeCase | null;
  caseError: boolean;
  onFiled: (caseId: string) => void;
}) {
  const fileDispute = useFileDispute();
  const [complaint, setComplaint] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [readingPhoto, setReadingPhoto] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // A filed case always wins over the form — the customer cannot open a
  // second case for the same order from this surface.
  const phase: "form" | "waiting" | "verdict" = !caseId
    ? "form"
    : !disputeCase
      ? "waiting"
      : isSettled(disputeCase.status)
        ? "verdict"
        : "waiting";

  const trimmed = complaint.trim();
  const canSubmit = trimmed.length >= MIN_COMPLAINT && !fileDispute.isPending && !readingPhoto;

  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    setPhotoError(null);
    setReadingPhoto(true);
    try {
      const { fileToVerifiedDataUri } = await import("@/lib/image-capture");
      const dataUri = await fileToVerifiedDataUri(file);
      if (dataUri.length > MAX_IMAGE_CHARS) {
        setPhotoError("That photo is too large — try a smaller one.");
        return;
      }
      setPhoto(dataUri);
    } catch {
      setPhotoError("Couldn't read that image. Try a JPEG or PNG.");
    } finally {
      setReadingPhoto(false);
    }
  };

  const submit = () => {
    setFormError(null);
    if (trimmed.length < MIN_COMPLAINT) {
      setFormError("Tell us a little more so support can act on it.");
      return;
    }
    fileDispute.mutate(
      {
        orderId,
        customerId,
        complaint: trimmed,
        ...(photo ? { image: photo } : {}),
      },
      {
        onSuccess: (res) => onFiled(res.caseId),
        onError: (error) => setFormError(fileErrorMessage(error)),
      },
    );
  };

  return (
    <AiModal
      open={open}
      onClose={onClose}
      maxWidthClass="sm:max-w-lg"
      title={
        <span className="flex items-center gap-2">
          <ShieldQuestion className="h-4 w-4" aria-hidden="true" />
          {phase === "form" ? "Report a problem" : "Support case"}
        </span>
      }
      description={
        phase === "form"
          ? "Something wrong with this order? The support agent checks the order, your photo and the delivery record, then decides."
          : undefined
      }
      footer={
        phase === "form" ? (
          <>
            <button
              onClick={onClose}
              className="h-10 rounded-xl px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={!canSubmit}
              className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-primary px-4 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {fileDispute.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : null}
              {fileDispute.isPending ? "Sending…" : "Send to support"}
            </button>
          </>
        ) : (
          <button
            onClick={onClose}
            className="h-10 rounded-xl px-4 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Close
          </button>
        )
      }
    >
      {phase === "form" && (
        <FormPhase
          complaint={complaint}
          onComplaint={setComplaint}
          photo={photo}
          onClearPhoto={() => setPhoto(null)}
          photoError={photoError}
          readingPhoto={readingPhoto}
          onPick={() => fileInput.current?.click()}
          fileInputRef={fileInput}
          onFile={(file) => void pickPhoto(file)}
          error={formError}
        />
      )}

      {phase === "waiting" && (
        <WaitingPhase
          caseId={caseId}
          isError={caseError}
          startedAt={disputeCase?.startedAt}
        />
      )}

      {phase === "verdict" && disputeCase && (
        <VerdictPhase disputeCase={disputeCase} />
      )}
    </AiModal>
  );
}

// ─── Phase: form ─────────────────────────────────────────────

function FormPhase({
  complaint,
  onComplaint,
  photo,
  onClearPhoto,
  photoError,
  readingPhoto,
  onPick,
  fileInputRef,
  onFile,
  error,
}: {
  complaint: string;
  onComplaint: (value: string) => void;
  photo: string | null;
  onClearPhoto: () => void;
  photoError: string | null;
  readingPhoto: boolean;
  onPick: () => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFile: (file: File | undefined) => void;
  error: string | null;
}) {
  const remaining = MIN_COMPLAINT - complaint.trim().length;

  return (
    <>
      <div>
        <label htmlFor="dispute-complaint" className="text-xs font-medium">
          What went wrong?
        </label>
        <textarea
          id="dispute-complaint"
          value={complaint}
          onChange={(e) => onComplaint(e.target.value)}
          rows={4}
          maxLength={1200}
          placeholder="Half the order was missing and the curry had spilled."
          className="mt-1.5 w-full resize-none rounded-xl border border-border bg-background px-3 py-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        {error ? (
          <p role="alert" className="mt-1.5 flex items-start gap-1.5 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {error}
          </p>
        ) : remaining > 0 ? (
          <p className="mt-1.5 text-xs text-muted-foreground">
            {remaining} more character{remaining === 1 ? "" : "s"} and you can send it.
          </p>
        ) : null}
      </div>

      <div>
        <span className="text-xs font-medium">Photo</span>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Optional, but a clear photo of the problem usually settles the case faster.
        </p>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            onFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />

        {photo ? (
          <div className="mt-2 flex items-center gap-3 rounded-xl border border-border p-2">
            <img
              src={photo}
              alt="The problem you reported"
              className="h-14 w-14 rounded-lg object-cover"
            />
            <p className="min-w-0 flex-1 text-xs text-muted-foreground">Photo attached</p>
            <button
              onClick={onClearPhoto}
              className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label="Remove photo"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <button
            onClick={onPick}
            disabled={readingPhoto}
            className="mt-2 inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
          >
            {readingPhoto ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <ImagePlus className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {readingPhoto ? "Reading photo…" : "Add a photo"}
          </button>
        )}

        {photoError && (
          <p role="alert" className="mt-1.5 text-xs text-destructive">
            {photoError}
          </p>
        )}
      </div>
    </>
  );
}

// ─── Phase: waiting ──────────────────────────────────────────

function WaitingPhase({
  caseId,
  isError,
  startedAt,
}: {
  caseId: string | null;
  isError: boolean;
  startedAt: string | undefined;
}) {
  const elapsed = useElapsed(startedAt);

  return (
    <div className="py-2">
      <div className="flex items-start gap-3">
        <Loader2
          className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <p className="text-sm font-medium">Checking your order</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {caseId
              ? "The agent is reading your complaint against the order, the delivery record and any photo. This usually takes under a minute."
              : "Sending your report…"}
          </p>
          <p className="mt-2 text-xs text-muted-foreground tabular-nums" aria-live="polite">
            {elapsed}
          </p>
        </div>
      </div>

      {isError && (
        <p className="mt-4 rounded-xl border border-border p-3 text-xs text-muted-foreground">
          We lost touch with the case for a moment — still trying. Nothing is lost, so closing
          this is safe.
        </p>
      )}

      {caseId && !isError && (
        <p className="mt-4 font-mono text-xs text-muted-foreground">Case {caseId}</p>
      )}
    </div>
  );
}

/** Seconds since the case started, formatted as "0:42" / "1:05". */
function useElapsed(startedAt: string | undefined): string {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (!startedAt) return "";
  const start = new Date(startedAt).getTime();
  if (!Number.isFinite(start)) return "";
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

// ─── Phase: verdict ──────────────────────────────────────────

interface VerdictCopy {
  icon: React.ReactNode;
  title: string;
  body: string;
  detail: string | null;
  tone: string;
}

function verdictCopy(disputeCase: DisputeCase): VerdictCopy {
  const reason = disputeCase.decisionReason?.trim() || null;

  switch (disputeCase.status) {
    case "auto_refunded":
      return {
        icon: <Undo2 className="h-4 w-4" aria-hidden="true" />,
        title: "Refund approved",
        body:
          disputeCase.refundAmount !== null
            ? `${rupees(disputeCase.refundAmount)} is heading back to your original payment method.`
            : "The amount is heading back to your original payment method.",
        detail: reason,
        tone: "text-emerald-700 dark:text-emerald-400",
      };
    case "voucher_issued":
      return {
        icon: <Ticket className="h-4 w-4" aria-hidden="true" />,
        title: "Voucher issued",
        body:
          disputeCase.voucherCode !== null
            ? `Use code ${disputeCase.voucherCode} on your next order.`
            : "A voucher has been added to your account.",
        detail: reason,
        tone: "text-emerald-700 dark:text-emerald-400",
      };
    case "escalated":
      return {
        icon: <LifeBuoy className="h-4 w-4" aria-hidden="true" />,
        title: "A person is taking this one",
        body: "This needs a human decision. Your case is in the support review queue, so there's nothing else to do from here.",
        detail: reason,
        tone: "text-foreground",
      };
    case "rejected":
      return {
        icon: <Check className="h-4 w-4" aria-hidden="true" />,
        title: "No refund for this order",
        body: reason ?? "Nothing in this case supported a refund.",
        detail: null,
        tone: "text-foreground",
      };
    default:
      // "failed": decisionReason holds an internal node error — never
      // shown to the customer.
      return {
        icon: <LifeBuoy className="h-4 w-4" aria-hidden="true" />,
        title: "The review didn't finish",
        body: "Your case is saved and our support team will pick it up. Nothing else is needed from you.",
        detail: null,
        tone: "text-foreground",
      };
  }
}

function VerdictPhase({ disputeCase }: { disputeCase: DisputeCase }) {
  const copy = verdictCopy(disputeCase);

  return (
    <div className="py-1">
      <div className={`flex items-center gap-2 text-sm font-semibold ${copy.tone}`}>
        {copy.icon}
        {copy.title}
      </div>
      <p className="mt-2 text-sm">{copy.body}</p>
      {copy.detail && (
        <p className="mt-2 text-sm text-muted-foreground">{copy.detail}</p>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        Case <span className="font-mono">{disputeCase.caseId}</span>
        {disputeCase.finishedAt
          ? ` · closed ${new Date(disputeCase.finishedAt).toLocaleString("en-IN", {
              day: "numeric",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            })}`
          : ""}
      </p>
    </div>
  );
}
