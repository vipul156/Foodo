// ============================================================
// Foodo — Payment Success Page (Stripe return URL)
// ============================================================
// Stripe redirects here with ?session_id=... after a successful
// Checkout Session. We verify the session server-side (which
// publishes the payment-success event over RabbitMQ) and then
// send the user to their orders.

"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useVerifyStripePayment } from "@/features/orders/api";
import {
  CheckCircle2,
  Loader2,
  XCircle,
  ShoppingBag,
} from "lucide-react";
import Link from "next/link";

type VerifyStatus = "verifying" | "success" | "error";

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
  const sessionId = useSearchParamsSafe();
  const verifyPayment = useVerifyStripePayment();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<VerifyStatus>("verifying");
  // Guard against React strict-mode double effect runs —
  // verification must fire exactly once per attempt.
  const verifiedRef = useRef(false);
  // Bumped by "Try Again" to re-run verification
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!sessionId || verifiedRef.current) return;
    verifiedRef.current = true;
    setStatus("verifying");

    verifyPayment
      .mutateAsync(sessionId)
      .then(() => {
        // Payment confirmed → the backend clears the cart. Update the
        // cache immediately so the cart badge/sheet empties on the spot.
        queryClient.setQueryData(["cart"], {
          success: true,
          cart: [],
          subtotal: 0,
          cartLength: 0,
        });
        setStatus("success");
      })
      .catch(() => setStatus("error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, attempt]);

  // Auto-redirect to orders once verified
  useEffect(() => {
    if (status !== "success") return;
    const timer = setTimeout(() => router.push("/orders"), 2500);
    return () => clearTimeout(timer);
  }, [status, router]);

  // No session id — Stripe never sent one
  if (!sessionId) {
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

  if (status === "verifying") {
    return (
      <PaymentStateCard
        icon={<Loader2 className="h-16 w-16 animate-spin text-primary" />}
        title="Confirming your payment..."
        description="Hang tight while we verify your payment with Stripe."
      />
    );
  }

  if (status === "error") {
    return (
      <PaymentStateCard
        icon={<XCircle className="h-16 w-16 text-destructive" />}
        title="Verification failed"
        description="We couldn't confirm your payment automatically. If money was deducted, don't worry — check My Orders in a moment or contact support."
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
              verifiedRef.current = false;
              setAttempt((n) => n + 1);
            }}
            className="inline-flex h-10 items-center justify-center rounded-xl border border-border px-5 text-sm font-medium hover:bg-accent transition-colors"
          >
            Try Again
          </button>
        </div>
      </PaymentStateCard>
    );
  }

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

// ─── Helpers ─────────────────────────────────────────────────

function useSearchParamsSafe(): string | null {
  const [sessionId, setSessionId] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setSessionId(params.get("session_id"));
  }, []);

  return sessionId;
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
