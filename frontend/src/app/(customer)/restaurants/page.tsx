// ============================================================
// Foodo — All Restaurants Page (Location-Aware)
// ============================================================

"use client";

import Link from "next/link";
import { GlassCard } from "@/components/shared/glass-card";
import { useUIStore } from "@/store/ui-store";
import { useGetNearbyRestaurants } from "@/features/restaurants/api";
import type { IRestaurant } from "@/types";
import {
  MapPin,
  UtensilsCrossed,
  ArrowLeft,
  Loader2,
  Store,
  AlertCircle,
} from "lucide-react";

export default function RestaurantsPage() {
  const { userLocation } = useUIStore();

  const { data: restaurants, isLoading, error } = useGetNearbyRestaurants(
    userLocation?.longitude,
    userLocation?.latitude,
  );

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <Link
            href="/"
            className="flex h-10 w-10 items-center justify-center rounded-xl border border-border hover:bg-accent transition-all"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <h1 className="text-2xl font-bold">
              {userLocation ? "Nearby Restaurants" : "All Restaurants"}
            </h1>
            {userLocation && (
              <p className="text-sm text-muted-foreground mt-1">
                Near {userLocation.address?.slice(0, 40)}
              </p>
            )}
          </div>
        </div>
        <Link
          href="/locations"
          className="inline-flex h-10 items-center justify-center rounded-xl border border-border px-4 text-sm font-medium hover:bg-accent transition-all gap-2"
        >
          <MapPin className="h-4 w-4" />
          {userLocation ? "Change Location" : "Set Location"}
        </Link>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex items-center justify-center py-32">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center py-32 text-center">
          <AlertCircle className="h-12 w-12 text-destructive mb-4" />
          <h3 className="text-lg font-semibold mb-2">Something went wrong</h3>
          <p className="text-muted-foreground max-w-sm">
            Couldn&apos;t load restaurants. Please try again later.
          </p>
        </div>
      ) : restaurants && restaurants.length > 0 ? (
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {restaurants.map((restaurant) => (
            <RestaurantCard key={restaurant._id} restaurant={restaurant} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-32 text-center">
          <Store className="h-16 w-16 text-muted-foreground/30 mb-6" />
          <h3 className="text-xl font-semibold mb-2">No restaurants found</h3>
          <p className="text-muted-foreground max-w-md mb-6">
            There are no restaurants available{userLocation ? " near your location" : " yet"}. 
            {userLocation
              ? " Try setting a different location."
              : " Check back later or register your restaurant!"}
          </p>
          {!userLocation && (
            <Link
              href="/locations"
              className="inline-flex h-10 items-center justify-center rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground hover:brightness-110 transition-all gap-2"
            >
              <MapPin className="h-4 w-4" />
              Set Your Location
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Restaurant Card ─────────────────────────────────────────

function RestaurantCard({ restaurant }: { restaurant: IRestaurant }) {
  return (
    <Link href={`/restaurants/${restaurant._id}`}>
      <GlassCard hover className="overflow-hidden p-0 cursor-pointer group h-full">
        <div className="aspect-[16/9] bg-primary/10 flex items-center justify-center relative overflow-hidden">
          {restaurant.image ? (
            <img
              src={restaurant.image}
              alt={restaurant.name}
              className="h-full w-full object-cover group-hover:scale-105 transition-transform duration-500"
            />
          ) : (
            <UtensilsCrossed className="h-12 w-12 text-primary/40" />
          )}
          {restaurant.isOpen && (
            <span className="absolute top-3 right-3 rounded-full bg-emerald-700 px-2.5 py-0.5 text-[10px] font-semibold text-white">
              Open
            </span>
          )}
        </div>
        <div className="p-5">
          <div className="flex items-start justify-between mb-2">
            <h3 className="font-semibold group-hover:text-primary transition-colors">
              {restaurant.name}
            </h3>
          </div>
          {restaurant.description && (
            <p className="text-sm text-muted-foreground line-clamp-2 mb-3">
              {restaurant.description}
            </p>
          )}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="rounded-full bg-muted px-2 py-0.5 inline-flex items-center gap-1">
              <MapPin className="h-3 w-3" />
              {restaurant.autoLocation?.formattedAddress?.slice(0, 25) || "Location set"}
            </span>
            {restaurant.phone && (
              <span className="rounded-full bg-muted px-2 py-0.5">
                📞 {restaurant.phone}
              </span>
            )}
          </div>
        </div>
      </GlassCard>
    </Link>
  );
}
