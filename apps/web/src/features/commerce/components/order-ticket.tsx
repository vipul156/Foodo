// ============================================================
// Foodo — Order Ticket
// ============================================================
// The artifact the conversation produces: the draft the agent has
// assembled, priced by the server. Read-only by design — changes
// go back through the conversation, never through silent local
// edits, so the displayed total always matches a server response.

import { AlertTriangle, Check, Loader2, Trash2, UtensilsCrossed } from "lucide-react";
import type { CommerceLineItem, CommercePricing } from "../api";

export function formatMoney(value: number): string {
  const amount = Number.isFinite(value) ? value : 0;
  return `₹${amount.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

interface OrderTicketProps {
  restaurantName: string | null;
  lines: CommerceLineItem[];
  pricing: CommercePricing | null;
  budgetCap: number | null;
  canConfirm: boolean;
  building: boolean;
  progress: { done: number; total: number } | null;
  onConfirm: () => void;
  onDiscard: () => void;
  className?: string;
}

export function OrderTicket({
  restaurantName,
  lines,
  pricing,
  budgetCap,
  canConfirm,
  building,
  progress,
  onConfirm,
  onDiscard,
  className = "",
}: OrderTicketProps) {
  const unitCount = lines.reduce((sum, line) => sum + line.quantity, 0);
  // Fallback arithmetic on server-provided unit prices only. Fees are
  // never estimated here — they appear once the agent finalizes.
  const lineSubtotal = lines.reduce(
    (sum, line) => sum + line.unit_price * line.quantity,
    0,
  );
  const shownTotal = pricing?.total ?? lineSubtotal;
  const overBudget =
    budgetCap !== null && pricing !== null && pricing.total > budgetCap;

  return (
    <section
      aria-label="Draft order"
      className={`flex flex-col rounded-2xl border border-border/60 bg-card ${className}`}
    >
      <header className="border-b border-border/60 px-5 pt-5 pb-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <UtensilsCrossed className="h-4 w-4 text-primary" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-semibold">
              {restaurantName || (lines.length > 0 ? "Your draft" : "Nothing on the ticket yet")}
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {lines.length > 0
                ? `${unitCount} ${unitCount === 1 ? "item" : "items"} · ${formatMoney(shownTotal)}`
                : "Say what you feel like eating and the draft builds itself."}
            </p>
          </div>
        </div>
      </header>

      {lines.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 text-center">
          <p className="max-w-[26ch] text-sm text-muted-foreground">
            Dishes land here with their real menu price — nothing is added to
            your cart until you say so.
          </p>
        </div>
      ) : (
        <>
          <ul className="flex-1 divide-y divide-border/60 px-5">
            {lines.map((line, index) => (
              <li
                key={`${line.item_id}-${index}`}
                className="flex items-start justify-between gap-4 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    <span className="mr-2 inline-flex min-w-6 justify-center rounded-md bg-muted px-1.5 py-0.5 text-xs font-semibold tabular-nums">
                      {line.quantity}
                    </span>
                    <span className="align-middle">{line.name}</span>
                  </p>
                  {line.customizations.length > 0 && (
                    <p className="mt-1 pl-8 text-xs text-muted-foreground">
                      {line.customizations.join(" · ")}
                    </p>
                  )}
                </div>
                <p className="shrink-0 text-sm font-medium tabular-nums">
                  {formatMoney(line.unit_price * line.quantity)}
                </p>
              </li>
            ))}
          </ul>

          <div className="space-y-1.5 border-t border-border/60 px-5 py-4 text-sm">
            <Row label="Subtotal" value={formatMoney(pricing?.subtotal ?? lineSubtotal)} />
            {pricing ? (
              <>
                <Row
                  label="Delivery"
                  value={pricing.delivery_fee === 0 ? "Free" : formatMoney(pricing.delivery_fee)}
                />
                <Row label="Platform fee" value={formatMoney(pricing.platform_fee)} />
                <div className="mt-2 flex items-baseline justify-between border-t border-border/60 pt-2">
                  <span className="font-medium">Total</span>
                  <span className="text-lg font-bold tabular-nums text-primary">
                    {formatMoney(pricing.total)}
                  </span>
                </div>
              </>
            ) : (
              <p className="pt-1 text-xs text-muted-foreground">
                Delivery and platform fee are added when the total is finalized.
              </p>
            )}

            {budgetCap !== null && (
              <p
                className={`flex items-center gap-1.5 pt-2 text-xs ${
                  overBudget
                    ? "text-amber-700 dark:text-amber-400"
                    : "text-muted-foreground"
                }`}
              >
                {overBudget ? (
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                ) : (
                  <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                )}
                {overBudget
                  ? `${formatMoney(pricing!.total - budgetCap)} over your ${formatMoney(budgetCap)} cap`
                  : `Within your ${formatMoney(budgetCap)} cap`}
              </p>
            )}
          </div>
        </>
      )}

      <div className="border-t border-border/60 px-5 py-4">
        <button
          type="button"
          onClick={onConfirm}
          disabled={!canConfirm || building || lines.length === 0}
          className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary text-sm font-medium text-primary-foreground shadow-lg shadow-primary/20 transition-all duration-200 hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
        >
          {building ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {progress
                ? `Adding ${progress.done} of ${progress.total}…`
                : "Building your cart…"}
            </>
          ) : (
            "Move to checkout"
          )}
        </button>
        <p className="mt-2 text-center text-xs text-muted-foreground">
          Replaces your current cart. You pick the address and payment next.
        </p>
        {lines.length > 0 && (
          <button
            type="button"
            onClick={onDiscard}
            disabled={building}
            className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg py-1 text-xs text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            Discard this draft
          </button>
        )}
      </div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
