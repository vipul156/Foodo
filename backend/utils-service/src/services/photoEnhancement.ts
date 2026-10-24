import {
  createCloudinaryUploadSignature,
  resolveCloudinaryCredentials,
  resolveUploadFolder,
} from "@foodo/backend-common/cloudinary";

// ─── AI dish-photo enhancement pipeline ───────────────────────
// Foodo runs ZERO image code and ZERO GPUs: the "AI" is Cloudinary's
// on-the-fly transformation engine, driven entirely by URLs. This
// module is the URL math + the signed-upload payload for that
// pipeline.
//
//   capture → sign → browser uploads straight to Cloudinary →
//   preview (before/after/thumbnail URL math) → seller approves →
//   menu item stores the enhanced URL
//
// SECURITY CONTRACT:
//   - The studio-surface table is FIXED. Surface names are matched
//     against it, never interpolated from user input, so no prompt
//     text can be injected into the transformation chain.
//   - publicId is validated against a strict character class before it
//     is spliced into a URL (".." traversal, query strings and
//     path escapes are rejected).
//   - The API secret never leaves the server: only the signed
//     parameters (signature/timestamp/apiKey/cloudName/folder) and
//     the public cloud URL reach the browser.

// ─── Studio surfaces (fixed table — never free text) ──────────
export const SURFACE_STYLES = [
  "marble",
  "slate",
  "wood",
  "concrete",
  "stainless",
] as const;

export type SurfaceStyle = (typeof SURFACE_STYLES)[number];

export const DEFAULT_SURFACE: SurfaceStyle = "marble";

// Cloudinary's generative background replacement takes the surface as
// a prompt. Our surface names are already [a-z0-9_]-safe, but the
// validation below is what guarantees it: a caller can never smuggle
// a transformation string in through the "surface" parameter.
const SURFACE_PATTERN = /^[a-z0-9_]{1,32}$/;

/** publicIds are Cloudinary paths: segments of [A-Za-z0-9_-] joined by "/". */
const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;

const MAX_PUBLIC_ID_LENGTH = 200;

// Reads either CLOUDINARY_CLOUD_NAME or the CLOUDINARY_URL shorthand, so
// the delivery URLs and the signer can never disagree about the cloud.
const cloudName = (): string => resolveCloudinaryCredentials().cloudName;

export const isSurfaceStyle = (value: unknown): value is SurfaceStyle =>
  typeof value === "string" &&
  (SURFACE_STYLES as readonly string[]).includes(value);

/** Reject anything that is not a plain Cloudinary asset path. */
export const assertPublicId = (publicId: string): string => {
  const trimmed = publicId.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_PUBLIC_ID_LENGTH ||
    !PUBLIC_ID_PATTERN.test(trimmed) ||
    trimmed.includes("..")
  ) {
    throw new Error("Invalid Cloudinary public id");
  }
  return trimmed;
};

const deliveryUrl = (publicId: string, transformation: string): string =>
  `https://res.cloudinary.com/${cloudName()}/image/upload/${transformation}/${publicId}`;

// ─── Signed direct upload ─────────────────────────────────────
// The seller signs ONCE (server-side, no network hop), then the
// browser POSTs the file bytes straight to Cloudinary. Foodo's
// servers never touch the image.
export interface DirectUploadSignature {
  apiKey: string;
  cloudName: string;
  timestamp: number;
  signature: string;
  folder: string;
  uploadUrl: string;
}

// `kind` is the part AFTER the stack's namespace (CLOUDINARY_FOLDER), e.g.
// "dishes/<sellerId>" → "foodo/dishes/<sellerId>". Keeping the root in env
// is what lets an environment move its assets without a code change.
export const createDirectUploadSignature = (
  kind: string,
): DirectUploadSignature => {
  if (!/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/.test(kind.trim())) {
    throw new Error("Upload folder must be a plain Cloudinary path");
  }
  const folder = resolveUploadFolder(kind);
  const signature = createCloudinaryUploadSignature({ folder });
  return {
    apiKey: signature.apiKey,
    cloudName: signature.cloudName,
    timestamp: signature.timestamp,
    signature: signature.signature,
    folder: signature.folder,
    uploadUrl: `https://api.cloudinary.com/v1_1/${signature.cloudName}/image/upload`,
  };
};

