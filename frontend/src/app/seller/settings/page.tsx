// ============================================================
// Foodo — Seller Settings Page (/seller/settings)
// ============================================================

"use client";

import { useState, useEffect } from "react";
import { GlassCard } from "@/components/shared/glass-card";
import { RoleGuard } from "@/components/shared/role-guard";
import {
  useGetMyRestaurant,
  useCreateRestaurant,
  useUpdateRestaurantDetails,
  useUpdateRestaurantStatus,
} from "@/features/restaurants/api";
import { Loader2, Save, Power, AlertCircle, Store, Navigation, ImageUp, X } from "lucide-react";

export default function SellerSettingsPage() {
  const {
    data: restaurant,
    isLoading,
    refetch,
  } = useGetMyRestaurant();

  const createRestaurant = useCreateRestaurant();
  const updateDetails = useUpdateRestaurantDetails();
  const toggleStatus = useUpdateRestaurantStatus();

  // Form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [phone, setPhone] = useState("");
  const [latitude, setLatitude] = useState("");
  const [longitude, setLongitude] = useState("");
  const [formattedAddress, setFormattedAddress] = useState("");
  const [imageFile, setImageFile] = useState<string | null>(null); // base64 data URI
  const [imagePreview, setImagePreview] = useState<string | null>(null);

  // Handle image selection
  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      setImageFile(result);
      setImagePreview(result);
    };
    reader.readAsDataURL(file);
  };

  const clearImage = () => {
    setImageFile(null);
    setImagePreview(null);
  };

  // Fill form when restaurant data loads
  useEffect(() => {
    if (restaurant) {
      setName(restaurant.name || "");
      setDescription(restaurant.description || "");
      setPhone(String(restaurant.phone || ""));
      setLatitude(String(restaurant.autoLocation?.coordinates?.[1] || ""));
      setLongitude(String(restaurant.autoLocation?.coordinates?.[0] || ""));
      setFormattedAddress(restaurant.autoLocation?.formattedAddress || "");
      if (restaurant.image) setImagePreview(restaurant.image);
    }
  }, [restaurant]);

  const handleSave = async () => {
    try {
      const payload: any = {
        name: name || undefined,
        description: description || undefined,
        phone: phone ? Number(phone) : undefined,
      };

      if (imageFile) payload.file = imageFile;

      if (!restaurant) {
        payload.latitude = latitude;
        payload.longitude = longitude;
        payload.formattedAddress = formattedAddress;
        await createRestaurant.mutateAsync(payload);
      } else {
        await updateDetails.mutateAsync(payload);
      }
      refetch();
    } catch {
      // Error is displayed automatically by mutation state
    }
  };

  const handleToggleStatus = async () => {
    if (restaurant) {
      await toggleStatus.mutateAsync(!restaurant.isOpen);
      refetch();
    }
  };

  const isPending =
    updateDetails.isPending || createRestaurant.isPending || toggleStatus.isPending;

  return (
    <RoleGuard allowedRoles={["seller"]}>
      <div className="max-w-2xl mx-auto space-y-8">
        <div>
          <h2 className="text-xl font-bold">Restaurant Settings</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your restaurant profile and availability
          </p>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : (
          <>
            {/* Restaurant Status Card */}
            <GlassCard className="p-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <span
                    className={`flex h-12 w-12 items-center justify-center rounded-xl ${
                      restaurant?.isOpen
                        ? "bg-emerald-50 dark:bg-emerald-950"
                        : "bg-red-50 dark:bg-red-950"
                    }`}
                  >
                    <Power
                      className={`h-6 w-6 ${
                        restaurant?.isOpen
                          ? "text-emerald-600"
                          : "text-red-600"
                      }`}
                    />
                  </span>
                  <div>
                    <h3 className="font-semibold">
                      {restaurant?.isOpen ? "Restaurant is Open" : "Restaurant is Closed"}
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      {restaurant?.isOpen
                        ? "You are accepting new orders"
                        : "Customers cannot place orders right now"}
                    </p>
                  </div>
                </div>
                <button
                  onClick={handleToggleStatus}
                  disabled={isPending || !restaurant}
                  className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-all disabled:opacity-50 ${
                    restaurant?.isOpen
                      ? "bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-950 dark:text-red-400"
                      : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-400"
                  }`}
                >
                  {toggleStatus.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : null}
                  {restaurant?.isOpen ? "Close" : "Open"} Restaurant
                </button>
              </div>
              {restaurant && (
                <div className="mt-4 flex items-center gap-4 text-xs text-muted-foreground">
                  <span>
                    Verified:{" "}
                    {restaurant.isVerified ? (
                      <span className="text-emerald-600 font-medium">Yes</span>
                    ) : (
                      <span className="text-amber-600 font-medium">Pending</span>
                    )}
                  </span>
                  {restaurant.autoLocation?.formattedAddress && (
                    <span>📍 {restaurant.autoLocation.formattedAddress}</span>
                  )}
                </div>
              )}
            </GlassCard>

            {/* Restaurant Details Form */}
            <GlassCard className="p-6">
              <h3 className="text-lg font-semibold mb-4">
                {restaurant ? "Restaurant Details" : "Register Your Restaurant"}
              </h3>
              {!restaurant && (
                <p className="text-sm text-muted-foreground mb-6">
                  Fill in the details below to register your restaurant on Foodo.
                </p>
              )}

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-1">
                    Restaurant Name *
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Enter restaurant name"
                    className="w-full rounded-xl border border-border bg-background px-4 py-2.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">
                    Description
                  </label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Describe your restaurant and cuisine..."
                    rows={3}
                    className="w-full rounded-xl border border-border bg-background px-4 py-2.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">
                    Phone Number
                  </label>
                  <input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="Enter phone number"
                    className="w-full rounded-xl border border-border bg-background px-4 py-2.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>

                {/* Image Upload */}
                <div>
                  <label className="block text-sm font-medium mb-1">
                    Restaurant Image
                  </label>
                  <div className="flex items-start gap-4">
                    {imagePreview ? (
                      <div className="relative w-24 h-24 rounded-xl overflow-hidden shrink-0">
                        <img
                          src={imagePreview}
                          alt="Preview"
                          className="h-full w-full object-cover"
                        />
                        <button
                          onClick={clearImage}
                          className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex w-24 h-24 items-center justify-center rounded-xl border-2 border-dashed border-border bg-muted/30 shrink-0">
                        <ImageUp className="h-6 w-6 text-muted-foreground/50" />
                      </div>
                    )}
                    <div className="flex-1 pt-1">
                      <label className="cursor-pointer inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-accent transition-all">
                        <ImageUp className="h-4 w-4" />
                        {imagePreview ? "Change Image" : "Upload Image"}
                        <input
                          type="file"
                          accept="image/*"
                          onChange={handleImageSelect}
                          className="hidden"
                        />
                      </label>
                      <p className="text-xs text-muted-foreground mt-2">
                        PNG, JPG or WEBP. Max 5MB.
                      </p>
                    </div>
                  </div>
                </div>

                {!restaurant && (
                  <>
                    {/* Auto-detect Location */}
                    <div className="rounded-xl border border-border/50 bg-muted/30 p-4">
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <h4 className="text-sm font-semibold">Restaurant Location</h4>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Auto-detect your location or enter coordinates manually
                          </p>
                        </div>
                        <GeoDetectButton
                          onDetect={(lat, lng) => {
                            setLatitude(String(lat));
                            setLongitude(String(lng));
                          }}
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-xs font-medium mb-1">
                            Latitude *
                          </label>
                          <input
                            type="text"
                            value={latitude}
                            onChange={(e) => setLatitude(e.target.value)}
                            placeholder="28.6139"
                            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium mb-1">
                            Longitude *
                          </label>
                          <input
                            type="text"
                            value={longitude}
                            onChange={(e) => setLongitude(e.target.value)}
                            placeholder="77.2090"
                            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                          />
                        </div>
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">
                        Address
                      </label>
                      <input
                        type="text"
                        value={formattedAddress}
                        onChange={(e) => setFormattedAddress(e.target.value)}
                        placeholder="Full address"
                        className="w-full rounded-xl border border-border bg-background px-4 py-2.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                    </div>
                  </>
                )}

                <button
                  onClick={handleSave}
                  disabled={isPending || !name.trim() || (!restaurant && (!latitude || !longitude))}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:brightness-110 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  {restaurant ? "Save Changes" : "Register Restaurant"}
                </button>
              </div>
            </GlassCard>

            {/* Error Display */}
            {(updateDetails.isError || createRestaurant.isError) && (
              <div className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950 px-4 py-3">
                <AlertCircle className="h-5 w-5 text-red-500 shrink-0" />
                <p className="text-sm text-red-700 dark:text-red-400">
                  {updateDetails.error?.message ||
                    createRestaurant.error?.message ||
                    "Something went wrong. Please try again."}
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </RoleGuard>
  );
}

// ─── Geo Detect Button ───────────────────────────────────────

function GeoDetectButton({
  onDetect,
}: {
  onDetect: (latitude: number, longitude: number) => void;
}) {
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDetect = () => {
    if (!navigator.geolocation) {
      setError("Geolocation is not supported by your browser.");
      return;
    }

    setDetecting(true);
    setError(null);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        onDetect(position.coords.latitude, position.coords.longitude);
        setDetecting(false);
      },
      (err) => {
        switch (err.code) {
          case err.PERMISSION_DENIED:
            setError("Location permission denied. Please enable it in your browser settings.");
            break;
          case err.POSITION_UNAVAILABLE:
            setError("Location unavailable. Please enter coordinates manually.");
            break;
          case err.TIMEOUT:
            setError("Location request timed out.");
            break;
          default:
            setError("Failed to detect location.");
        }
        setDetecting(false);
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={handleDetect}
        disabled={detecting}
        className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:brightness-110 transition-all disabled:opacity-50"
      >
        {detecting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Navigation className="h-3.5 w-3.5" />
        )}
        {detecting ? "Detecting..." : "Detect"}
      </button>
      {error && <p className="text-[10px] text-red-500 text-right max-w-[200px]">{error}</p>}
    </div>
  );
}
