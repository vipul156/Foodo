"use client";

// ============================================================
// Foodo — /assistant : conversational ordering
// ============================================================
// DIRECTION CONTRACT (Operate — the customer completes an order)
// THESIS: Ordering is a conversation with a receipts desk, not a chat
// app. The reply is the service; the ticket is the proof.
// OWN-WORLD: Foodo's monochrome, hairline, quiet-radius world — ink on
// paper. No bubbles, no gradient, no AI theatre. One accent where money
// is decided: the total.
// STORY: Name a craving → Foodo searches real menus, drafts it, prices
// it → the ticket fills on the right → the customer confirms → the
// existing cart and checkout take over.
// FIRST VIEWPORT: A question worth answering on the left, an empty
// ticket on the right, three honest starters. Nothing to learn.
// FORM: Two columns above 1024px; one column below, where the ticket
// arrives as a sheet over a sticky total bar.
// FINISH: unreviewed and undocumented is unfinished; this build ends
// with the finish review, the verdict, and DESIGN.md.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Loader2,
  MessageSquarePlus,
  Receipt,
  Sparkles,
  X,
} from "lucide-react";
import { AiModal } from "@/components/shared/ai-modal";
import { useToast } from "@/components/ui/toaster";
import { useAuthHydrated, useAuthStore } from "@/store/auth-store";
import { ApiError } from "@/lib/api-client";
import {
  useCommerceSessions,
  useCommerceTurn,
  useDiscardConversation,
  useMaterializeDraft,
  useResumeConversation,
  type CommerceCheckoutCard,
  type CommerceDraft,
  type CommerceLineItem,
  type CommercePricing,
} from "@/features/commerce/api";
import {
  ChatThread,
  Composer,
  OrderTicket,
  StarterPrompts,
  formatMoney,
  type ChatMessage,
} from "@/features/commerce/components";

