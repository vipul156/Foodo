// ============================================================
// Foodo — Set Location Page
// ============================================================

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { GlassCard } from "@/components/shared/glass-card";
import { useUIStore } from "@/store/ui-store";
import {
  getCurrentPosition,
  reverseGeocode,
} from "@/lib/geolocation";
import {
  MapPin,
  ArrowLeft,
  Navigation,
  Search,
  Check,
  Loader2,
} from "lucide-react";

export default function LocationsPage() {
  const router = useRouter();
  const { userLocation, setUserLocation } = useUIStore();
  const [address, setAddress] = useState(userLocation?.address || "");
  const [isLocating, setIsLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);

  // One tap: detect coordinates → reverse-geocode the street address →
  // save it. The user never has to type anything when permission is granted.
  const handleGetCurrentLocation = async () => {
    setIsLocating(true);
    setLocationError(null);

    try {
      const { latitude, longitude } = await getCurrentPosition();
      const detectedAddress = await reverseGeocode(latitude, longitude);

      setUserLocation({ latitude, longitude, address: detectedAddress });
      setAddress(detectedAddress);
      setIsLocating(false);
      router.push("/");
    } catch (err) {
      setLocationError(
        err instanceof Error ? err.message : "Could not detect your location.",
      );
      setIsLocating(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <Link
          href="/"
          className="flex h-10 w-10 items-center justify-center rounded-xl border border-border hover:bg-accent transition-all"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold">Set Your Location</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Find restaurants near you
          </p>
        </div>
      </div>

      <div className="space-y-6">
        {/* Current Location Button */}
        <GlassCard className="p-6">
          <div className="flex flex-col items-center text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 mb-4">
              <Navigation className="h-8 w-8 text-primary" />
            </span>
            <h3 className="text-lg font-semibold mb-2">Use Current Location</h3>
            <p className="text-sm text-muted-foreground mb-6 max-w-sm">
              Allow location access and we&apos;ll fill in your address
              automatically — no typing needed.
            </p>
            <button
              onClick={handleGetCurrentLocation}
              disabled={isLocating}
              className="inline-flex h-12 items-center justify-center rounded-xl bg-primary px-6 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/25 hover:shadow-xl hover:brightness-110 transition-all duration-200 active:scale-[0.97] gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLocating ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Detecting your address...
                </>
              ) : (
                <>
                  <Navigation className="h-4 w-4" />
                  Detect My Location
                </>
              )}
            </button>
            {locationError && (
              <p className="mt-4 text-sm text-destructive">{locationError}</p>
            )}
          </div>
        </GlassCard>

        {/* Manual Address Entry */}
        <GlassCard className="p-6">
          <div className="flex items-center gap-3 mb-4">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
              <Search className="h-5 w-5 text-primary" />
            </span>
            <div>
              <h3 className="font-semibold">Or Enter an Address</h3>
              <p className="text-xs text-muted-foreground">
                Type your delivery address
              </p>
            </div>
          </div>
          <div className="space-y-3">
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Enter your address..."
              className="w-full rounded-xl border border-border bg-background px-4 py-2.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              onClick={() => {
                if (address.trim()) {
                  // Save with a default location (will use geo lookup in production)
                  setUserLocation({
                    latitude: userLocation?.latitude || 28.6139,
                    longitude: userLocation?.longitude || 77.2090,
                    address: address.trim(),
                  });
                }
              }}
              disabled={!address.trim()}
              className="w-full inline-flex h-10 items-center justify-center rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground hover:brightness-110 transition-all gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <MapPin className="h-4 w-4" />
              Save Address
            </button>
          </div>
        </GlassCard>

        {/* Saved Location Display */}
        {userLocation && (
          <GlassCard className="p-5 border-green-500/30 bg-green-500/5">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-green-500/20">
                <Check className="h-5 w-5 text-green-600" />
              </span>
              <div className="flex-1 min-w-0">
                <h4 className="font-semibold text-sm">Current Location</h4>
                <p className="text-sm text-muted-foreground truncate mt-0.5">
                  {userLocation.address}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {userLocation.latitude.toFixed(4)}, {userLocation.longitude.toFixed(4)}
                </p>
              </div>
              <button
                onClick={() => router.push("/")}
                className="inline-flex h-9 items-center justify-center rounded-xl bg-primary px-4 text-xs font-medium text-primary-foreground hover:brightness-110 transition-all shrink-0"
              >
                Browse
              </button>
            </div>
          </GlassCard>
        )}

        {/* Skip Link */}
        <div className="text-center">
          <Link
            href="/restaurants"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Skip — browse all restaurants
          </Link>
        </div>
      </div>
    </div>
  );
}
