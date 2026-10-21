"use client";

// ============================================================
// Foodo — POD Capture Dialog (Rider Drop-off)
// ============================================================
// Replaces the bare "Mark Delivered" tap: the rider snapshots the
// drop-off, the AI tier verifies porch/doorstep placement, and the
// confirmation is sent on completion. Advisory only — a flagged
// verdict still lets the rider complete the delivery.

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { AiModal } from "@/components/shared/ai-modal";
import { useSubmitProofOfDelivery } from "@/features/verification/api";
import {
  Camera,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ShieldCheck,
  RotateCcw,
} from "lucide-react";

interface PodCaptureDialogProps {
  open: boolean;
  onClose: () => void;
  onCompleted: () => void;
}

export function PodCaptureDialog({
  open,
  onClose,
  onCompleted,
}: PodCaptureDialogProps) {
  const submitPod = useSubmitProofOfDelivery();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [result, setResult] = useState<{
    status: string;
    flag: string | null;
    confidence: number;
    notes: string | null;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const busy = submitPod.isPending;

  const reset = () => {
    setSelectedFile(null);
    setPreviewUrl(null);
    setResult(null);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleSelect = (file: File | null) => {
    setSelectedFile(file);
    setResult(null);
    setPreviewUrl(file ? URL.createObjectURL(file) : null);
  };

  const handleSubmit = async () => {
    if (!selectedFile) return;
    try {
      const res = await submitPod.mutateAsync({ file: selectedFile });
      setResult({
        status: res.verification.status,
        flag: res.verification.flag,
        confidence: res.verification.confidence,
        notes: res.verification.notes,
      });
      onCompleted();
    } catch {
      // error surfaced by the mutation hook
    }
  };

  return (
    <AiModal
      open={open}
      onClose={handleClose}
      title={
        <>
          <ShieldCheck className="h-5 w-5 text-primary" />
          Proof of delivery
        </>
      }
      description="Snap the order at the drop-off — it protects you in disputes and confirms delivery to the customer."
      footer={
        result ? null : (
          <>
            <Button variant="ghost" onClick={handleClose} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={!selectedFile || busy}>
              {busy ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Verifying…
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4" />
                  Confirm delivery
                </>
              )}
            </Button>
          </>
        )
      }
    >
      {result ? (
        /* ── Completion state ── */
        <div className="space-y-3">
          {result.status === "verified" ? (
            <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-sm font-medium text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              Delivery verified — proof sent to the customer.
            </div>
          ) : result.status === "flagged" ? (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm">
              <div className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                Photo flagged: {result.flag?.replaceAll("_", " ").toLowerCase()}
              </div>
              <p className="mt-1 text-foreground/80">
                Delivery is complete. Support may reach out if the customer
                disputes it.
              </p>
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-xl border bg-muted/40 px-3 py-2.5 text-sm">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <span>
                Delivery completed — the photo was saved but couldn&apos;t be
                auto-verified right now.
              </span>
            </div>
          )}
          <Button onClick={handleClose} className="w-full">
            Done
          </Button>
        </div>
      ) : (
        /* ── Capture state ── */
        <>
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
                alt="Drop-off preview"
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
              className="flex h-40 w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:opacity-50"
            >
              <Camera className="h-7 w-7" />
              Tap to photograph the drop-off
            </button>
          )}
        </>
      )}
    </AiModal>
  );
}
