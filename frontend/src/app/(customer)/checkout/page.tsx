// ============================================================
// Foodo — Checkout Page
// ============================================================

"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  useGetCart,
  useCreateAddress,
  useGetAddresses,
} from "@/features/restaurants/api";
import {
  useCreateOrder,
  useCreateRazorpayOrder,
  useCreateStripeSession,
} from "@/features/orders/api";
import { useAuthStore } from "@/store/auth-store";
import {
  getCurrentPosition,
  reverseGeocode,
} from "@/lib/geolocation";
import {
  ArrowLeft,
  MapPin,
  CreditCard,
  Banknote,
  Loader2,
  Plus,
  ShieldCheck,
  Navigation,
} from "lucide-react";
import Link from "next/link";

// ─── Razorpay window type ────────────────────────────────────

declare global {
  interface Window {
    Razorpay: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

interface RazorpayOptions {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  handler: (response: RazorpayResponse) => void;
  prefill?: { name?: string; email?: string; contact?: string };
  theme?: { color?: string };
  modal?: { ondismiss?: () => void };
}

interface RazorpayInstance {
  open: () => void;
  on: (
    event: string,
    handler: (response: { error: { description: string } }) => void,
  ) => void;
}

interface RazorpayResponse {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

// ─── Load Razorpay script ────────────────────────────────────

function loadRazorpayScript(): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window !== "undefined" && window.Razorpay) {
      resolve(true);
      return;
    }
    const existing = document.querySelector(
      'script[src="https://checkout.razorpay.com/v1/checkout.js"]',
    );
    if (existing) {
      existing.addEventListener("load", () => resolve(true));
      return;
    }
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

// ─── Component ───────────────────────────────────────────────

type PaymentMethod = "razorpay" | "stripe" | "cod";

export default function CheckoutPage() {
  const router = useRouter();
  const { isAuthenticated } = useAuthStore();

  const { data: cartData, isLoading: cartLoading } = useGetCart();
  const { data: addresses, isLoading: addressesLoading } = useGetAddresses();
  const createAddress = useCreateAddress();
  const createOrder = useCreateOrder();
  const createRazorpayOrder = useCreateRazorpayOrder();
  const createStripeSession = useCreateStripeSession();

  const [selectedAddressId, setSelectedAddressId] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("razorpay");
  const [isProcessing, setIsProcessing] = useState(false);
  const [showAddressForm, setShowAddressForm] = useState(false);
  const [geoLoading, setGeoLoading] = useState(false);
  const [newAddress, setNewAddress] = useState({
    mobile: "",
    formatterAddress: "",
    latitude: 0,
    longitude: 0,
  });
  const [addressError, setAddressError] = useState("");
  const [paymentError, setPaymentError] = useState("");

  const cartItems = cartData?.cart || [];
  const subtotal = cartData?.subtotal || 0;
  const deliveryFee = subtotal < 250 ? 49 : 0;
  const platformFee = 7;
  const totalAmount = subtotal + deliveryFee + platformFee;

  // Redirect to orders after successful order creation (for COD)
  const handleOrderCreated = useCallback(() => {
    router.push("/orders");
  }, [router]);

  // ─── Razorpay handler ──────────────────────────────────────

  const handleRazorpayPayment = useCallback(
    async (orderId: string, amount: number) => {
      const scriptLoaded = await loadRazorpayScript();
      if (!scriptLoaded) {
        setPaymentError("Failed to load payment gateway. Please try again.");
        setIsProcessing(false);
        return;
      }

      const { razorpayOrderId, key } = await createRazorpayOrder.mutateAsync(
        orderId,
      );

      const options: RazorpayOptions = {
        key,
        amount: amount * 100,
        currency: "INR",
        name: "Foodo",
        description: `Order #${orderId.slice(-6).toUpperCase()}`,
        order_id: razorpayOrderId,
        // Payment captured by the gateway — the webhook (source of truth)
        // marks the order paid in the background. The success page polls
        // the read-only status endpoint until it flips; the client never
        // fulfills the payment itself.
        handler: () => {
          router.push(`/payment/success?orderId=${orderId}`);
        },
        prefill: {
          name: "Foodo User",
        },
        theme: {
          color: "#7c3aed",
        },
        modal: {
          ondismiss: () => {
            setPaymentError("Payment was cancelled. You can retry.");
            setIsProcessing(false);
          },
        },
      };

      const rzp = new window.Razorpay(options);
      rzp.on("payment.failed", (response) => {
        setPaymentError(
          response.error?.description || "Payment failed. Please try again.",
        );
        setIsProcessing(false);
      });
      rzp.open();
    },
    [createRazorpayOrder, router],
  );

  // ─── Geolocation ───────────────────────────────────────────

  const handleDetectLocation = async () => {
    setGeoLoading(true);
    setAddressError("");

    try {
      const { latitude, longitude } = await getCurrentPosition();
      const detectedAddress = await reverseGeocode(latitude, longitude);
      setNewAddress((prev) => ({
        ...prev,
        latitude,
        longitude,
        formatterAddress: detectedAddress,
      }));
      setGeoLoading(false);
    } catch (err) {
      setAddressError(
        err instanceof Error
          ? err.message
          : "Could not get your location. Please enter it manually.",
      );
      setGeoLoading(false);
    }
  };

  // ─── Place Order ───────────────────────────────────────────

  const handlePlaceOrder = async () => {
    if (!selectedAddressId || isProcessing) return;
    setPaymentError("");
    setIsProcessing(true);

    try {
      const orderResult = await createOrder.mutateAsync({
        addressId: selectedAddressId,
        // Send the real method — COD must not be billed a payment TTL.
        // Distance is computed server-side (Haversine between restaurant
        // and saved-address coordinates) — it sets the rider payout, so
        // the client is never trusted with it.
        paymentMethod,
      });

      const { orderId, amount } = orderResult;

      switch (paymentMethod) {
        case "razorpay":
          await handleRazorpayPayment(orderId, amount);
          break;

        case "stripe": {
          const { url } = await createStripeSession.mutateAsync(orderId);
          if (url) {
            window.location.href = url;
          }
          break;
        }

        case "cod":
          handleOrderCreated();
          break;
      }
    } catch (err: any) {
      setPaymentError(
        err?.message || "Failed to place order. Please try again.",
      );
      setIsProcessing(false);
    }
  };

  // ─── Auth / empty guards ───────────────────────────────────

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4">
        <p className="text-muted-foreground">Please log in to checkout</p>
        <Link
          href="/login"
          className="inline-flex h-10 items-center justify-center rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          Log In
        </Link>
      </div>
    );
  }

  if (cartLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (cartItems.length === 0) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4">
        <p className="text-muted-foreground">Your cart is empty</p>
        <Link
          href="/"
          className="inline-flex h-10 items-center justify-center rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          Browse Restaurants
        </Link>
      </div>
    );
  }

  // ─── Add address ───────────────────────────────────────────

  const handleAddAddress = async () => {
    setAddressError("");
    if (!newAddress.mobile || !newAddress.formatterAddress) {
      setAddressError("Mobile and address are required");
      return;
    }
    try {
      const result = await createAddress.mutateAsync({
        mobile: newAddress.mobile,
        formatterAddress: newAddress.formatterAddress,
        latitude: newAddress.latitude,
        longitude: newAddress.longitude,
      });
      setSelectedAddressId(result.data._id);
      setShowAddressForm(false);
      setNewAddress({
        mobile: "",
        formatterAddress: "",
        latitude: 0,
        longitude: 0,
      });
    } catch {
      setAddressError("Failed to add address");
    }
  };

  // ─── Render ────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="sticky top-0 z-10 border-b border-border/50 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex items-center gap-3 px-4 py-4 max-w-2xl mx-auto">
          <Link
            href="/"
            className="rounded-full p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <h1 className="text-lg font-semibold">Checkout</h1>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">
        {/* Order Summary */}
        <section className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
          <h2 className="font-medium text-sm text-muted-foreground uppercase tracking-wide">
            Order Summary
          </h2>
          {cartItems.map((item) => {
            const menuItem =
              typeof item.itemId === "object" ? item.itemId : null;
            return (
              <div
                key={item._id}
                className="flex items-center justify-between text-sm"
              >
                <span className="flex-1 truncate">
                  {menuItem?.name || "Item"} × {item.quantity}
                </span>
                <span className="font-medium ml-4">
                  ₹{(menuItem?.price ?? 0) * item.quantity}
                </span>
              </div>
            );
          })}
          <div className="border-t border-border/50 pt-3 space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Subtotal</span>
              <span>₹{subtotal}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Delivery Fee</span>
              <span>₹{deliveryFee}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Platform Fee</span>
              <span>₹{platformFee}</span>
            </div>
            <div className="flex justify-between font-semibold text-base border-t border-border/50 pt-2">
              <span>Total</span>
              <span className="text-primary">₹{totalAmount}</span>
            </div>
          </div>
        </section>

        {/* Delivery Address */}
        <section className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
          <h2 className="font-medium text-sm text-muted-foreground uppercase tracking-wide">
            Delivery Address
          </h2>
          {addressesLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading addresses...
            </div>
          ) : !addresses || addresses.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No addresses saved. Add one below.
            </p>
          ) : (
            <div className="space-y-2">
              {addresses.map((addr) => (
                <label
                  key={addr._id}
                  className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                    selectedAddressId === addr._id
                      ? "border-primary bg-primary/5"
                      : "border-border/50 hover:border-border"
                  }`}
                >
                  <input
                    type="radio"
                    name="address"
                    value={addr._id}
                    checked={selectedAddressId === addr._id}
                    onChange={() => setSelectedAddressId(addr._id)}
                    className="mt-0.5 accent-primary"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="text-sm truncate">
                        {addr.formatterAddress}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      📱 {addr.mobile}
                    </p>
                  </div>
                </label>
              ))}
            </div>
          )}

          {!showAddressForm ? (
            <button
              onClick={() => setShowAddressForm(true)}
              className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors"
            >
              <Plus className="h-4 w-4" />
              Add new address
            </button>
          ) : (
            <div className="space-y-3 rounded-lg border border-border/50 p-3">
              <input
                type="text"
                placeholder="Mobile number"
                value={newAddress.mobile}
                onChange={(e) =>
                  setNewAddress({ ...newAddress, mobile: e.target.value })
                }
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              />
              <input
                type="text"
                placeholder="Delivery address"
                value={newAddress.formatterAddress}
                onChange={(e) =>
                  setNewAddress({
                    ...newAddress,
                    formatterAddress: e.target.value,
                  })
                }
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              />

              {/* Location row */}
              <div className="flex items-center gap-2">
                <button
                  onClick={handleDetectLocation}
                  disabled={geoLoading}
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-50"
                >
                  {geoLoading ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Navigation className="h-3 w-3" />
                  )}
                  {geoLoading
                    ? "Detecting address..."
                    : newAddress.latitude !== 0
                      ? "Address detected ✓"
                      : "Detect my location"}
                </button>
                {newAddress.latitude !== 0 && (
                  <span className="text-[11px] text-muted-foreground truncate">
                    {newAddress.latitude.toFixed(4)},{" "}
                    {newAddress.longitude.toFixed(4)}
                  </span>
                )}
              </div>

              {addressError && (
                <p className="text-xs text-destructive">{addressError}</p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setShowAddressForm(false);
                    setAddressError("");
                  }}
                  className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAddAddress}
                  disabled={createAddress.isPending}
                  className="px-4 py-1.5 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  {createAddress.isPending ? "Saving..." : "Save Address"}
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Payment Method */}
        <section className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
          <h2 className="font-medium text-sm text-muted-foreground uppercase tracking-wide">
            Payment Method
          </h2>
          <div className="space-y-2">
            {/* Razorpay */}
            <label
              className={`flex items-center gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                paymentMethod === "razorpay"
                  ? "border-primary bg-primary/5"
                  : "border-border/50 hover:border-border"
              }`}
            >
              <input
                type="radio"
                name="payment"
                value="razorpay"
                checked={paymentMethod === "razorpay"}
                onChange={() => setPaymentMethod("razorpay")}
                className="accent-primary"
              />
              <CreditCard className="h-4 w-4 text-muted-foreground" />
              <div className="flex-1">
                <span className="text-sm font-medium">Razorpay</span>
                <span className="text-xs text-muted-foreground ml-2">
                  UPI / Cards / Wallets
                </span>
              </div>
              <ShieldCheck className="h-4 w-4 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
            </label>

            {/* Stripe */}
            <label
              className={`flex items-center gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                paymentMethod === "stripe"
                  ? "border-primary bg-primary/5"
                  : "border-border/50 hover:border-border"
              }`}
            >
              <input
                type="radio"
                name="payment"
                value="stripe"
                checked={paymentMethod === "stripe"}
                onChange={() => setPaymentMethod("stripe")}
                className="accent-primary"
              />
              <CreditCard className="h-4 w-4 text-muted-foreground" />
              <div className="flex-1">
                <span className="text-sm font-medium">Stripe</span>
                <span className="text-xs text-muted-foreground ml-2">
                  International Cards
                </span>
              </div>
              <ShieldCheck className="h-4 w-4 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
            </label>

            {/* Cash on Delivery */}
            <label
              className={`flex items-center gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                paymentMethod === "cod"
                  ? "border-primary bg-primary/5"
                  : "border-border/50 hover:border-border"
              }`}
            >
              <input
                type="radio"
                name="payment"
                value="cod"
                checked={paymentMethod === "cod"}
                onChange={() => setPaymentMethod("cod")}
                className="accent-primary"
              />
              <Banknote className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Cash on Delivery</span>
            </label>
          </div>
        </section>

        {/* Payment Error */}
        {paymentError && (
          <div className="rounded-xl border border-destructive/50 bg-destructive/5 p-4">
            <p className="text-sm text-destructive">{paymentError}</p>
          </div>
        )}

        {/* Place Order */}
        <button
          onClick={handlePlaceOrder}
          disabled={!selectedAddressId || isProcessing}
          className="w-full inline-flex items-center justify-center rounded-xl bg-primary px-5 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
        >
          {isProcessing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Processing...
            </>
          ) : paymentMethod === "cod" ? (
            `Place Order — ₹${totalAmount}`
          ) : (
            `Pay ₹${totalAmount} with ${paymentMethod === "razorpay" ? "Razorpay" : "Stripe"}`
          )}
        </button>
      </div>
    </div>
  );
}
