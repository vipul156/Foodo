// ============================================================
// Foodo — Admin Review Queue (/admin/reviews)
// ============================================================
// The human end of the AI arbitration tier. When the agent cannot
// settle a dispute on its own — ambiguous photo evidence, a low trust
// score, a suspicious delivery trail, or a refused refund — it parks
// a work item here with a written brief.
//
// The brief is the whole job: complaint, vision triage, trust score,
// delivery flags, the agent's analysis and its recommendation. Money
// moves happen with the payment provider; closing the item here is
// the queue's bookkeeping, recorded against the admin's session.
//
// The customer's photo sits at the top of the panel: for a damage claim
// the picture IS the evidence, and a reviewer who has to go hunting for
// it is reviewing blind.

"use client";

import { useState } from "react";
import { GlassCard } from "@/components/shared/glass-card";
import { RoleGuard } from "@/components/shared/role-guard";
import { useToast } from "@/components/ui/toaster";
import { ApiError } from "@/lib/api-client";
import {
  useCaseEvidence,
  usePendingReviews,
  useResolveReview,
  type ReviewItem,
} from "@/features/disputes/api";
import {
  AlertTriangle,
  Check,
  ExternalLink,
  ImageOff,
  Inbox,
  Loader2,
  RefreshCw,
  ShieldQuestion,
} from "lucide-react";

