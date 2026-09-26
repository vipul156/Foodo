// ============================================================
// Foodo — Payment Cancelled Page (Stripe cancel_url)
// ============================================================
// Shown when the user closes or cancels the Stripe Checkout.

"use client";

import Link from "next/link";
import { XCircle } from "lucide-react";

export default function PaymentCancelPage() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-12">
      <div className="w-full max-w-md rounded-xl border border-border/50 bg-card p-8 text-center shadow-sm">
        <div className="mb-5 flex justify-center">
          <XCircle className="h-16 w-16 text-destructive" />
        </div>
        <h1 className="text-xl font-semibold">Payment cancelled</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your payment was cancelled and you have not been charged. You can
          retry whenever you're ready.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/checkout"
            className="inline-flex h-10 items-center justify-center rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Back to Checkout
          </Link>
          <Link
            href="/orders"
            className="inline-flex h-10 items-center justify-center rounded-xl border border-border px-5 text-sm font-medium hover:bg-accent transition-colors"
          >
            View My Orders
          </Link>
        </div>
      </div>
    </div>
  );
}
