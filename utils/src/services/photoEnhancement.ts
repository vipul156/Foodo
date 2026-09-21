import crypto from "crypto";
import { v2 } from "cloudinary";

// ─── Cloudinary configuration (fail-fast on missing creds) ───
// The photo pipeline is URL-driven: no image bytes flow through this
// service after the upload contract. Credentials come from the same
// env vars the platform already uses for Cloudinary.
const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const API_KEY = process.env.CLOUDINARY_API_KEY;
const API_SECRET = process.env.CLOUDINARY_API_SECRET;

if (!CLOUD_NAME || !API_KEY || !API_SECRET) {
  throw new Error(
    "Cloudinary credentials missing (CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET)"
  );
}

v2.config({ cloud_name: CLOUD_NAME, api_key: API_KEY, api_secret: API_SECRET });

// ─── Studio surface styles (fixed table — never free text) ───
export type SurfaceStyle = "marble" | "slate" | "wood" | "concrete" | "stainless";

// Prompt text for Cloudinary's generative background replacement.
// Constraint: lowercase alphanumerics + underscores ONLY (Cloudinary
// URL-safe, no encoding tricks, nothing injectable).
const SURFACE_PROMPTS: Record<SurfaceStyle, string> = {
  marble: "polished_white_marble_countertop_soft_studio_light",
  slate: "dark_slate_restaurant_table_mood_light",
  wood: "warm_rustic_wooden_board_natural_light",
  concrete: "matte_grey_concrete_surface_soft_light",
  stainless: "brushed_stainless_steel_counter_bright_light",
};

export const SURFACE_STYLES: SurfaceStyle[] = [
  "marble",
  "slate",
  "wood",
  "concrete",
  "stainless",
];

function isSurfaceStyle(value: unknown): value is SurfaceStyle {
  return typeof value === "string" && SURFACE_STYLES.includes(value as SurfaceStyle);
}

// ─── Transformation chains (the four-stage AI enhancement) ───
// Applied by Cloudinary's engine at DELIVERY time — this service runs
// no image code and no GPU scripts. Stage order matters:
//   A. e_improve                 — auto color/exposure/white-balance fix
//   B. e_gen_background_replace  — studio surface behind the dish
//   C. c_fill,g_auto             — content-aware framing on the plate
//   D. f_auto,q_auto             — WebP/AVIF + perceptual compression
function bgReplace(surface: SurfaceStyle): string {
  return `e_gen_background_replace:prompt_${SURFACE_PROMPTS[surface]}`;
}

const ENHANCE_STAGES = (surface: SurfaceStyle): string[] => [
  "e_improve",
  bgReplace(surface),
  "c_fill,w_1200,h_900,g_auto",
  "f_auto,q_auto",
];

// Tiny-card variant: skips the expensive background replacement (not
// visible at 64px) — keeps menu grids cheap.
const THUMBNAIL_STAGES = ["e_improve", "c_fill,w_160,h_160,g_auto", "f_auto,q_auto"];

// The "before" side of the seller slider: the raw upload, lightly
// bounded — NO AI changes, so the seller judges the true delta.
const BEFORE_STAGES = ["c_limit,w_1200", "f_auto,q_auto"];

// ─── Validation + URL builders ───────────────────────────────
function validateStage(stage: string): string {
  // Defense-in-depth: stages are built from fixed tables server-side,
  // but validate anyway — a transformation component may only contain
  // Cloudinary's safe charset and must never carry separators that
  // could smuggle extra URL path segments or query params.
  if (!/^[A-Za-z0-9_:,.\-]+$/.test(stage)) {
    throw new Error("Invalid transformation stage");
  }
  return stage;
}

function validatePublicId(publicId: string): string {
  if (!/^[A-Za-z0-9_\-\/]{1,200}$/.test(publicId) || publicId.includes("..")) {
    throw new Error("Invalid public id");
  }
  return publicId;
}

function buildUrl(publicId: string, stages: string[]): string {
  const safeId = validatePublicId(publicId);
  const chain = stages.map(validateStage).join("/");
  return `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/${chain}/${safeId}`;
}

/** Studio-quality "after" URL — the four-stage AI enhancement chain. */
export function buildEnhancedUrl(publicId: string, surface: SurfaceStyle = "marble"): string {
  return buildUrl(publicId, ENHANCE_STAGES(surface));
}

/** Raw "before" URL for the seller's comparison slider. */
export function buildBeforeUrl(publicId: string): string {
  return buildUrl(publicId, BEFORE_STAGES);
}

/** Cheap optimized thumbnail (menu grids, cart lines). */
export function buildThumbnailUrl(publicId: string): string {
  return buildUrl(publicId, THUMBNAIL_STAGES);
}

// ─── Signed direct upload (browser → Cloudinary, no proxy) ──
// The frontend posts the FILE straight to Cloudinary using this
// signature; 5–10 MB phone photos never touch Foodo servers.
export interface DirectUploadSignature {
  apiKey: string;
  cloudName: string;
  timestamp: number;
  signature: string;
  folder: string;
  uploadUrl: string;
}

export function createDirectUploadSignature(folder: string): DirectUploadSignature {
  // Folder whitelist: everything uploads under the foodo/ namespace so
  // cleanup/audit stays bounded to our assets.
  if (!/^foodo\/[a-z0-9_\-\/]{1,80}$/.test(folder) || folder.includes("..")) {
    throw new Error("Invalid upload folder");
  }
  const timestamp = Math.floor(Date.now() / 1000);
  // Cloudinary requires signature params in ALPHABETICAL order,
  // concatenated exactly as they will be sent, with the API secret
  // appended (no trailing separator).
  const toSign = `folder=${folder}&timestamp=${timestamp}${API_SECRET}`;
  const signature = crypto.createHash("sha1").update(toSign).digest("hex");
  return {
    apiKey: API_KEY!,
    cloudName: CLOUD_NAME!,
    timestamp,
    signature,
    folder,
    uploadUrl: `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`,
  };
}

// ─── Preset bootstrap (idempotent) ───────────────────────────
// An unsigned preset keeps the widget flow simple but scoped: uploads
// land in one folder with format caps enforced by Cloudinary itself.
export async function ensureUploadPreset(): Promise<string> {
  const name = "foodo_dish_unsigned";
  try {
    await v2.api.create_upload_preset({
      name,
      unsigned: true,
      folder: "foodo/dishes",
      allowed_formats: "jpg,jpeg,png,webp",
    });
  } catch (err: unknown) {
    // "already exists" is the expected steady state — anything else is real.
    const message = err instanceof Error ? err.message : String(err);
    if (!/already exists/i.test(message)) {
      throw err;
    }
  }
  return name;
}

export { isSurfaceStyle };
