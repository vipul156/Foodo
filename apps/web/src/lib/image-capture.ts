// ============================================================
// Foodo — Camera Capture Helper (Visual Verification)
// ============================================================
// Phone cameras emit 3-8MB JPEGs; base64 inflates that ~33%, which
// blows past the 10MB service body caps. Every verification photo is
// downscaled + re-encoded in the browser before upload:
//   - max edge 1280px (plenty for item/doorstep recognition)
//   - JPEG q0.8 → typically 150-400KB base64
// This runs entirely client-side: faster uploads, lower AI-tier egress,
// and no service-side resize infrastructure needed.

const MAX_EDGE = 1280;
const JPEG_QUALITY = 0.8;

/**
 * Convert a user-selected/captured image file into a downscaled JPEG
 * data URI ready for the verification APIs. Throws on non-image input.
 */
export async function fileToVerifiedDataUri(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Please capture or select an image");
  }

  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable on this device");
    ctx.drawImage(bitmap, 0, 0, width, height);

    return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  } finally {
    bitmap.close();
  }
}

/** Sanity guard before upload — mirrors the service-side caps. */
export function isDataUriSizeOk(dataUri: string, maxChars = 14_000_000): boolean {
  return typeof dataUri === "string" && dataUri.length > 0 && dataUri.length <= maxChars;
}
