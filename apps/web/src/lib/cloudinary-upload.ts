// ============================================================
// Foodo — Cloudinary Direct Upload (client-side)
// ============================================================
// Two-step, zero-backend-bytes upload:
//   1. Fetch signed params from the owning service's /upload-signature
//      endpoint (auth via session cookie, same as every API call).
//   2. POST the File/Blob straight to Cloudinary — image bytes never
//      transit any Foodo backend service.
//
// The signature is valid only for the server-fixed folder/params, and
// the API secret never leaves the backend.

export interface CloudinaryUploadParams {
  signature: string;
  timestamp: number;
  apiKey: string;
  cloudName: string;
  folder: string;
}

const CLOUDINARY_UPLOAD_URL = (cloudName: string) =>
  `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;

/**
 * Upload a file directly to Cloudinary using signed params from a
 * Foodo service. Returns the asset's secure URL (store this on the
 * menu item / restaurant / rider record).
 */
export async function uploadToCloudinary(
  file: File | Blob,
  params: CloudinaryUploadParams,
): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  form.append("api_key", params.apiKey);
  form.append("timestamp", String(params.timestamp));
  form.append("folder", params.folder);
  form.append("signature", params.signature);

  const res = await fetch(CLOUDINARY_UPLOAD_URL(params.cloudName), {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Image upload failed (${res.status}): ${detail.slice(0, 200)}`,
    );
  }

  const result = (await res.json()) as { secure_url?: string };
  if (!result.secure_url) {
    throw new Error("Image upload returned no URL");
  }
  return result.secure_url;
}