export default function AdminReviewsPage() {
  const { data, isLoading, isError, isFetching, refetch, dataUpdatedAt } = usePendingReviews(50);
  const resolve = useResolveReview();
  const { addToast } = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const items = data ?? [];
  // A bounded list (≤50): the find is cheaper than memo bookkeeping.
  const selected = items.find((item) => item.id === selectedId) ?? items[0] ?? null;

  const highCount = items.filter((item) => item.priority === "high").length;

  return (
    <RoleGuard allowedRoles={["admin"]}>
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold tracking-tight">Review queue</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Disputes the AI agent couldn&apos;t settle on its own. It handles the rest without
              you.
            </p>
          </div>

          <div className="flex items-center gap-2">
            {highCount > 0 && (
              <span className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-destructive/10 px-3 text-xs font-semibold text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                {highCount} high priority
              </span>
            )}
            <button
              onClick={() => void refetch()}
              disabled={isFetching}
              className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-border px-3 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-60"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`}
                aria-hidden="true"
              />
              {dataUpdatedAt ? `Updated ${timeAgo(new Date(dataUpdatedAt).toISOString())}` : "Refresh"}
            </button>
          </div>
        </div>

        {isLoading ? (
          <GlassCard className="space-y-3 p-5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-xl bg-muted/60" />
            ))}
          </GlassCard>
        ) : isError ? (
          <GlassCard className="flex flex-col items-center py-14 text-center">
            <AlertTriangle className="h-10 w-10 text-destructive" aria-hidden="true" />
            <h3 className="mt-3 text-base font-semibold">Couldn&apos;t load the queue</h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              The review queue didn&apos;t answer. Nothing is lost — the items are still parked.
            </p>
            <button
              onClick={() => void refetch()}
              className="mt-4 inline-flex h-9 items-center rounded-xl border border-border px-4 text-xs font-medium transition-colors hover:bg-accent"
            >
              Try again
            </button>
          </GlassCard>
        ) : items.length === 0 ? (
          <GlassCard className="flex flex-col items-center py-16 text-center">
            <Inbox className="h-10 w-10 text-muted-foreground/50" aria-hidden="true" />
            <h3 className="mt-3 text-base font-semibold">Nothing waiting</h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Every escalated dispute has been closed. New ones appear here as soon as the agent
              hands them over.
            </p>
          </GlassCard>
        ) : (
          <div className="grid gap-5 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
            <ul className="space-y-2">
              {items.map((item) => (
                <li key={item.id}>
                  <QueueRow
                    item={item}
                    active={selected?.id === item.id}
                    onSelect={() => setSelectedId(item.id)}
                  />
                </li>
              ))}
            </ul>

            {selected && (
              <div className="lg:sticky lg:top-24 lg:self-start">
                <DetailPanel
                  item={selected}
                  resolving={resolve.isPending && resolve.variables === selected.id}
                  onResolve={() => {
                    resolve.mutate(selected.id, {
                      onSuccess: () =>
                        addToast({ message: "Item closed", variant: "success" }),
                      onError: (error) =>
                        addToast({
                          message:
                            error instanceof ApiError && error.status === 404
                              ? "That item was already closed"
                              : "Couldn't close that item — try again",
                          variant: "error",
                        }),
                    });
                  }}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </RoleGuard>
  );
}

// ─── Queue row ───────────────────────────────────────────────

function QueueRow({
  item,
  active,
  onSelect,
}: {
  item: ReviewItem;
  active: boolean;
  onSelect: () => void;
}) {
  const lead = item.summary.split("\n")[0] ?? "";
  const complaintLine =
    item.summary.split("\n").find((line) => line.startsWith("Complaint:")) ?? "";

  return (
    <button
      onClick={onSelect}
      aria-current={active}
      className={`w-full rounded-xl border p-3 text-left transition-colors ${
        active ? "border-foreground/25 bg-accent/60" : "border-border hover:bg-accent/40"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            item.priority === "high"
              ? "bg-destructive"
              : item.priority === "low"
                ? "bg-muted-foreground/40"
                : "bg-foreground/50"
          }`}
          aria-hidden="true"
        />
        <span className="text-xs font-semibold">{typeLabel(item.type)}</span>
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
          {timeAgo(item.createdAt)}
        </span>
      </div>

      <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">
        {complaintLine.replace(/^Complaint:\s*/, "") || lead}
      </p>

      {item.orderId && (
        <p className="mt-1.5 truncate font-mono text-[11px] text-muted-foreground/80">
          order {item.orderId.slice(-8).toUpperCase()}
        </p>
      )}
    </button>
  );
}

// ─── Detail ──────────────────────────────────────────────────

function DetailPanel({
  item,
  resolving,
  onResolve,
}: {
  item: ReviewItem;
  resolving: boolean;
  onResolve: () => void;
}) {
  const lines = item.summary.split("\n");
  const [lead, ...rest] = lines;
  const fields = rest.map(parseField).filter((f) => f.value.length > 0);

  // Items parked before the queue carried the photo keep it on the case
  // row (same id), so a missing field is not yet a missing photo.
  const evidence = useCaseEvidence(item.id, !item.photoUrl);
  const photoUrl = item.photoUrl ?? evidence.data?.photoUrl ?? null;
  const photoPending = !item.photoUrl && evidence.isPending;

  return (
    <GlassCard className="p-0">
      <div className="border-b border-border/60 p-5">
        <div className="flex items-center gap-2">
          <ShieldQuestion className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <h3 className="text-sm font-semibold">{typeLabel(item.type)}</h3>
          <span
            className={`ml-auto rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
              item.priority === "high"
                ? "bg-destructive/10 text-destructive"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {item.priority} priority
          </span>
        </div>
        <p className="mt-2 text-sm">{lead}</p>
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-foreground">
          <span>case {item.id}</span>
          {item.orderId && <span>order {item.orderId}</span>}
          <span>{timeAgo(item.createdAt)}</span>
        </p>
      </div>

      <EvidenceBlock photoUrl={photoUrl} pending={photoPending} />

      <dl className="divide-y divide-border/60">
        {fields.map((field) => (
          <div key={field.label} className="grid gap-1 px-5 py-3 sm:grid-cols-[8.5rem_minmax(0,1fr)]">
            <dt className="text-xs font-medium text-muted-foreground">{field.label}</dt>
            <dd className="text-sm">{field.value}</dd>
          </div>
        ))}
      </dl>

      <div className="space-y-3 border-t border-border/60 bg-muted/30 p-5">
        <p className="text-xs text-muted-foreground">
          Issue the refund or voucher with the payment provider first — then close the item.
          Who closed it is recorded on the case.
        </p>

        <button
          onClick={onResolve}
          disabled={resolving}
          className="inline-flex h-10 items-center gap-1.5 rounded-xl bg-primary px-4 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {resolving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {resolving ? "Closing…" : "Mark handled"}
        </button>

        <p className="text-[11px] text-muted-foreground">
          The customer follows this case on their own order page, not here.
        </p>
      </div>
    </GlassCard>
  );
}

// ─── Evidence ────────────────────────────────────────────────
// Three states, all honest: the photo, "still loading" (a legacy item
// whose URL is one read away), or "none attached" — which is itself a
// reason the agent escalated, so the reviewer must be told plainly
// rather than shown an empty frame.

function EvidenceBlock({
  photoUrl,
  pending,
}: {
  photoUrl: string | null;
  pending: boolean;
}) {
  if (pending) {
    return (
      <div className="border-b border-border/60 p-5">
        <p className="text-xs font-medium text-muted-foreground">Customer photo</p>
        <div
          className="mt-2 h-40 animate-pulse rounded-xl bg-muted/60"
          role="status"
          aria-label="Loading the customer's photo"
        />
      </div>
    );
  }

  if (!photoUrl) {
    return (
      <div className="flex items-center gap-2 border-b border-border/60 px-5 py-4">
        <ImageOff className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <p className="text-xs text-muted-foreground">
          No photo was attached to this claim — the customer&apos;s account is all the evidence
          there is.
        </p>
      </div>
    );
  }

  return (
    <figure className="border-b border-border/60 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <figcaption className="text-xs font-medium text-muted-foreground">
          Customer photo
        </figcaption>
        <a
          href={photoUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          <ExternalLink className="h-3 w-3" aria-hidden="true" />
          Open full size
        </a>
      </div>
      <a
        href={photoUrl}
        target="_blank"
        rel="noreferrer"
        className="mt-2 block overflow-hidden rounded-xl border border-border bg-muted/40"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={photoUrl}
          alt="Photo the customer attached as evidence"
          className="mx-auto max-h-80 w-full object-contain"
        />
      </a>
    </figure>
  );
}

// ─── Helpers ─────────────────────────────────────────────────

/** "Label: value" lines become rows; anything else keeps its text. */
function parseField(line: string, index: number): { label: string; value: string } {
  const match = /^([A-Z][^:]{1,30}):\s*(.+)$/.exec(line);
  if (match && match[1] && match[2]) {
    return { label: match[1], value: match[2] };
  }
  return { label: `Note ${index + 1}`, value: line };
}

const typeLabels: Record<string, string> = {
  refund_arbitration: "Refund arbitration",
};

function typeLabel(type: string): string {
  return typeLabels[type] ?? type.replace(/_/g, " ");
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const minutes = Math.floor((Date.now() - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}
