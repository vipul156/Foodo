// ============================================================
// Foodo — Restaurant Detail Page (Real Menu Data)
// ============================================================

"use client";

import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { GlassCard } from "@/components/shared/glass-card";
import { useState } from "react";
import { useGetMenuItems, useGetRestaurantById, useAddToCart } from "@/features/restaurants/api";
import { useToast } from "@/components/ui/toaster";
import type { IMenuItem } from "@/types";
import {
  ArrowLeft,
  MapPin,
  Loader2,
  AlertCircle,
  IndianRupee,
  UtensilsCrossed,
  Check,
  X,
  Plus,
} from "lucide-react";

export default function RestaurantDetailPage() {
  const params = useParams();
  const router = useRouter();
  const restaurantId = params.id as string;
  const { addToast } = useToast();
  const [addingItemId, setAddingItemId] = useState<string | null>(null);

  // Fetch restaurant details and menu items
  const { data: restaurant, isLoading: loadingRestaurant } =
    useGetRestaurantById(restaurantId);
  const { data: menuItems, isLoading: loadingMenu } =
    useGetMenuItems(restaurantId);
  const addToCart = useAddToCart();

  const handleAddToCart = (itemId: string) => {
    setAddingItemId(itemId);
    addToCart.mutate(
      { restaurantId, itemId },
      {
        onSuccess: () => {
          setAddingItemId(null);
          addToast({ message: "Added to cart!", variant: "success" });
        },
        onError: (error: any) => {
          setAddingItemId(null);
          const status = error?.status || error?.response?.status;
          const message =
            status === 401
              ? "Please log in to add items to cart"
              : "Failed to add to cart. Please try again.";
          addToast({ message, variant: "error" });
        },
      },
    );
  };

  const isLoading = loadingRestaurant || loadingMenu;

  if (isLoading) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-16">
        <div className="flex items-center justify-center py-32">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </div>
    );
  }

  if (!restaurant) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-16">
        <div className="flex flex-col items-center justify-center py-32 text-center">
          <AlertCircle className="h-12 w-12 text-destructive mb-4" />
          <h3 className="text-lg font-semibold mb-2">Restaurant not found</h3>
          <p className="text-muted-foreground mb-6">
            The restaurant you&apos;re looking for doesn&apos;t exist or has been removed.
          </p>
          <Link
            href="/restaurants"
            className="inline-flex h-10 items-center justify-center rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground hover:brightness-110 transition-all"
          >
            Browse Restaurants
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-8">
      {/* Back + Header */}
      <div className="flex items-center gap-4 mb-6">
        <button
          onClick={() => router.back()}
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-border hover:bg-accent transition-all"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div>
          <h1 className="text-2xl font-bold">{restaurant.name}</h1>
          {restaurant.autoLocation?.formattedAddress && (
            <p className="text-sm text-muted-foreground flex items-center gap-1 mt-0.5">
              <MapPin className="h-3.5 w-3.5" />
              {restaurant.autoLocation.formattedAddress}
            </p>
          )}
        </div>
      </div>

      {/* Restaurant Hero */}
      <div className="relative mb-8 overflow-hidden rounded-2xl bg-primary/10 aspect-[21/9]">
        {restaurant.image ? (
          <img
            src={restaurant.image}
            alt={restaurant.name}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="h-full w-full flex items-center justify-center">
            <UtensilsCrossed className="h-16 w-16 text-primary/30" />
          </div>
        )}
        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-6">
          <div className="flex items-center gap-3">
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                restaurant.isOpen ? "bg-emerald-700 text-white" : "bg-foreground/80 text-background"
              }`}
            >
              {restaurant.isOpen ? "Open" : "Closed"}
            </span>
            {restaurant.phone && (
              <span className="rounded-full bg-white/20 backdrop-blur-sm px-3 py-1 text-xs text-white">
                📞 {restaurant.phone}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Description */}
      {restaurant.description && (
        <GlassCard className="mb-8 p-5">
          <p className="text-sm text-muted-foreground leading-relaxed">
            {restaurant.description}
          </p>
        </GlassCard>
      )}

      {/* Menu Section */}
      <section>
        <h2 className="text-xl font-bold mb-6 flex items-center gap-2">
          <UtensilsCrossed className="h-5 w-5 text-primary" />
          Menu
        </h2>

        {loadingMenu ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : menuItems && menuItems.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {menuItems.map((item: IMenuItem) => (
              <MenuItemCard
                key={item._id}
                item={item}
                restaurantId={restaurantId}
                onAddToCart={() => handleAddToCart(item._id)}
                isAdding={addingItemId === item._id}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <UtensilsCrossed className="h-12 w-12 text-muted-foreground/30 mb-4" />
            <h3 className="text-lg font-semibold mb-2">No menu items yet</h3>
            <p className="text-muted-foreground max-w-sm">
              This restaurant hasn&apos;t added any menu items yet. Check back later!
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

// ─── Menu Item Card ──────────────────────────────────────────

function MenuItemCard({
  item,
  restaurantId,
  onAddToCart,
  isAdding,
}: {
  item: IMenuItem;
  restaurantId: string;
  onAddToCart: () => void;
  isAdding: boolean;
}) {
  return (
    <GlassCard
      className={`overflow-hidden p-0 ${
        !item.isAvailable ? "opacity-50" : ""
      }`}
    >
      <div className="flex">
        {item.image && (
          <div className="w-24 shrink-0 overflow-hidden">
            <img
              src={item.image}
              alt={item.name}
              className="h-full w-full object-cover"
            />
          </div>
        )}
        <div className="flex-1 p-4">
          <div className="flex items-start justify-between mb-1">
            <h4 className="font-semibold text-sm">{item.name}</h4>
            <span className="flex items-center gap-0.5 text-sm font-semibold shrink-0 ml-2">
              <IndianRupee className="h-3 w-3" />
              {item.price}
            </span>
          </div>
          {item.description && (
            <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
              {item.description}
            </p>
          )}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {item.isAvailable ? (
                <span className="inline-flex items-center gap-1 text-[10px] text-emerald-700 dark:text-emerald-400 font-medium">
                  <Check className="h-3 w-3" /> Available
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground font-medium">
                  <X className="h-3 w-3" /> Unavailable
                </span>
              )}
              {item.category && (
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                  {item.category}
                </span>
              )}
            </div>
            <button
              onClick={onAddToCart}
              disabled={!item.isAvailable || isAdding}
              className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground hover:brightness-110 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            >
              {isAdding ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Plus className="h-3 w-3" />
              )}
              Add
            </button>
          </div>
        </div>
      </div>
    </GlassCard>
  );
}