// ─── Transformation chains ────────────────────────────────────
// A. e_improve               — colour/exposure/white-balance fix
// B. e_gen_background_replace — studio surface behind the dish
// C. c_fill,w_1200,h_900,g_auto — content-aware framing
// D. f_auto,q_auto           — WebP/AVIF + compression
//
// Stage order matters: improve BEFORE the cut-out (cleaner matting
// on a de-tinted photo), framing after the cut-out, format last.
export const buildEnhancedUrl = (
  publicId: string,
  surface: SurfaceStyle = DEFAULT_SURFACE,
): string => {
  const id = assertPublicId(publicId);
  const safeSurface = isSurfaceStyle(surface) ? surface : DEFAULT_SURFACE;
  if (!SURFACE_PATTERN.test(safeSurface)) {
    throw new Error("Invalid surface style");
  }
  return deliveryUrl(
    id,
    [
      "e_improve",
      `e_gen_background_replace:prompt_${safeSurface}`,
      "c_fill,w_1200,h_900,g_auto",
      "f_auto,q_auto",
    ].join("/"),
  );
};

// The "before" chain is deliberately RAW (no AI edits) so the seller
// judges the true delta on the slider.
export const buildBeforeUrl = (publicId: string): string =>
  deliveryUrl(assertPublicId(publicId), "c_limit,w_1200/f_auto,q_auto");

// Thumbnail chain skips the expensive generative background
// replacement — 64px menu grids do not need it.
export const buildThumbnailUrl = (publicId: string): string =>
  deliveryUrl(assertPublicId(publicId), "e_improve/c_fill,160/f_auto,q_auto");

// ─── Unsigned upload preset (idempotent bootstrap) ────────────
// The widget flow may use an unsigned preset instead of a signed
// payload. Cloudinary has no "create if absent" call, so we look the
// preset up first and only create it when it is missing.
const PRESET_NAME = "foodo_dish_unsigned";

const cloudinaryAdmin = async (
  path: string,
  init: { method: string; body?: string; headers?: Record<string, string> },
): Promise<{ status: number; body: string }> => {
  const { apiKey, apiSecret, cloudName: name } = resolveCloudinaryCredentials();
  if (!apiKey || !apiSecret) {
    throw new Error("Cloudinary credentials are not configured");
  }
  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${name}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    },
  );
  const body = await response.text().catch(() => "");
  return { status: response.status, body };
};

export const ensureUploadPreset = async (): Promise<string> => {
  const list = await cloudinaryAdmin("/upload_presets", { method: "GET" });
  if (list.status === 200) {
    try {
      const parsed = JSON.parse(list.body) as { presets?: { name?: string }[] };
      const exists = (parsed.presets ?? []).some(
        (p) => p.name === PRESET_NAME,
      );
      if (exists) return PRESET_NAME;
    } catch {
      // fall through to the create attempt
    }
  }

  const created = await cloudinaryAdmin("/upload_presets", {
    method: "POST",
    body: JSON.stringify({
      name: PRESET_NAME,
      unsigned: true,
      folder: resolveUploadFolder("dishes"),
      allowed_formats: ["jpg", "jpeg", "png", "webp"],
      max_file_size: 10 * 1024 * 1024,
      transformation:
        "e_improve/c_fill,w_1200,h_900,g_auto/f_auto,q_auto",
    }),
  });

  if (created.status >= 200 && created.status < 300) {
    return PRESET_NAME;
  }

  // A concurrent deploy may have created it a second earlier — the
  // preset existing is success, not an error.
  if (created.body.includes("already exists")) {
    return PRESET_NAME;
  }

  throw new Error(
    `Cloudinary preset bootstrap failed (${created.status}): ${created.body.slice(0, 200)}`,
  );
};

// ─── Stored-URL validation (domain owner side) ────────────────
// The restaurant service stores the ENHANCED URL. It must be a
// Cloudinary delivery URL — a foreign image host must never reach
// the customer-facing menu.
export const CLOUDINARY_DELIVERY_PATTERN =
  /^https:\/\/res\.cloudinary\.com\/[A-Za-z0-9_-]+\/image\/upload\/(?:[A-Za-z0-9_:,.-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9]+)?$/;

export const isValidCloudinaryDeliveryUrl = (url: string): boolean =>
  url.length <= 600 && CLOUDINARY_DELIVERY_PATTERN.test(url);
