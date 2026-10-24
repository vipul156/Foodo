"use client";

// ============================================================
// Foodo — Menu import from a photo (seller review grid)
// ============================================================
// Three honest steps: pick a photo, check every row the reader
// produced, then publish. The model proposes, the owner disposes —
// nothing reaches the catalogue until the owner presses publish.
//
// The seller world is the dashboard, not the storefront: dense rows,
// plain inputs, one primary action per step.

import { useMemo, useRef, useState, type DragEvent } from "react";
import {
  AlertTriangle,
  Check,
  ImageUp,
  Loader2,
  Trash2,
  UtensilsCrossed,
} from "lucide-react";
import { AiModal } from "@/components/shared/ai-modal";
import { ApiError } from "@/lib/api-client";
import { uploadPhotoToCloudinary } from "@/features/photo/api";
import {
  useParseMenuImage,
  usePublishParsedMenu,
  type ParseDraft,
  type PublishResult,
} from "../api";

type Stage = "idle" | "uploading" | "reading" | "review" | "done";

interface ReviewRow {
  key: string;
  category: string;
  name: string;
  price: string;
  description: string;
  include: boolean;
}

const MAX_BYTES = 10 * 1024 * 1024;

interface MenuImportProps {
  open: boolean;
  restaurantId: string;
  existingCount: number;
  onClose: () => void;
  onPublished: () => void;
}

