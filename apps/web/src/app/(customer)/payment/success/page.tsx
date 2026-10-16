// ============================================================
// Foodo — Payment Success Page (gateway return URL)
// ============================================================
// Stripe/Razorpay redirect here after payment. This page is UX-only:
// it polls the read-only order status endpoint while the webhook
// (source of truth) marks the order paid in the background, then
// unlocks and sends the user to their orders.

"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useOrderPaymentStatus } from "@/features/orders/api";
import {
  CheckCircle2,
  Loader2,
  XCircle,
  ShoppingBag,
} from "lucide-react";
import Link from "next/link";

// Webhooks normally land in 1–2s; wait this long before offering
// escape hatches instead of an endless spinner.
const POLL_TIMEOUT_MS = 60_000;

export default function PaymentSuccessPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[60vh] items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      }
    >
      <PaymentSuccessContent />
    </Suspense>
  );
}

function PaymentSuccessContent() {
  const router = useRouter();
  const orderId = useOrderIdParam();
  const queryClient = useQueryClient();
  const { data } = useOrderPaymentStatus(orderId);

  const [timedOut, setTimedOut] = useState(false);
  const startedAtRef = useRef(Date.now());

  const isPaid = data?.paymentStatus === "paid";

  // Reset the polling window whenever a fresh orderId arrives
  useEffect(() => {
    if (!orderId) return;
    startedAtRef.current = Date.now();
    setTimedOut(false);
  }, [orderId]);

  useEffect(() => {
    if (!orderId || isPaid) return;
    const timer = setInterval(() => {
      if (Date.now() - startedAtRef.current > POLL_TIMEOUT_MS) {
        setTimedOut(true);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [orderId, isPaid]);

  // Paid → sync caches (the backend already cleared the cart when the
  // webhook was processed) and auto-redirect to orders.
  useEffect(() => {
    if (!isPaid) return;
    queryClient.setQueryData(["cart"], {
      success: true,
      cart: [],
      subtotal: 0,
      cartLength: 0,
    });
    queryClient.invalidateQueries({ queryKey: ["orders"] });
    const timer = setTimeout(() => router.push("/orders"), 2500);
    return () => clearTimeout(timer);
  }, [isPaid, queryClient, router]);

  // No orderId — the gateway never sent one
  if (!orderId) {
    return (
      <PaymentStateCard
        icon={<XCircle className="h-16 w-16 text-destructive" />}
        title="Invalid payment link"
        description="No payment session was found. If you completed a payment, check My Orders or contact support."
      >
        <Link
          href="/orders"
          className="inline-flex h-10 items-center justify-center rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          View My Orders
        </Link>
      </PaymentStateCard>
    );
  }

  if (isPaid) {
    return (
      <PaymentStateCard
        icon={<CheckCircle2 className="h-16 w-16 text-emerald-500" />}
        title="Payment successful!"
        description="Your order has been placed and is being prepared. Redirecting you to your orders..."
      >
        <Link
          href="/orders"
          className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <ShoppingBag className="h-4 w-4" />
          View My Orders
        </Link>
      </PaymentStateCard>
    );
  }

  if (timedOut) {
    return (
      <PaymentStateCard
        icon={<XCircle className="h-16 w-16 text-amber-500" />}
        title="Still confirming your payment"
        description="We haven't received the bank confirmation yet. If money was deducted, don't worry — your order will appear in My Orders the moment it lands."
      >
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/orders"
            className="inline-flex h-10 items-center justify-center rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            View My Orders
          </Link>
          <button
            onClick={() => {
              startedAtRef.current = Date.now();
              setTimedOut(false);
            }}
            className="inline-flex h-10 items-center justify-center rounded-xl border border-border px-5 text-sm font-medium hover:bg-accent transition-colors"
          >
            Keep Waiting
          </button>
        </div>
      </PaymentStateCard>
    );
  }

  return (
    <PaymentStateCard
      icon={<Loader2 className="h-16 w-16 animate-spin text-primary" />}
      title="Confirming your payment..."
      description="Hang tight while we confirm your payment with the bank. This usually takes just a few seconds."
    />
  );
}

// ─── Helpers ─────────────────────────────────────────────────

function useOrderIdParam(): string | null {
  const [orderId, setOrderId] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setOrderId(params.get("orderId"));
  }, []);

  return orderId;
}

function PaymentStateCard({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-12">
      <div className="w-full max-w-md rounded-xl border border-border/50 bg-card p-8 text-center shadow-sm">
        <div className="mb-5 flex justify-center">{icon}</div>
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        {children && <div className="mt-6">{children}</div>}
      </div>
    </div>
  );
}
