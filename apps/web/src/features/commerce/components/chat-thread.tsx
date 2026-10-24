// ============================================================
// Foodo — Conversation Surface
// ============================================================
// Customer messages are compact chips; the assistant answers in
// plain prose with no bubble, so the reply reads like a counter
// hand-off rather than a chat log. Every assistant turn that ran
// tools can show what it actually checked — provenance, on demand.

"use client";

import { useEffect, useRef, type FormEvent, type KeyboardEvent } from "react";
import { AlertCircle, ArrowUp, Check, Loader2, Sparkles, X } from "lucide-react";
import type { CommerceToolStep } from "../api";

export type ChatRole = "user" | "assistant" | "error" | "notice";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  trace?: CommerceToolStep[];
}

const TOOL_LABELS: Record<string, string> = {
  get_past_orders: "Checked your recent orders",
  search_menu_items: "Searched the menu",
  draft_set_restaurant: "Chose the restaurant",
  draft_add_item: "Added a dish",
  draft_swap_item: "Swapped a dish",
  draft_remove_item: "Removed a dish",
  draft_update_quantity: "Changed a quantity",
  draft_finalize: "Priced the order",
};

// ─── Thread ──────────────────────────────────────────────────

export function ChatThread({
  messages,
  pending,
  endRef,
}: {
  messages: ChatMessage[];
  pending: boolean;
  endRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      role="log"
      aria-live="polite"
      aria-relevant="additions text"
      aria-label="Conversation"
      className="flex flex-col gap-6"
    >
      {messages.map((message) => (
        <Message key={message.id} message={message} />
      ))}

      {pending && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ThinkingDots />
          <span className="sr-only">Foodo is composing your order</span>
        </div>
      )}

      <div ref={endRef} />
    </div>
  );
}

function Message({ message }: { message: ChatMessage }) {
  if (message.role === "notice") {
    return (
      <p className="text-center text-xs text-muted-foreground">{message.text}</p>
    );
  }

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm leading-relaxed text-primary-foreground">
          {message.text}
        </p>
      </div>
    );
  }

  if (message.role === "error") {
    return (
      <div className="flex items-start gap-2.5 rounded-xl bg-destructive/5 px-4 py-3">
        <AlertCircle
          className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
          aria-hidden="true"
        />
        <p className="text-sm leading-relaxed">{message.text}</p>
      </div>
    );
  }

  return (
    <div className="max-w-[62ch] animate-in fade-in slide-in-from-bottom-1 duration-300">
      <p className="text-[15px] leading-relaxed whitespace-pre-line">
        {message.text}
      </p>
      {message.trace && message.trace.length > 0 && (
        <ToolTrace trace={message.trace} />
      )}
    </div>
  );
}

function ToolTrace({ trace }: { trace: CommerceToolStep[] }) {
  const results = trace.filter((step) => step.type === "tool_result");
  if (results.length === 0) return null;

  const failed = results.filter((step) => step.ok === false).length;

  return (
    <details className="group mt-2.5">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md text-xs text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
        <Check className="h-3 w-3" aria-hidden="true" />
        {results.length} {results.length === 1 ? "check" : "checks"}
        {failed > 0 && <span className="text-amber-700 dark:text-amber-400">· {failed} failed</span>}
        <span className="text-border group-open:hidden" aria-hidden="true">/</span>
        <span className="hidden text-border group-open:inline" aria-hidden="true">×</span>
      </summary>
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {results.map((step, index) => (
          <li
            key={`${step.tool}-${index}`}
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs ${
              step.ok === false
                ? "bg-amber-600/10 text-amber-800 dark:text-amber-400"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {step.ok === false ? (
              <X className="h-3 w-3" aria-hidden="true" />
            ) : (
              <Check className="h-3 w-3" aria-hidden="true" />
            )}
            {TOOL_LABELS[step.tool ?? ""] ?? step.tool}
          </li>
        ))}
      </ul>
    </details>
  );
}

function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-1" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="foodo-composing-dot h-1.5 w-1.5 rounded-full bg-muted-foreground/60"
        />
      ))}
    </span>
  );
}

// ─── Empty state ─────────────────────────────────────────────

const STARTERS = [
  {
    label: "Order my usual",
    prompt: "Order my usual from the last place I ordered.",
  },
  {
    label: "Dinner under ₹400 for two",
    prompt:
      "Find me dinner for two under ₹400. Something filling, no beef.",
  },
  {
    label: "Something spicy, no onion",
    prompt: "I want something spicy for one, and I don't eat onion.",
  },
];

export function StarterPrompts({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="max-w-xl">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
        Tell us what you feel like eating.
      </h1>
      <p className="mt-3 text-base text-muted-foreground">
        Foodo looks up the real menus, prices every dish at its menu rate, and
        builds a draft on the right. You confirm before anything reaches your
        cart.
      </p>
      <div className="mt-7 flex flex-wrap gap-2">
        {STARTERS.map((starter) => (
          <button
            key={starter.label}
            type="button"
            onClick={() => onPick(starter.prompt)}
            className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3.5 py-2 text-sm transition-colors hover:border-foreground/25 hover:bg-accent"
          >
            <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
            {starter.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Composer ────────────────────────────────────────────────

const MAX_LENGTH = 1000;

export function Composer({
  value,
  onChange,
  onSubmit,
  pending,
  disabled,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  pending: boolean;
  disabled: boolean;
  placeholder: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const trimmed = value.trim();
  const canSend = trimmed.length > 0 && !pending && !disabled;

  // Grow with the content, never past four lines.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [value]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (canSend) onSubmit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (canSend) onSubmit();
    }
  };

  return (
    <form onSubmit={handleSubmit} className="relative">
      <label htmlFor="commerce-composer" className="sr-only">
        Describe what you want to order
      </label>
      <div className="flex items-end gap-2 rounded-2xl border border-border/60 bg-card p-2 transition-colors focus-within:border-foreground/30">
        <textarea
          id="commerce-composer"
          ref={textareaRef}
          rows={1}
          value={value}
          maxLength={MAX_LENGTH}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={placeholder}
          aria-describedby="commerce-composer-hint"
          className="max-h-32 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-sm leading-relaxed outline-none placeholder:text-muted-foreground disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={!canSend}
          aria-label="Send message"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground transition-all duration-200 hover:brightness-110 active:scale-95 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none"
        >
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <ArrowUp className="h-4 w-4" aria-hidden="true" />
          )}
        </button>
      </div>
      <p
        id="commerce-composer-hint"
        className="mt-2 flex items-center justify-between px-1 text-[11px] text-muted-foreground"
      >
        <span>Enter to send · Shift + Enter for a new line</span>
        {value.length > MAX_LENGTH * 0.9 && (
          <span className="tabular-nums">
            {value.length}/{MAX_LENGTH}
          </span>
        )}
      </p>
    </form>
  );
}