export function MenuImport({
  open,
  restaurantId,
  existingCount,
  onClose,
  onPublished,
}: MenuImportProps) {
  const parse = useParseMenuImage();
  const publish = usePublishParsedMenu(restaurantId);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [meta, setMeta] = useState<{ sections: number; ms: number } | null>(null);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [result, setResult] = useState<PublishResult | null>(null);

  const reset = () => {
    setStage("idle");
    setError(null);
    setDragging(false);
    setRows([]);
    setWarnings([]);
    setMeta(null);
    setReplaceExisting(false);
    setResult(null);
  };

  const close = () => {
    if (stage === "uploading" || stage === "reading" || publish.isPending) return;
    reset();
    onClose();
  };

  const finish = () => {
    reset();
    onPublished();
    onClose();
  };

  const readPhoto = async (file: File) => {
    setError(null);

    if (!file.type.startsWith("image/")) {
      setError("That file isn't an image. Use a JPG or PNG of the menu.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError("That photo is too large. Keep it under 10 MB.");
      return;
    }

    setStage("uploading");
    let imageUrl: string;
    try {
      const upload = await uploadPhotoToCloudinary(file);
      imageUrl = upload.secureUrl;
    } catch {
      setStage("idle");
      setError("The photo could not be uploaded. Check your connection and try again.");
      return;
    }

    setStage("reading");
    parse.mutate(imageUrl, {
      onSuccess: (draft) => applyDraft(draft),
      onError: (err) => {
        setStage("idle");
        setError(parseErrorMessage(err));
      },
    });
  };

  const applyDraft = (draft: ParseDraft) => {
    let key = 0;
    const next: ReviewRow[] = [];
    for (const category of draft.categories) {
      for (const item of category.items) {
        next.push({
          key: `row-${key}`,
          category: category.name,
          name: item.name,
          price: String(item.price),
          description: item.description,
          include: true,
        });
        key += 1;
      }
    }
    setRows(next);
    setWarnings(draft.warnings);
    setMeta({ sections: draft.categories.length, ms: draft.duration_ms });
    setStage("review");
  };

  const updateRow = (key: string, patch: Partial<ReviewRow>) => {
    setRows((prev) =>
      prev.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
  };

  const removeRow = (key: string) => {
    setRows((prev) => prev.filter((row) => row.key !== key));
  };

  const renameCategory = (from: string, to: string) => {
    setRows((prev) =>
      prev.map((row) => (row.category === from ? { ...row, category: to } : row)),
    );
  };

  // Group in first-seen order so the grid mirrors the photo's layout.
  const groups = useMemo(() => {
    const map = new Map<string, ReviewRow[]>();
    for (const row of rows) {
      const bucket = map.get(row.category);
      if (bucket) bucket.push(row);
      else map.set(row.category, [row]);
    }
    return Array.from(map.entries());
  }, [rows]);

  const included = rows.filter((row) => row.include);
  const invalid = included.filter((row) => {
    const price = Number(row.price);
    return row.name.trim().length === 0 || !Number.isFinite(price) || price < 0;
  });
  const canPublish = included.length > 0 && invalid.length === 0;

  const handlePublish = () => {
    if (!canPublish) return;
    publish.mutate(
      {
        items: included.map((row) => ({
          category: row.category.trim() || "Others",
          name: row.name.trim(),
          description: row.description.trim(),
          price: Number(row.price),
        })),
        replaceExisting,
      },
      {
        onSuccess: (data) => {
          setResult(data);
          setStage("done");
        },
        onError: (err) => setError(publishErrorMessage(err)),
      },
    );
  };

  const busy = stage === "uploading" || stage === "reading";

  return (
    <AiModal
      open={open}
      onClose={close}
      maxWidthClass="sm:max-w-2xl"
      title={
        stage === "done" ? "Menu published" : "Read a menu photo"
      }
      description={descriptionFor(stage)}
      footer={footerFor()}
    >
      {error && (
        <div className="flex items-start gap-2 rounded-lg bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {(stage === "idle" || busy) && (
        <div className="space-y-3">
          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event: DragEvent<HTMLDivElement>) => {
              event.preventDefault();
              setDragging(false);
              const file = event.dataTransfer.files?.[0];
              if (file && !busy) void readPhoto(file);
            }}
            className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
              dragging
                ? "border-primary bg-primary/5"
                : "border-border bg-muted/30"
            }`}
          >
            {busy ? (
              <>
                <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden="true" />
                <p className="mt-3 text-sm font-medium">
                  {stage === "uploading" ? "Uploading the photo…" : "Reading the menu…"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {stage === "uploading"
                    ? "Straight from your browser to Cloudinary."
                    : "Lifting dish names and prices. Usually 10–20 seconds."}
                </p>
              </>
            ) : (
              <>
                <ImageUp className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
                <p className="mt-3 text-sm font-medium">
                  Drop a menu photo here, or pick one
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  JPG or PNG, up to 10 MB. Straight-on and well lit reads best.
                </p>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  <ImageUp className="h-4 w-4" aria-hidden="true" />
                  Choose a photo
                </button>
              </>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void readPhoto(file);
              }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            The photo is read once and never added to your menu. Only the rows
            you approve are published.
          </p>
        </div>
      )}

      {stage === "review" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {included.length} of {rows.length} dishes selected
            </span>
            {meta && (
              <span>
                {meta.sections} {meta.sections === 1 ? "section" : "sections"} · read in{" "}
                {(meta.ms / 1000).toFixed(1)}s
              </span>
            )}
          </div>

          {warnings.length > 0 && (
            <ul className="space-y-1 rounded-lg bg-amber-600/5 px-3 py-2.5 text-xs text-amber-800 dark:text-amber-400">
              {warnings.map((warning) => (
                <li key={warning} className="flex items-start gap-1.5">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                  {warning}
                </li>
              ))}
            </ul>
          )}

          <div className="max-h-[46vh] space-y-4 overflow-y-auto pr-1">
            {groups.map(([category, groupRows]) => (
              <section key={category}>
                <div className="mb-1.5 flex items-center gap-2">
                  <input
                    value={category}
                    onChange={(event) => renameCategory(category, event.target.value)}
                    aria-label="Section name"
                    className="w-full rounded-md bg-transparent px-1 py-0.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:bg-accent focus:bg-accent focus:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {groupRows.length}
                  </span>
                </div>
                <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
                  {groupRows.map((row) => (
                    <li
                      key={row.key}
                      className={`flex items-center gap-2 px-2.5 py-2 ${
                        row.include ? "" : "opacity-50"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={row.include}
                        onChange={(event) =>
                          updateRow(row.key, { include: event.target.checked })
                        }
                        aria-label={`Include ${row.name || "this dish"}`}
                        className="h-4 w-4 shrink-0 rounded border-border accent-primary"
                      />
                      <input
                        value={row.name}
                        onChange={(event) =>
                          updateRow(row.key, { name: event.target.value })
                        }
                        placeholder="Dish name"
                        aria-label="Dish name"
                        className="min-w-0 flex-1 rounded-md bg-transparent px-1.5 py-1 text-sm transition-colors hover:bg-accent/60 focus:bg-accent/60 focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                      <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-border/60 px-1.5 focus-within:ring-2 focus-within:ring-ring">
                        <span className="text-xs text-muted-foreground">₹</span>
                        <input
                          value={row.price}
                          onChange={(event) =>
                            updateRow(row.key, { price: event.target.value })
                          }
                          inputMode="decimal"
                          aria-label={`Price for ${row.name || "this dish"}`}
                          className="w-16 bg-transparent py-1 text-sm tabular-nums focus:outline-none"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => removeRow(row.key)}
                        aria-label={`Remove ${row.name || "this dish"}`}
                        className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>

          {invalid.length > 0 && (
            <p className="text-xs text-destructive">
              {invalid.length} selected {invalid.length === 1 ? "row needs" : "rows need"} a
              name and a price.
            </p>
          )}

          <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={replaceExisting}
                onChange={(event) => setReplaceExisting(event.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-border accent-destructive"
              />
              <span>
                Replace my whole menu
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {replaceExisting
                    ? `Deletes the ${existingCount} item${existingCount === 1 ? "" : "s"} currently on your menu, then adds these.`
                    : "Leave off to add these dishes alongside the ones you have. Repeated names are skipped."}
                </span>
              </span>
            </label>
          </div>

          <p className="text-[11px] text-muted-foreground">
            Dish photos, veg marks and allergen lists stay empty — the menu
            record has no field for them yet. Add photos per dish after
            publishing.
          </p>
        </div>
      )}

      {stage === "done" && result && (
        <div className="space-y-3">
          <div className="flex items-start gap-2 rounded-lg bg-emerald-600/5 px-3 py-2.5 text-sm">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            <div>
              <p className="font-medium">
                {result.created > 0
                  ? `Added ${result.created} ${result.created === 1 ? "dish" : "dishes"} to your menu.`
                  : "Nothing new to add."}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {result.created === 0
                  ? "Every dish in that photo was already on your menu."
                  : "They are available to customers right away."}
              </p>
            </div>
          </div>

          {result.skipped.length > 0 && (
            <div className="rounded-lg border border-border/60 px-3 py-2.5">
              <p className="text-xs font-medium">
                Skipped {result.skipped.length}{" "}
                {result.skipped.length === 1 ? "duplicate" : "duplicates"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {result.skipped.slice(0, 6).join(", ")}
                {result.skipped.length > 6 && ` and ${result.skipped.length - 6} more`}
              </p>
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              reset();
            }}
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <UtensilsCrossed className="h-3.5 w-3.5" aria-hidden="true" />
            Read another photo
          </button>
        </div>
      )}
    </AiModal>
  );

  // ─── Copy per stage ────────────────────────────────────────

  function descriptionFor(current: Stage): string | undefined {
    if (current === "done") return undefined;
    if (current === "review") {
      return "Check the rows below. Rename sections, fix prices, drop anything that isn't a dish — then publish.";
    }
    return "We read the dish names and prices from your photo. You approve them before anything is saved.";
  }

  function footerFor() {
    if (stage === "review") {
      return (
        <>
          <button
            type="button"
            onClick={() => {
              reset();
            }}
            disabled={publish.isPending}
            className="inline-flex h-10 items-center rounded-lg px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            Start over
          </button>
          <button
            type="button"
            onClick={handlePublish}
            disabled={!canPublish || publish.isPending}
            className={`inline-flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-medium text-primary-foreground transition-colors disabled:opacity-50 ${
              replaceExisting
                ? "bg-destructive hover:bg-destructive/90"
                : "bg-primary hover:bg-primary/90"
            }`}
          >
            {publish.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Publishing…
              </>
            ) : replaceExisting ? (
              `Replace menu with ${included.length}`
            ) : (
              `Add ${included.length} ${included.length === 1 ? "dish" : "dishes"}`
            )}
          </button>
        </>
      );
    }

    if (stage === "done") {
      return (
        <button
          type="button"
          onClick={finish}
          className="inline-flex h-10 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Done
        </button>
      );
    }

    return null;
  }
}

// ─── Error copy ──────────────────────────────────────────────
// FastAPI raises `detail`; the Express services answer `message`.
// Read both before falling back to a sentence the seller can act on.

function serverMessage(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const data = error.data as
    | { detail?: unknown; message?: unknown }
    | undefined;
  if (typeof data?.detail === "string" && data.detail.trim()) return data.detail;
  if (typeof data?.message === "string" && data.message.trim()) return data.message;
  return null;
}

function parseErrorMessage(error: unknown): string {
  const status = error instanceof ApiError ? error.status : undefined;
  if (status === 400) {
    return serverMessage(error) ?? "That photo could not be used. Try another one.";
  }
  if (status === 413) return "That photo is too large. Keep it under 10 MB.";
  if (status === 429) {
    return "You've read a lot of menus in the last minute. Wait a moment and try again.";
  }
  if (status === 502) {
    return "We couldn't read that photo. Try a sharper, straight-on shot with good light.";
  }
  if (status === 503) return "The reader is busy right now. Try again in a moment.";
  return "The menu could not be read. Try again.";
}

function publishErrorMessage(error: unknown): string {
  const status = error instanceof ApiError ? error.status : undefined;
  if (status === 400 || status === 403) {
    return serverMessage(error) ?? "The publish was rejected. Nothing was changed.";
  }
  if (status === 429) return "Too many publishes in a row. Wait a minute.";
  if (status === 503) return "The menu service is busy. Try again in a moment.";
  return "The menu could not be published. Nothing was changed — try again.";
}
