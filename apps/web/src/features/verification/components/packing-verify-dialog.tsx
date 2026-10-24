"use client";

// ============================================================
// Foodo — Packing Verification Dialog (Seller Kitchen Screen)
// ============================================================
// The pre-seal checkpoint: the seller snapshots the open bag, the AI
// verification service compares it against the order ticket, and any
// missing item is surfaced BEFORE the bag leaves the kitchen.
// Flagged/unverified verdicts can still ship — but only through an
// explicit override with a mandatory audit note.

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { AiModal } from "@/components/shared/ai-modal";
import { useToast } from "@/components/ui/toaster";
import { ApiError } from "@/lib/api-client";
import {
  useSubmitPackingVerification,
  useOverridePackingVerification,
} from "@/features/verification/api";
import type { IOrder, IVerificationResponse } from "@/types";
import {
  Camera,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ScanSearch,
  RotateCcw,
  ShieldAlert,
} from "lucide-react";

interface PackingVerifyDialogProps {
  order: IOrder | null;
  open: boolean;
  onClose: () => void;
  /** Parent flips the order to ready_for_rider when verification clears */
  onVerified: () => void;
}

export function PackingVerifyDialog({
  order,
  open,
  onClose,
  onVerified,
}: PackingVerifyDialogProps) {
  const restaurantId = order?.restaurantId ?? "";
  const submitVerification = useSubmitPackingVerification();
  const overrideVerification = useOverridePackingVerification(restaurantId);
  const { addToast } = useToast();

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<IVerificationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showOverride, setShowOverride] = useState(false);
  const [overrideNote, setOverrideNote] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const busy = submitVerification.isPending || overrideVerification.isPending;

  const reset = () => {
    setSelectedFile(null);
    setPreviewUrl(null);
    setVerdict(null);
    setError(null);
    setShowOverride(false);
    setOverrideNote("");
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSelect = (file: File | null) => {
    setSelectedFile(file);
    setVerdict(null);
    setError(null);
    setShowOverride(false);
    setPreviewUrl(file ? URL.createObjectURL(file) : null);
  };

  // A failed check must never be silent: the seller cannot tell a dead
  // verifier from a rejected photo, and either way the bag stays sealed.
  const reportFailure = (err: unknown, fallback: string) => {
    const message = err instanceof ApiError && err.message ? err.message : fallback;
    setError(message);
    addToast({ message, variant: "error", duration: 6000 });
  };

  const handleVerify = async () => {
    if (!order || !selectedFile) return;
    setError(null);
    try {
      const res = await submitVerification.mutateAsync({
        orderId: order.id,
        file: selectedFile,
      });
      setVerdict(res.verification);
      if (res.verification.status === "verified") {
        onVerified();
      }
    } catch (err) {
      reportFailure(
        err,
        "Could not verify the bag — check your connection and try again",
      );
    }
  };

  const handleOverride = async () => {
    if (!order || overrideNote.trim().length < 3) return;
    setError(null);
    try {
      await overrideVerification.mutateAsync({
        orderId: order.id,
        note: overrideNote.trim(),
      });
      onVerified();
      handleClose();
    } catch (err) {
      reportFailure(err, "Could not record the override — try again");
    }
  };

  const needsOverride = verdict !== null && verdict.status !== "verified";

  const banner = () => {
    if (!verdict) return null;
    if (verdict.status === "verified") {
      return (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-sm font-medium text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          All items look present — safe to seal the bag.
        </div>
      );
    }
    if (verdict.status === "flagged") {
      return (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm">
          <div className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Possible issue detected
          </div>
          {verdict.missing.length > 0 && (
            <p className="mt-1 text-foreground/80">
              Possibly missing: <strong>{verdict.missing.join(", ")}</strong>
            </p>
          )}
          {verdict.unexpected.length > 0 && (
            <p className="mt-1 text-foreground/80">
              Unexpected items: {verdict.unexpected.join(", ")}
            </p>
          )}
          {verdict.notes && (
            <p className="mt-1 text-xs text-muted-foreground">{verdict.notes}</p>
          )}
        </div>
      );
    }
    // unverified — AI tier down
    return (
      <div className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-700 dark:text-amber-400">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          The verification service is temporarily unavailable. Re-verify, or
          override with a note — both are audited.
        </span>
      </div>
    );
  };

  return (
    <AiModal
      open={open}
      onClose={handleClose}
      title={
        <>
          <ScanSearch className="h-5 w-5 text-primary" />
          Verify before sealing
        </>
      }
      description={
        order
          ? `Snap the open bag — the kitchen AI checks it against the ticket (#${order.id.slice(-6).toUpperCase()}).`
          : "Snap the open bag for an AI check against the ticket."
      }
      footer={
        <>
          <Button variant="ghost" onClick={handleClose} disabled={busy}>
            Close
          </Button>
          {needsOverride && !showOverride ? (
            <Button
              variant="outline"
              onClick={() => setShowOverride(true)}
              disabled={busy}
              className="border-amber-500/50 text-amber-700 hover:bg-amber-500/10 dark:text-amber-400"
            >
              <ShieldAlert className="h-4 w-4" />
              Ship anyway…
            </Button>
          ) : (
            <Button
              onClick={handleVerify}
              disabled={!selectedFile || busy}
              className="min-w-32"
            >
              {submitVerification.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Verifying…
                </>
              ) : (
                <>
                  <ScanSearch className="h-4 w-4" />
                  Verify bag
                </>
              )}
            </Button>
          )}
        </>
      }
    >
      {/* Ticket checklist */}
      <div className="space-y-1 rounded-xl border bg-muted/40 px-3 py-2 text-xs">
        {order?.items.map((item, i) => (
          <div key={i} className="flex justify-between text-muted-foreground">
            <span>
              <span className="font-semibold text-foreground">{item.quantity}×</span>{" "}
              {item.name}
            </span>
            <span>₹{item.price * item.quantity}</span>
          </div>
        ))}
      </div>

      {banner()}

      {/* Failure banner — the exact reason the check did not run */}
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="space-y-1">
            <p className="font-medium">Verification didn't run</p>
            <p className="text-xs text-destructive/90">{error}</p>
            <p className="text-xs text-muted-foreground">
              {verdict
                ? "Retake the photo and try again, or ship anyway with a note."
                : "Retry the check. The order stays blocked until a verdict is on file."}
            </p>
          </div>
        </div>
      )}

      {/* Photo capture */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => handleSelect(e.target.files?.[0] ?? null)}
      />

      {previewUrl ? (
        <div className="space-y-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={previewUrl}
            alt="Open bag preview"
            className="max-h-56 w-full rounded-xl border object-contain"
          />
          <button
            onClick={() => handleSelect(null)}
            disabled={busy}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <RotateCcw className="h-3 w-3" /> Retake
          </button>
        </div>
      ) : (
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          className="flex h-36 w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:opacity-50"
        >
          <Camera className="h-7 w-7" />
          Tap to photograph the open bag
        </button>
      )}

      {/* Override (audit-noted ship-anyway) */}
      {needsOverride && showOverride && (
        <div className="space-y-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2.5">
          <p className="text-xs font-medium text-destructive">
            Override requires a note (kept in the dispute audit trail):
          </p>
          <textarea
            value={overrideNote}
            onChange={(e) => setOverrideNote(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder="e.g. Diet Coke added after photo — verified by packer Viju"
            className="w-full rounded-lg border bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
          <Button
            onClick={handleOverride}
            disabled={overrideNote.trim().length < 3 || overrideVerification.isPending}
            variant="destructive"
            size="sm"
            className="w-full"
          >
            {overrideVerification.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ShieldAlert className="h-4 w-4" />
            )}
            Record override &amp; proceed
          </Button>
        </div>
      )}
    </AiModal>
  );
}
