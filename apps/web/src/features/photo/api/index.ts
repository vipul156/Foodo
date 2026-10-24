// ============================================================
// Foodo — Photo Enhancement Feature (Cloudinary AI pipeline)
// ============================================================
// Direct-to-Cloud upload flow:
//   1. POST /api/utils/photo/sign        → scoped upload signature
//   2. POST https://api.cloudinary.com…  → the FILE itself (never
//      touches Foodo servers)
//   3. POST /api/utils/photo/preview     → before/after/thumbnail URLs
//   4. Seller approves → menu item is created with the enhanced URL
//
// The enhancement itself is Cloudinary's URL transformation engine
// (e_improve → background replace → g_auto framing → f_auto,q_auto):
// no image code runs on Foodo servers at any point.

import { useMutation } from "@tanstack/react-query";
import { restaurantApi } from "@/lib/api-client";

// ─── Types ───────────────────────────────────────────────────

export interface SurfaceStyleOption {
  id: string;
  label: string;
  hint: string;
}

export const SURFACE_OPTIONS: SurfaceStyleOption[] = [
  { id: "marble", label: "Marble", hint: "Bright, premium — safest default" },
  { id: "slate", label: "Slate", hint: "Dark, moody — great for grills" },
  { id: "wood", label: "Wood", hint: "Warm, rustic — curries & breads" },
  { id: "concrete", label: "Concrete", hint: "Modern, minimal" },
  { id: "stainless", label: "Steel", hint: "Clean, commercial kitchen look" },
];

interface SignResponse {
  success: boolean;
  apiKey: string;
  cloudName: string;
  timestamp: number;
  signature: string;
  folder: string;
  uploadUrl: string;
}

export interface DirectUploadResult {
  publicId: string;
  /** Raw Cloudinary delivery URL (transformations NOT applied yet). */
  secureUrl: string;
}

export interface PhotoPreview {
  before: string;
  after: string;
  thumbnail: string;
  surface: string;
  styles: string[];
}

export interface ApprovedPhoto {
  /** The AI-enhanced URL to persist as the menu item's image. */
  enhancedUrl: string;
  publicId: string;
  surface: string;
}

// ─── Step 1: fetch a scoped signed-upload payload ────────────

async function getUploadSignature(): Promise<SignResponse> {
  return restaurantApi.post<SignResponse>("/utils/photo/sign");
}

// ─── Step 2: upload the file DIRECTLY to Cloudinary ──────────

async function uploadToCloudinary(
  file: File,
  sign: SignResponse
): Promise<DirectUploadResult> {
  const form = new FormData();
  form.append("file", file);
  form.append("api_key", sign.apiKey);
  form.append("timestamp", String(sign.timestamp));
  form.append("signature", sign.signature);
  form.append("folder", sign.folder);

  const response = await fetch(sign.uploadUrl, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error?.message || "Photo upload failed");
  }
  const data = (await response.json()) as { public_id: string; secure_url: string };
  return { publicId: data.public_id, secureUrl: data.secure_url };
}

// ─── Step 3: build the before/after preview URLs ─────────────

async function getPreview(
  publicId: string,
  surface: string
): Promise<PhotoPreview> {
  return restaurantApi.post<PhotoPreview>("/utils/photo/preview", {
    publicId,
    surface,
  });
}

// ─── Plain upload: sign → Cloudinary (no enhancement) ────────
// Used by flows that need a hosted image URL but not the dish-photo
// pipeline — e.g. the AI menu parser sending a menu photo for reading.

export async function uploadPhotoToCloudinary(
  file: File,
): Promise<DirectUploadResult> {
  const sign = await getUploadSignature();
  return uploadToCloudinary(file, sign);
}

// ─── Orchestrated hook: pick file → upload → preview ─────────

export interface UseEnhancePhotoOptions {
  onSuccess?: (result: { preview: PhotoPreview; upload: DirectUploadResult }) => void;
}

export function useEnhancePhoto(options: UseEnhancePhotoOptions = {}) {
  return useMutation({
    mutationFn: async ({
      file,
      surface = "marble",
    }: {
      file: File;
      surface?: string;
    }) => {
      const sign = await getUploadSignature();
      const upload = await uploadToCloudinary(file, sign);
      const preview = await getPreview(upload.publicId, surface);
      return { preview, upload };
    },
    onSuccess: options.onSuccess,
  });
}

// ─── Re-render preview when the seller switches surface style ──

export function useRestylePreview() {
  return useMutation({
    mutationFn: ({
      publicId,
      surface,
    }: {
      publicId: string;
      surface: string;
    }) => getPreview(publicId, surface),
  });
}

// ─── Helper: extract the bare publicId for later restyling ────
// The enhanced URL embeds transformation segments; the raw publicId is
// what services need for re-transforms. Direct-upload responses give us
// public_id — this helper recovers it from a stored URL when needed.

export function extractPublicIdFromUrl(url: string): string | null {
  const marker = "/image/upload/";
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  let tail = url.slice(idx + marker.length);
  // Strip transformation segments (they never contain a dot with an
  // image extension; the final segment carries the format).
  const segments = tail.split("/");
  while (segments.length > 1 && !/\.[a-z0-9]+$/i.test(segments[0])) {
    segments.shift();
  }
  tail = segments.join("/");
  // Strip the extension.
  return tail.replace(/\.[a-z0-9]+$/i, "") || null;
}
