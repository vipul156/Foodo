// ============================================================
// Foodo — Customer Home Page (Real Restaurant Data)
// ============================================================

"use client";

import Link from "next/link";
import { GlassCard } from "@/components/shared/glass-card";
import { useAuthStore } from "@/store/auth-store";
import { useUIStore } from "@/store/ui-store";
import { useGetNearbyRestaurants } from "@/features/restaurants/api";
import type { IRestaurant } from "@/types";
import {
  Search,
  MapPin,
  UtensilsCrossed,
  ShoppingBag,
  LogIn,
  UserPlus,
  LayoutDashboard,
  ArrowRight,
  Loader2,
  Store,
  AlertCircle,
} from "lucide-react";

export default function CustomerHomePage() {
  const { user, isAuthenticated } = useAuthStore();
  const { userLocation } = useUIStore();

  // Single query — uses nearby endpoint with user location if available.
  // Backend handles undefined coords by returning all restaurants.
  const { data: restaurants, isLoading, error } = useGetNearbyRestaurants(
    userLocation?.longitude,
    userLocation?.latitude,
  );

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
      {/* Hero Section — Auth-Aware */}
      <section className="relative mb-16 overflow-hidden rounded-3xl bg-gradient-to-br from-primary/10 via-primary/5 to-blue-500/5 p-8 sm:p-12 lg:p-16">
        <div className="relative z-10 max-w-2xl">
          {isAuthenticated ? (
            <>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary mb-4">
                Welcome back, {user?.name?.split(" ")[0] || "there"}!
              </span>
              <h1 className="text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
                Hungry again?{" "}
                <span className="bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
                  Order now
                </span>
              </h1>
              <p className="mt-4 text-lg text-muted-foreground">
                Your favorite restaurants are just a tap away. Order
                delivery or pick up your go-to meals.
              </p>
              <div className="mt-8 flex flex-col sm:flex-row gap-3">
                <Link
                  href="/restaurants"
                  className="inline-flex h-12 items-center justify-center rounded-xl bg-primary px-6 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/30 hover:brightness-110 transition-all duration-200 active:scale-[0.97] gap-2"
                >
                  <Search className="h-4 w-4" />
                  Browse Restaurants
                </Link>
                <Link
                  href="/locations"
                  className="inline-flex h-12 items-center justify-center rounded-xl border border-border bg-transparent px-6 text-sm font-medium text-foreground hover:bg-accent transition-all duration-200 active:scale-[0.97] gap-2"
                >
                  <MapPin className="h-4 w-4" />
                  Set Location
                </Link>
              </div>
              <div className="mt-6 flex items-center gap-4 text-sm">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  Browse restaurants below to place your first order
                </span>
              </div>
            </>
          ) : (
            <>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary mb-4">
                India&apos;s favorite food delivery
              </span>
              <h1 className="text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
                Delicious food,{" "}
                <span className="bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
                  delivered
                </span>
              </h1>
              <p className="mt-4 text-lg text-muted-foreground">
                Browse restaurants near you and order your favorites.
                Fresh food, fast delivery — right to your doorstep.
              </p>
              <div className="mt-8 flex flex-col sm:flex-row gap-3">
                <Link
                  href="/register"
                  className="inline-flex h-12 items-center justify-center rounded-xl bg-primary px-6 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/30 hover:brightness-110 transition-all duration-200 active:scale-[0.97] gap-2"
                >
                  <UserPlus className="h-4 w-4" />
                  Get Started — It&apos;s Free
                </Link>
                <Link
                  href="/login"
                  className="inline-flex h-12 items-center justify-center rounded-xl border border-border bg-transparent px-6 text-sm font-medium text-foreground hover:bg-accent transition-all duration-200 active:scale-[0.97] gap-2"
                >
                  <LogIn className="h-4 w-4" />
                  Log In
                </Link>
              </div>
              {/* Role-based CTAs for unauthenticated users */}
              <div className="mt-6 flex flex-wrap items-center gap-3 text-sm">
                <span className="text-muted-foreground">
                  Are you a restaurant owner?
                </span>
                <Link
                  href="/register?role=seller"
                  className="font-medium text-primary hover:underline"
                >
                  List your restaurant
                </Link>
                <span className="text-muted-foreground">&middot;</span>
                <Link
                  href="/register?role=rider"
                  className="font-medium text-primary hover:underline"
                >
                  Become a rider
                </Link>
              </div>
            </>
          )}
        </div>

        {/* Decorative background elements */}
        <div className="absolute -right-20 -top-20 h-64 w-64 rounded-full bg-primary/10 blur-3xl" />
        <div className="absolute -bottom-10 -left-10 h-40 w-40 rounded-full bg-blue-500/10 blur-3xl" />
      </section>

      {/* Role-based Dashboard Prompt (for sellers/riders/admin) */}
      {isAuthenticated && user?.role && user.role !== "customer" && (
        <section className="mb-16">
          <GlassCard className="overflow-hidden border-primary/20 bg-gradient-to-br from-primary/5 to-transparent">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-6">
              <div className="flex items-start gap-4">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-2xl">
                  {user.role === "seller" ? "🍽️" : user.role === "rider" ? "🛵" : "⚙️"}
                </span>
                <div>
                  <h3 className="text-lg font-semibold">
                    {user.role === "seller"
                      ? "Restaurant Owner Dashboard"
                      : user.role === "rider"
                        ? "Rider Dashboard"
                        : "Admin Panel"}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {user.role === "seller"
                      ? "Manage your menu, view orders, and track performance."
                      : user.role === "rider"
                        ? "Accept deliveries, track earnings, and manage your profile."
                        : "Oversee platform operations and verify users."}
                  </p>
                </div>
              </div>
              <Link
                href={
                  user.role === "seller"
                    ? "/seller"
                    : user.role === "rider"
                      ? "/rider"
                      : "/admin"
                }
                className="inline-flex h-9 items-center justify-center rounded-xl bg-primary px-5 text-xs font-medium text-primary-foreground shadow-lg shadow-primary/25 hover:shadow-xl hover:brightness-110 transition-all duration-200 active:scale-[0.97] gap-1.5 shrink-0"
              >
                <LayoutDashboard className="h-4 w-4" />
                Go to Dashboard
              </Link>
            </div>
          </GlassCard>
        </section>
      )}

      {/* How It Works (for guests) */}
      {!isAuthenticated ? (
        <section className="mb-16">
          <h2 className="text-2xl font-bold text-center mb-10">
            How It Works
          </h2>
          <div className="grid gap-8 sm:grid-cols-3">
            <HowItWorksCard
              step="01"
              title="Browse"
              desc="Explore restaurants and menus near you"
              icon={Search}
            />
            <HowItWorksCard
              step="02"
              title="Order"
              desc="Customize your meal and place your order"
              icon={ShoppingBag}
            />
            <HowItWorksCard
              step="03"
              title="Enjoy"
              desc="Track delivery in real-time and enjoy!"
              icon={UtensilsCrossed}
            />
          </div>
        </section>
      ) : null}

      {/* Restaurants Section — Real Data */}
      <section className="mb-16">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold">
            {userLocation ? "Nearby Restaurants" : "All Restaurants"}
          </h2>
          {userLocation && (
            <span className="text-xs text-muted-foreground">
              {userLocation.address?.slice(0, 30)}
            </span>
          )}
          {restaurants && restaurants.length > 3 && (
            <Link
              href="/restaurants"
              className="text-sm font-medium text-primary hover:underline inline-flex items-center gap-1"
            >
              View all <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          )}
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <AlertCircle className="h-10 w-10 text-destructive mb-4" />
            <p className="text-muted-foreground">
              Couldn&apos;t load restaurants. Please try again later.
            </p>
          </div>
        ) : restaurants && restaurants.length > 0 ? (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {restaurants.slice(0, 6).map((restaurant) => (
              <RestaurantCard key={restaurant._id} restaurant={restaurant} />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <Store className="h-12 w-12 text-muted-foreground/50 mb-4" />
            <h3 className="text-lg font-semibold mb-2">No restaurants yet</h3>
            <p className="text-muted-foreground max-w-sm">
              There are no restaurants available in your area yet. Check back
              later or browse all restaurants.
            </p>
            <Link
              href="/restaurants"
              className="mt-4 inline-flex h-10 items-center justify-center rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground hover:brightness-110 transition-all"
            >
              Browse All
            </Link>
          </div>
        )}
      </section>

      {/* Call to Action (for guests) */}
      {!isAuthenticated && (
        <section className="mb-16 rounded-3xl bg-gradient-to-br from-primary to-primary/80 p-8 sm:p-12 text-center text-primary-foreground">
          <h2 className="text-3xl font-bold">Ready to order?</h2>
          <p className="mt-3 text-lg text-primary-foreground/80 max-w-md mx-auto">
            Join thousands of happy customers. Sign up today and get your first
            delivery free!
          </p>
          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              href="/register"
              className="inline-flex h-12 items-center justify-center rounded-xl bg-primary-foreground px-6 text-sm font-semibold text-primary shadow-xl hover:brightness-95 transition-all duration-200 active:scale-[0.97] gap-2 ring-1 ring-primary/20"
            >
              <UserPlus className="h-4 w-4" />
              Sign Up Now
            </Link>
            <Link
              href="/login"
              className="inline-flex h-12 items-center justify-center rounded-xl border-2 border-primary-foreground/20 px-6 text-sm font-medium text-primary-foreground hover:bg-primary-foreground/10 transition-all duration-200 active:scale-[0.97] gap-2"
            >
              <LogIn className="h-4 w-4" />
              Log In
            </Link>
          </div>
        </section>
      )}

      {/* Role Switch Prompt (for guests) */}
      {!isAuthenticated && (
        <section className="mb-8">
          <h2 className="text-xl font-bold text-center mb-6">
            Join as a partner
          </h2>
          <div className="grid gap-6 sm:grid-cols-2">
            <GlassCard hover className="cursor-pointer p-6">
              <Link href="/register?role=seller" className="flex items-start gap-4">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-2xl">
                  🏪
                </span>
                <div>
                  <h3 className="font-semibold">Restaurant Owner</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    List your restaurant on Foodo and reach thousands of hungry
                    customers.
                  </p>
                  <span className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-primary">
                    Sign up as seller <ArrowRight className="h-3.5 w-3.5" />
                  </span>
                </div>
              </Link>
            </GlassCard>
            <GlassCard hover className="cursor-pointer p-6">
              <Link href="/register?role=rider" className="flex items-start gap-4">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-2xl">
                  🛵
                </span>
                <div>
                  <h3 className="font-semibold">Delivery Rider</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Earn on your own schedule. Deliver food and make money as a
                    Foodo rider.
                  </p>
                  <span className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-primary">
                    Sign up as rider <ArrowRight className="h-3.5 w-3.5" />
                  </span>
                </div>
              </Link>
            </GlassCard>
          </div>
        </section>
      )}
    </div>
  );
}

