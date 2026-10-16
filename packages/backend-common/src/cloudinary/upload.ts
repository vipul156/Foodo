import { createCloudinaryUploadSignature } from "../cloudinary.js";

// ─── Server-side Cloudinary upload (legacy multipart fallback) ──
// The preferred flow is browser-direct upload via signed params (each
// service exposes an /upload-signature endpoint). This helper keeps the
// multipart fallback working without utils-service: it signs locally
// and POSTs the payload straight to Cloudinary's REST endpoint from
// the calling service. No internal HTTP hop.

export interface ServerUploadOptions {
  /** Data-URI or base64 string, or a raw Buffer */
  fileContent: string | Buffer;
  /** Fixed destination folder, e.g. "foodo/menu-items" */
  folder: string;
  tags?: string[];
}

const CLOUDINARY_UPLOAD_ENDPOINT = (cloudName: string) =>
  `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`;

export async function uploadToCloudinary({
  fileContent,
  folder,
  tags,
}: ServerUploadOptions): Promise<string> {
  const signature = createCloudinaryUploadSignature(
    // exactOptionalPropertyTypes: omit the key instead of passing undefined
    tags ? { folder, tags } : { folder },
  );

  const form = new FormData();
  form.append("file", fileContent);
  form.append("api_key", signature.apiKey);
  form.append("timestamp", String(signature.timestamp));
  form.append("folder", signature.folder);
  if (signature.tags) form.append("tags", signature.tags.join(","));
  form.append("signature", signature.signature);

  const response = await fetch(CLOUDINARY_UPLOAD_ENDPOINT(signature.cloudName), {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Cloudinary upload failed (${response.status}): ${detail.slice(0, 300)}`,
    );
  }

  const result = (await response.json()) as { secure_url?: string };
  if (!result.secure_url) {
    throw new Error("Cloudinary upload returned no secure_url");
  }

  return result.secure_url;
}