function makeId(): string {
  // Client-only surface; crypto.randomUUID is available in every
  // browser this app targets, but keep a fallback for old WebViews.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export default function AssistantPage() {
  const router = useRouter();
  const hydrated = useAuthHydrated();
  const { isAuthenticated } = useAuthStore();
  const { addToast } = useToast();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CommerceDraft | null>(null);
  const [card, setCard] = useState<CommerceCheckoutCard | null>(null);
  const [input, setInput] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [limitHit, setLimitHit] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);

  const endRef = useRef<HTMLDivElement>(null);

  const turn = useCommerceTurn();
  const sessions = useCommerceSessions(isAuthenticated && hydrated);
  const resume = useResumeConversation();
  const discard = useDiscardConversation();
  const materialize = useMaterializeDraft();

  const lastMessageId = messages[messages.length - 1]?.id;

  // Follow the conversation. The composer sits below the scroll area,
  // so the newest turn must be brought into view after it lands.
  useEffect(() => {
    if (!lastMessageId) return;
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [lastMessageId, turn.isPending]);

  const send = useCallback(
    (text: string) => {
      const message = text.trim();
      if (!message || turn.isPending) return;

      setMessages((prev) => [
        ...prev,
        { id: makeId(), role: "user", text: message },
      ]);
      setInput("");
      setLimitHit(false);

      turn.mutate(
        { message, sessionId },
        {
          onSuccess: (data) => {
            setSessionId(data.session_id);
            setDraft(data.draft);
            setCard(data.checkout_card);
            setMessages((prev) => [
              ...prev,
              {
                id: makeId(),
                role: "assistant",
                text: data.reply,
                trace: data.tool_trace,
              },
            ]);
          },
          onError: (error) => {
            const status = error instanceof ApiError ? error.status : undefined;
            setMessages((prev) => [
              ...prev,
              { id: makeId(), role: "error", text: turnErrorMessage(status) },
            ]);
            if (status === 409) {
              // The session exists but refuses more turns. The draft is
              // still on the server, so offer a clean start rather than
              // silently resetting the UI underneath the customer.
              setLimitHit(true);
            } else if (status === 404) {
              setSessionId(null);
              setDraft(null);
              setCard(null);
            }
          },
        },
      );
    },
    [sessionId, turn],
  );

  const startNew = useCallback(() => {
    if (sessionId) discard.mutate(sessionId);
    setSessionId(null);
    setDraft(null);
    setCard(null);
    setMessages([]);
    setInput("");
    setLimitHit(false);
    setHandoffError(null);
  }, [discard, sessionId]);

  const pickUp = (id: string) => {
    resume.mutate(id, {
      onSuccess: (data) => {
        setSessionId(data.sessionId);
        setDraft(data.draft);
        setCard(data.card);
        setMessages([
          {
            id: makeId(),
            role: "notice",
            text: "Picked up your last draft. Ask for a change, or move it to checkout.",
          },
        ]);
        setHandoffError(null);
      },
      onError: () => {
        addToast({ message: "That draft is no longer available.", variant: "error" });
        sessions.refetch();
      },
    });
  };

  const handleDiscard = () => {
    // startNew() owns the DELETE — calling it twice would 404 on the second.
    startNew();
    addToast({ message: "Draft discarded. Nothing was added to your cart." });
  };

  const handleConfirm = () => {
    if (!card) return;
    setHandoffError(null);
    materialize.mutate(
      { card, onProgress: (done, total) => setProgress({ done, total }) },
      {
        onSuccess: (result) => {
          setProgress(null);
          setConfirmOpen(false);
          addToast({
            message: `Cart rebuilt with ${result.units} ${
              result.units === 1 ? "item" : "items"
            }.`,
            variant: "success",
          });
          router.push("/checkout");
        },
        onError: (error) => {
          setProgress(null);
          setConfirmOpen(false);
          const message =
            error instanceof Error
              ? error.message
              : "Your cart could not be rebuilt.";
          setHandoffError(message);
          addToast({ message, variant: "error" });
        },
      },
    );
  };

  if (!hydrated) {
    return (
      <div
        className="mx-auto min-h-[60vh] w-full max-w-6xl px-4 sm:px-6 lg:px-8"
        aria-busy="true"
        aria-label="Loading"
      />
    );
  }

  if (!isAuthenticated) {
    return <GuestGate />;
  }

  const lines = card?.lines ?? draft?.lines ?? [];
  const pricing: CommercePricing | null = card?.pricing ?? draft?.pricing ?? null;
  const restaurantName = card?.restaurant_name ?? draft?.restaurant_name ?? null;
  const unitCount = lines.reduce((sum, line) => sum + line.quantity, 0);
  const lineSubtotal = lines.reduce(
    (sum, line) => sum + line.unit_price * line.quantity,
    0,
  );
  const started = messages.length > 0 || sessionId !== null;
  const recent = (sessions.data?.sessions ?? []).filter(
    (item) => item.has_draft && item.session_id !== sessionId,
  );

  const ticketProps = {
    restaurantName,
    lines,
    pricing,
    budgetCap: draft?.budget_cap ?? null,
    canConfirm: card !== null,
    building: materialize.isPending,
    progress,
    onConfirm: () => setConfirmOpen(true),
    onDiscard: handleDiscard,
  };

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-28 sm:px-6 lg:px-8 lg:pb-16">
      <div className="grid gap-8 pt-8 lg:grid-cols-[minmax(0,1fr)_21rem] lg:gap-12 lg:pt-10">
        {/* ── Conversation ───────────────────────────────────── */}
        <div className="flex min-w-0 flex-col lg:h-[calc(100vh-8rem)] lg:min-h-[32rem]">
          {started ? (
            <div className="flex items-center justify-between gap-3 pb-5">
              <p className="min-w-0 truncate text-sm text-muted-foreground">
                {restaurantName
                  ? `Drafting with ${restaurantName}`
                  : "New conversation"}
              </p>
              <button
                type="button"
                onClick={startNew}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden="true" />
                New chat
              </button>
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overscroll-contain lg:overflow-y-auto lg:pr-1">
            {started ? (
              <ChatThread
                messages={messages}
                pending={turn.isPending}
                endRef={endRef}
              />
            ) : (
              <>
                <StarterPrompts onPick={send} />
                {recent.length > 0 && (
                  <div className="mt-9 border-t border-border/60 pt-5">
                    <p className="text-xs font-medium text-muted-foreground">
                      Unfinished drafts
                    </p>
                    <ul className="mt-2.5 flex flex-col gap-1">
                      {recent.slice(0, 3).map((item) => (
                        <li key={item.session_id}>
                          <button
                            type="button"
                            onClick={() => pickUp(item.session_id)}
                            disabled={resume.isPending}
                            className="group flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-accent disabled:opacity-60"
                          >
                            <span className="truncate">
                              Draft from {formatWhen(item.updated_at)}
                            </span>
                            <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition-colors group-hover:text-foreground">
                              {resume.isPending && resume.variables === item.session_id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                              ) : (
                                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                              )}
                              Pick up
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="shrink-0 pt-6">
            {limitHit ? (
              <div className="rounded-2xl border border-amber-600/30 bg-amber-600/5 p-4">
                <p className="text-sm">
                  This conversation reached its turn limit. Your draft stays
                  saved — start a fresh conversation to keep editing it.
                </p>
                <button
                  type="button"
                  onClick={startNew}
                  className="mt-3 inline-flex h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  Start a new conversation
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            ) : (
              <Composer
                value={input}
                onChange={setInput}
                onSubmit={() => send(input)}
                pending={turn.isPending}
                disabled={false}
                placeholder={
                  started
                    ? "Swap a dish, change the budget, add a drink…"
                    : "What do you feel like eating?"
                }
              />
            )}
          </div>
        </div>

        {/* ── Ticket (desktop) ──────────────────────────────── */}
        <aside className="hidden lg:block">
          <div className="sticky top-24">
            <div className="space-y-3">
              {handoffError && <HandoffNotice message={handoffError} />}
              <OrderTicket {...ticketProps} />
            </div>
          </div>
        </aside>
      </div>

      {/* ── Ticket (mobile) ─────────────────────────────────── */}
      {lines.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border/60 bg-background/95 backdrop-blur-xl lg:hidden">
          <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-muted-foreground">
                {unitCount} {unitCount === 1 ? "item" : "items"}
                {restaurantName ? ` · ${restaurantName}` : ""}
              </p>
              <p className="text-base font-semibold tabular-nums">
                {formatMoney(pricing?.total ?? lineSubtotal)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSheetOpen(true)}
              className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition-all active:scale-[0.98]"
            >
              <Receipt className="h-4 w-4" aria-hidden="true" />
              Review draft
            </button>
          </div>
        </div>
      )}

      {sheetOpen && (
        <div
          className="fixed inset-0 z-40 flex items-end bg-black/50 backdrop-blur-sm lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Draft order"
          onClick={() => setSheetOpen(false)}
        >
          <div
            className="max-h-[88vh] w-full overflow-y-auto rounded-t-2xl border-t border-border bg-background p-4"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium">Your draft</p>
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                aria-label="Close draft"
                className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3">
              {handoffError && <HandoffNotice message={handoffError} />}
              <OrderTicket {...ticketProps} />
            </div>
          </div>
        </div>
      )}

      {/* ── Confirm hand-off ────────────────────────────────── */}
      <AiModal
        open={confirmOpen}
        onClose={() => {
          if (!materialize.isPending) setConfirmOpen(false);
        }}
        title="Move this draft to your cart?"
        description={
          restaurantName
            ? `${unitCount} ${unitCount === 1 ? "item" : "items"} from ${restaurantName}`
            : undefined
        }
        footer={
          <>
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              disabled={materialize.isPending}
              className="inline-flex h-10 items-center rounded-xl px-4 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              Not yet
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={materialize.isPending}
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-70"
            >
              {materialize.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  {progress
                    ? `Adding ${progress.done} of ${progress.total}…`
                    : "Building…"}
                </>
              ) : (
                "Build my cart"
              )}
            </button>
          </>
        }
      >
        <ul className="divide-y divide-border/60 rounded-xl border border-border/60">
          {lines.map((line, index) => (
            <ConfirmLine key={`${line.item_id}-${index}`} line={line} />
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">
          Your current cart will be emptied and rebuilt with these dishes. You
          pick the address and pay on the next screen — nothing is charged here.
        </p>
        {pricing && (
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-muted-foreground">
              Total, fees included
            </span>
            <span className="text-base font-semibold tabular-nums">
              {formatMoney(pricing.total)}
            </span>
          </div>
        )}
      </AiModal>
    </div>
  );
}

// ─── Pieces ──────────────────────────────────────────────────

function GuestGate() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-start px-4 py-20 sm:px-6">
      <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10">
        <Sparkles className="h-5 w-5 text-primary" aria-hidden="true" />
      </span>
      <h1 className="mt-6 text-3xl font-semibold tracking-tight">
        Order by talking.
      </h1>
      <p className="mt-3 text-muted-foreground">
        Describe what you feel like eating and Foodo builds the order from real
        menus at real prices. You confirm before anything reaches your cart, so
        you need to be signed in.
      </p>
      <div className="mt-7 flex items-center gap-3">
        <Link
          href="/login"
          className="inline-flex h-11 items-center rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Log in
        </Link>
        <Link
          href="/restaurants"
          className="inline-flex h-11 items-center rounded-xl px-4 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          Browse restaurants
        </Link>
      </div>
    </div>
  );
}

function ConfirmLine({ line }: { line: CommerceLineItem }) {
  return (
    <li className="flex items-start justify-between gap-3 px-3 py-2.5 text-sm">
      <span className="min-w-0">
        <span className="mr-1.5 tabular-nums text-muted-foreground">
          {line.quantity}×
        </span>
        {line.name}
      </span>
      <span className="shrink-0 tabular-nums text-muted-foreground">
        {formatMoney(line.unit_price * line.quantity)}
      </span>
    </li>
  );
}

function HandoffNotice({ message }: { message: string }) {
  return (
    <p className="rounded-xl bg-destructive/5 px-3.5 py-2.5 text-xs leading-relaxed text-destructive">
      {message}
    </p>
  );
}

// ─── Helpers ─────────────────────────────────────────────────

function turnErrorMessage(status: number | undefined): string {
  if (status === 409) {
    return "This conversation has hit its turn limit — start a new one to keep going.";
  }
  if (status === 404) {
    return "That conversation expired. Send your message again and I'll rebuild the draft.";
  }
  if (status === 429) {
    return "That was a lot of messages at once. Give it a few seconds, then send again.";
  }
  if (status === 502 || status === 503 || status === 504) {
    return "The ordering desk is unreachable right now. Try once more.";
  }
  if (status === 401) {
    return "Your session ended. Log in again and I'll rebuild the draft.";
  }
  return "That didn't go through. Try again — nothing was added to your cart.";
}

function formatWhen(value: string | null): string {
  if (!value) return "earlier";
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "earlier";
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}
