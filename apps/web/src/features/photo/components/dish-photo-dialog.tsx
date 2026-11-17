"use client";

// ============================================================
// Foodo — Dish Photo Dialog (capture → AI enhance → approve)
// ============================================================
// The full seller flow for the AI Food Photo Enhancement Pipeline:
//   1. Pick/take a photo (file input, mobile camera friendly)
//   2. Direct upload to Cloudinary (bytes never touch Foodo servers)
//   3. Interactive before/after slider + studio surface picker
//   4. "Approve & Publish" → hands the enhanced URL to the caller
//      (the seller menu page persists it via menu-item create)

import { useState } from "react";
import {
  Camera,
  Loader2,
  Sparkles,
  RefreshCcw,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import {
  useEnhancePhoto,
  useRestylePreview,
  SURFACE_OPTIONS,
  type ApprovedPhoto,
  type DirectUploadResult,
  type PhotoPreview,
} from "../api";
import { BeforeAfterSlider } from "./before-after-slider";

interface DishPhotoDialogProps {
  /** Called when the seller approves the enhanced photo. */
  onApprove: (photo: ApprovedPhoto) => void;
  onCancel: () => void;
}

export function DishPhotoDialog({ onApprove, onCancel }: DishPhotoDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [surface, setSurface] = useState("marble");
  const [upload, setUpload] = useState<DirectUploadResult | null>(null);
  const [preview, setPreview] = useState<PhotoPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const enhance = useEnhancePhoto({
    onSuccess: ({ preview: p, upload: u }) => {
      setUpload(u);
      setPreview(p);
    },
  });

  const restyle = useRestylePreview();

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    if (!picked) return;
    setError(null);
    setFile(picked);
    setPreview(null);
    setUpload(null);
    enhance.mutate({ file: picked, surface });
  };

  const handleRestyle = (styleId: string) => {
    setSurface(styleId);
    if (upload) {
      restyle.mutate(
        { publicId: upload.publicId, surface: styleId },
        { onSuccess: setPreview }
      );
    }
  };

  const busy = enhance.isPending || restyle.isPending;
  const approved = preview && upload;

  return (
    <div className="space-y-4">
      {!file && (
        <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border py-10 text-center hover:bg-accent/40 transition-colors">
          <Camera className="h-8 w-8 text-muted-foreground/60" />
          <span className="text-sm font-medium">Take or choose a dish photo</span>
          <span className="text-xs text-muted-foreground">
            Straight from your phone — AI does the studio work
          </span>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleFile}
            className="hidden"
          />
        </label>
      )}

      {file && !preview && busy && (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm font-medium">Uploading & enhancing…</p>
          <p className="text-xs text-muted-foreground">
            Large photos go straight to the media cloud — this takes a moment
          </p>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {(enhance.isError || restyle.isError) && !error && (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          {enhance.error instanceof Error
            ? enhance.error.message
            : restyle.error instanceof Error
              ? restyle.error.message
              : "Something went wrong — please try again"}
        </div>
      )}

      {preview && (
        <>
          <BeforeAfterSlider
            before={preview.before}
            after={preview.after}
            loading={busy}
          />

          {/* Studio surface picker */}
          <div>
            <p className="mb-1.5 flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <Sparkles className="h-3 w-3" /> Studio surface
            </p>
            <div className="flex flex-wrap gap-1.5">
              {SURFACE_OPTIONS.map((style) => (
                <button
                  key={style.id}
                  onClick={() => handleRestyle(style.id)}
                  title={style.hint}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition-all ${
                    surface === style.id
                      ? "bg-primary text-primary-foreground"
                      : "border border-border hover:bg-accent"
                  }`}
                >
                  {style.label}
                </button>
              ))}
              <button
                onClick={() => handleRestyle(surface)}
                title="Re-roll the AI generation for a different variation"
                className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs font-medium hover:bg-accent"
              >
                <RefreshCcw className={`h-3 w-3 ${busy ? "animate-spin" : ""}`} />
                Again
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium hover:bg-accent">
              <Camera className="h-3.5 w-3.5" />
              Retake
              <input
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handleFile}
                className="hidden"
              />
            </label>
            <button
              onClick={() => {
                if (approved) {
                  onApprove({
                    enhancedUrl: preview.after,
                    publicId: upload.publicId,
                    surface: preview.surface,
                  });
                }
              }}
              className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:brightness-110 transition-all"
            >
              <CheckCircle2 className="h-4 w-4" />
              Approve & Publish to Menu
            </button>
          </div>
        </>
      )}

      <div className="flex justify-end">
        <button
          onClick={onCancel}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
