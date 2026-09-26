// ============================================================
// Foodo — Rider Profile Page (/rider/profile)
// ============================================================

"use client";

import { useState, useRef } from "react";
import { useAuthStore } from "@/store/auth-store";
import {
  useGetRiderProfile,
  useCreateRider,
} from "@/features/rider/api";
import { RoleGuard } from "@/components/shared/role-guard";
import { GlassCard } from "@/components/shared/glass-card";
import { Button } from "@/components/ui/button";
import {
  User,
  Mail,
  Shield,
  Phone,
  BadgeCheck,
  IdCard,
  MapPin,
  Upload,
  Loader2,
  Camera,
  FileText,
} from "lucide-react";

export default function RiderProfilePage() {
  const { user } = useAuthStore();
  const { data: rider, isLoading, refetch } = useGetRiderProfile();

  return (
    <RoleGuard allowedRoles={["rider"]}>
      <div className="space-y-6 pb-6">
        <div>
          <h2 className="text-xl font-bold">Profile</h2>
          <p className="text-sm text-muted-foreground">
            Your account and rider information
          </p>
        </div>

        <GlassCard>
          <div className="flex flex-col items-center py-6 text-center">
            <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-primary/10 text-3xl font-bold text-primary">
              {user?.name?.charAt(0)?.toUpperCase() || (
                <User className="h-10 w-10" />
              )}
            </div>
            <h3 className="text-xl font-semibold">{user?.name || "Rider"}</h3>
            <p className="text-sm text-muted-foreground">{user?.email}</p>
            {rider?.isVerified && (
              <span className="mt-2 inline-flex items-center gap-1 rounded-full bg-emerald-50 px-3 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400">
                <BadgeCheck className="h-3 w-3" />
                Verified Rider
              </span>
            )}
          </div>

          <hr className="border-border/50" />

          {isLoading ? (
            <div className="flex items-center justify-center p-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : rider ? (
            <RiderDetailsSection user={user} rider={rider} />
          ) : (
            <RiderRegistrationForm onSuccess={refetch} />
          )}
        </GlassCard>
      </div>
    </RoleGuard>
  );
}

// ─── Rider Details (profile exists) ──────────────────────────

