// ============================================================
// Foodo — Toaster Component
// ============================================================

"use client";

import { useState, useEffect, createContext, useContext, useCallback, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Toast Types ─────────────────────────────────────────────

type ToastVariant = "default" | "success" | "error" | "warning";

interface Toast {
  id: string;
  message: string;
  variant?: ToastVariant;
  duration?: number;
}

interface ToastContextType {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, "id">) => void;
  removeToast: (id: string) => void;
}

// ─── Context ─────────────────────────────────────────────────

const ToastContext = createContext<ToastContextType | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within Toaster");
  return ctx;
}

// ─── Toaster Component ───────────────────────────────────────

export function Toaster({ children }: { children?: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((toast: Omit<Toast, "id">) => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { ...toast, id }]);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={removeToast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ─── Toast Item ──────────────────────────────────────────────

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
}) {
  const { id, message, variant = "default", duration = 4000 } = toast;

  useEffect(() => {
    if (duration > 0) {
      const timer = setTimeout(() => onDismiss(id), duration);
      return () => clearTimeout(timer);
    }
  }, [id, duration, onDismiss]);

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl border px-4 py-3 shadow-lg backdrop-blur-xl animate-in slide-in-from-right",
        "bg-white dark:bg-black",
        variant === "success" && "border-emerald-200 dark:border-emerald-800",
        variant === "error" && "border-red-200 dark:border-red-800",
        variant === "warning" && "border-amber-200 dark:border-amber-800",
        variant === "default" && "border-border",
      )}
    >
      <p className="flex-1 text-sm">{message}</p>
      <button
        onClick={() => onDismiss(id)}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
