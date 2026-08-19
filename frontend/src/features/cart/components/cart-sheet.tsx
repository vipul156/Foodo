// ============================================================
// Foodo — Cart Sheet (Slide-over Panel)
// ============================================================

"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { X, ShoppingCart, Trash2, Plus, Minus, ArrowRight } from "lucide-react";
import { useGetCart, useClearCart, useIncrementQuantity, useDecrementQuantity, useRemoveItem } from "@/features/restaurants/api";
import { useAuthStore } from "@/store/auth-store";
import type { ICartItem } from "@/types";
import Link from "next/link";

interface CartSheetProps {
  open: boolean;
  onClose: () => void;
}

/** Extract the string _id from a populated or unpopulated itemId field */
function getItemId(itemId: string | { _id: string }): string {
  return typeof itemId === "object" ? itemId._id : itemId;
}

export function CartSheet({ open, onClose }: CartSheetProps) {
  const router = useRouter();
  const { isAuthenticated } = useAuthStore();
  const { data: cartData, isLoading } = useGetCart();
  const clearCart = useClearCart();
  const incrementQuantity = useIncrementQuantity();
  const decrementQuantity = useDecrementQuantity();
  const removeItem = useRemoveItem();
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  // Lock body scroll when open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  // Focus trap — focus the panel when it opens
  useEffect(() => {
    if (open && panelRef.current) {
      panelRef.current.focus();
    }
  }, [open]);

  if (!open) return null;

  const cartItems = cartData?.cart || [];
  const cartLength = cartData?.cartLength || 0;
  const subtotal = cartData?.subtotal || 0;

  const handleIncrement = (itemId: string | { _id: string }) => {
    incrementQuantity.mutate(getItemId(itemId));
  };

  const handleDecrement = (itemId: string | { _id: string }) => {
    decrementQuantity.mutate(getItemId(itemId));
  };

  const handleRemove = (itemId: string | { _id: string }) => {
    removeItem.mutate(getItemId(itemId));
  };

  const handleCheckout = () => {
    onClose();
    router.push("/checkout");
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm transition-opacity duration-300"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Shopping cart"
        tabIndex={-1}
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-border bg-background shadow-2xl animate-in slide-in-from-right duration-300"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/50 px-4 py-4">
          <div className="flex items-center gap-2">
            <ShoppingCart className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-semibold">Your Cart</h2>
            {cartLength > 0 && (
              <span className="inline-flex items-center justify-center h-5 min-w-5 rounded-full bg-primary px-1.5 text-[11px] font-medium text-primary-foreground">
                {cartLength}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            aria-label="Close cart"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {!isAuthenticated ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <ShoppingCart className="h-12 w-12 text-muted-foreground/40 mb-4" />
              <p className="text-muted-foreground mb-4">
                Log in to view your cart
              </p>
              <Link
                href="/login"
                onClick={onClose}
                className="inline-flex h-10 items-center justify-center rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
              >
                Log In
              </Link>
            </div>
          ) : isLoading ? (
            <div className="flex flex-col items-center justify-center h-full gap-3">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <p className="text-sm text-muted-foreground">Loading cart...</p>
            </div>
          ) : cartItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <ShoppingCart className="h-12 w-12 text-muted-foreground/40 mb-4" />
              <p className="font-medium">Your cart is empty</p>
              <p className="text-sm text-muted-foreground mt-1 mb-6">
                Add items from a restaurant to get started
              </p>
              <Link
                href="/"
                onClick={onClose}
                className="inline-flex h-10 items-center justify-center rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors gap-1.5"
              >
                Browse Restaurants
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              {cartItems.map((item: ICartItem, idx: number) => {
                const menuItem =
                  typeof item.itemId === "object" ? item.itemId : null;

                return (
                  <div
                    key={item._id || idx}
                    className="flex items-center gap-3 rounded-xl border border-border/50 bg-card p-3"
                  >
                    {/* Item image placeholder */}
                    <div className="h-14 w-14 shrink-0 rounded-lg bg-primary/10 flex items-center justify-center text-lg">
                      🍽️
                    </div>

                    {/* Item details */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">
                        {menuItem?.name || "Item"}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        ₹{menuItem?.price ?? 0}
                      </p>
                      <div className="flex items-center gap-2 mt-1.5">
                        <button
                          onClick={() => handleDecrement(item.itemId)}
                          disabled={decrementQuantity.isPending}
                          className="rounded-full border border-border p-0.5 text-muted-foreground hover:bg-accent transition-colors disabled:opacity-50"
                          aria-label="Decrease quantity"
                        >
                          <Minus className="h-3 w-3" />
                        </button>
                        <span className="text-xs font-medium min-w-[1.5ch] text-center">
                          {item.quantity || 1}
                        </span>
                        <button
                          onClick={() => handleIncrement(item.itemId)}
                          disabled={incrementQuantity.isPending}
                          className="rounded-full border border-border p-0.5 text-muted-foreground hover:bg-accent transition-colors disabled:opacity-50"
                          aria-label="Increase quantity"
                        >
                          <Plus className="h-3 w-3" />
                        </button>
                      </div>
                    </div>

                    {/* Price & remove */}
                    <div className="flex flex-col items-end gap-1">
                      <p className="text-sm font-semibold">
                        ₹{(menuItem?.price ?? 0) * (item.quantity || 1)}
                      </p>
                      <button
                        onClick={() => handleRemove(item.itemId)}
                        disabled={removeItem.isPending}
                        className="text-xs text-destructive hover:text-destructive/80 transition-colors inline-flex items-center gap-0.5 disabled:opacity-50"
                        aria-label="Remove item"
                      >
                        <Trash2 className="h-3 w-3" />
                        Remove
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer — only show if authenticated and has items */}
        {isAuthenticated && cartItems.length > 0 && (
          <div className="border-t border-border/50 px-4 py-4 space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Subtotal</span>
              <span className="font-semibold">₹{subtotal}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Delivery Fee</span>
              <span className="font-semibold">₹{subtotal < 250 ? 49 : 0}</span>
            </div>
            <div className="flex items-center justify-between text-sm border-t border-border/50 pt-3">
              <span className="font-medium">Total</span>
              <span className="text-lg font-bold text-primary">
                ₹{subtotal + (subtotal < 250 ? 49 : 0)}
              </span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => clearCart.mutate()}
                disabled={clearCart.isPending}
                className="inline-flex h-10 items-center justify-center rounded-xl border border-border px-4 text-sm font-medium text-muted-foreground hover:bg-accent transition-colors gap-1.5 disabled:opacity-50"
              >
                <Trash2 className="h-4 w-4" />
                Clear
              </button>
              <button
                onClick={handleCheckout}
                className="flex-1 inline-flex h-10 items-center justify-center rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors gap-1.5 shadow-sm"
              >
                Checkout
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