// ─── How It Works Card ──────────────────────────────────────

function HowItWorksCard({
  step,
  title,
  desc,
  icon: Icon,
}: {
  step: string;
  title: string;
  desc: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="text-center">
      <span className="inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 mb-4">
        <Icon className="h-7 w-7 text-primary" />
      </span>
      <span className="block text-xs font-bold text-primary/60 mb-1 tracking-widest uppercase">
        Step {step}
      </span>
      <h3 className="text-lg font-semibold mb-2">{title}</h3>
      <p className="text-sm text-muted-foreground">{desc}</p>
    </div>
  );
}

// ─── Restaurant Card — Real Data ─────────────────────────────

function RestaurantCard({ restaurant }: { restaurant: IRestaurant }) {
  return (
    <Link href={`/restaurants/${restaurant._id}`}>
      <GlassCard hover className="overflow-hidden p-0 cursor-pointer group">
        <div className="aspect-[16/9] bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center relative overflow-hidden">
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
            <span className="absolute top-3 right-3 rounded-full bg-green-500/90 px-2.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur-sm">
              Open
            </span>
          )}
        </div>
        <div className="p-5">
          <div className="flex items-start justify-between mb-2">
            <h3 className="font-semibold group-hover:text-primary transition-colors">
              {restaurant.name}
            </h3>
            {/* Rating hidden — no rating field in Restaurant model yet */}
          </div>
          {restaurant.description && (
            <p className="text-sm text-muted-foreground line-clamp-2">
              {restaurant.description}
            </p>
          )}
          <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="rounded-full bg-muted px-2 py-0.5 inline-flex items-center gap-1">
              <MapPin className="h-3 w-3" />
              {restaurant.autoLocation?.formattedAddress?.slice(0, 20) || "Nearby"}
            </span>
          </div>
        </div>
      </GlassCard>
    </Link>
  );
}