function RiderDetailsSection({
  user,
  rider,
}: {
  user: { email?: string; role?: string } | null;
  rider: {
    phoneNumber?: string;
    isVerified?: boolean;
    isAvailable?: boolean;
    addharNumber?: string;
    drivingLicenseNumber?: string;
  };
}) {
  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center gap-3 rounded-lg bg-muted/50 p-3">
        <Mail className="h-4 w-4 text-muted-foreground" />
        <div className="text-sm">
          <p className="font-medium">Email</p>
          <p className="text-muted-foreground">{user?.email}</p>
        </div>
      </div>
      <div className="flex items-center gap-3 rounded-lg bg-muted/50 p-3">
        <Phone className="h-4 w-4 text-muted-foreground" />
        <div className="text-sm">
          <p className="font-medium">Phone</p>
          <p className="text-muted-foreground">
            {rider.phoneNumber || "Not provided"}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3 rounded-lg bg-muted/50 p-3">
        <Shield className="h-4 w-4 text-muted-foreground" />
        <div className="text-sm">
          <p className="font-medium">Role</p>
          <p className="text-muted-foreground capitalize">
            {user?.role || "Rider"}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3 rounded-lg bg-muted/50 p-3">
        <IdCard className="h-4 w-4 text-muted-foreground" />
        <div className="text-sm">
          <p className="font-medium">Verification</p>
          <p className="text-muted-foreground">
            {rider.isVerified ? "Verified" : "Pending verification"}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3 rounded-lg bg-muted/50 p-3">
        <MapPin className="h-4 w-4 text-muted-foreground" />
        <div className="text-sm">
          <p className="font-medium">Status</p>
          <p className="text-muted-foreground">
            {rider.isAvailable ? "Available" : "Offline"}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Rider Registration Form (no profile yet) ────────────────

function RiderRegistrationForm({
  onSuccess,
}: {
  onSuccess: () => void;
}) {
  const createRider = useCreateRider();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    phoneNumber: "",
    addharNumber: "",
    drivingLicenseNumber: "",
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => setPreview(ev.target?.result as string);
      reader.readAsDataURL(file);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const file = fileInputRef.current?.files?.[0];
    if (!file) return;

    // Get coordinates from browser geolocation
    const getCoords = (): Promise<{ lat: number; lng: number }> =>
      new Promise((resolve) => {
        if (!navigator.geolocation) {
          resolve({ lat: 0, lng: 0 });
          return;
        }
        navigator.geolocation.getCurrentPosition(
          (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
          () => resolve({ lat: 0, lng: 0 }),
          { timeout: 5000 },
        );
      });

    const { lat, lng } = await getCoords();

    const fd = new FormData();
    fd.append("file", file);
    fd.append("phoneNumber", formData.phoneNumber);
    fd.append("addharNumber", formData.addharNumber);
    fd.append("drivingLicenseNumber", formData.drivingLicenseNumber);
    fd.append("latitude", String(lat));
    fd.append("longitude", String(lng));

    createRider.mutate(fd, {
      onSuccess: () => onSuccess(),
    });
  };

  const updateField = (field: string, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  return (
    <div className="p-4">
      <div className="mb-4 text-center">
        <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
          <FileText className="h-7 w-7 text-primary" />
        </div>
        <h3 className="text-base font-semibold">Complete Your Rider Profile</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Fill in the details below to start delivering with Foodo
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Profile Picture Upload */}
        <div>
          <label className="block text-sm font-medium mb-1.5">
            Profile Picture
          </label>
          <div
            onClick={() => fileInputRef.current?.click()}
            className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-border p-6 hover:border-primary/50 transition-colors"
          >
            {preview ? (
              <img
                src={preview}
                alt="Preview"
                className="h-20 w-20 rounded-full object-cover"
              />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
                <Camera className="h-6 w-6 text-muted-foreground" />
              </div>
            )}
            <span className="text-xs text-muted-foreground">
              {preview ? "Tap to change" : "Upload a profile photo"}
            </span>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>

        {/* Phone Number */}
        <div>
          <label className="block text-sm font-medium mb-1.5">
            Phone Number
          </label>
          <input
            type="tel"
            placeholder="+91 98765 43210"
            value={formData.phoneNumber}
            onChange={(e) => updateField("phoneNumber", e.target.value)}
            className="w-full rounded-xl border border-border bg-background px-4 py-2.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            required
          />
        </div>

        {/* Aadhar Number */}
        <div>
          <label className="block text-sm font-medium mb-1.5">
            Aadhar Number
          </label>
          <input
            type="text"
            placeholder="1234 5678 9012"
            value={formData.addharNumber}
            onChange={(e) => updateField("addharNumber", e.target.value)}
            className="w-full rounded-xl border border-border bg-background px-4 py-2.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            required
          />
        </div>

        {/* Driving License Number */}
        <div>
          <label className="block text-sm font-medium mb-1.5">
            Driving License Number
          </label>
          <input
            type="text"
            placeholder="DL-1234567890"
            value={formData.drivingLicenseNumber}
            onChange={(e) => updateField("drivingLicenseNumber", e.target.value)}
            className="w-full rounded-xl border border-border bg-background px-4 py-2.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            required
          />
        </div>

        <Button
          type="submit"
          className="w-full h-11"
          disabled={createRider.isPending || !fileInputRef.current?.files?.[0]}
        >
          {createRider.isPending ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              Submitting...
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <Upload className="h-4 w-4" />
              Submit for Verification
            </span>
          )}
        </Button>

        {createRider.error && (
          <p className="text-center text-xs text-destructive">
            {(createRider.error as Error).message}
          </p>
        )}
      </form>
    </div>
  );
}
