# AI Systems Design — AI Food Photo Enhancement Pipeline

**Foodo Platform — Menu Visual Quality (Cloudinary-powered)**
Status: Implemented on branch `feature/visual-verification`
Services: `utils` (:3005, photo routes + hardened upload) · `restaurant`
(:3003, enhanced URL persistence) · Next.js frontend (direct upload +
before/after slider)

> Companion doc to `AI_SYSTEMS_DESIGN.md`, `AI_COMMERCE_DESIGN.md`, and
> `AI_DISPATCH_DESIGN.md`. This feature is deliberately NOT an AI
> microservice: the "AI processing" is Cloudinary's on-the-fly
> transformation engine, driven entirely by URLs. Foodo runs **zero image
> code and zero GPUs**.

---

## 1. Executive summary

Restaurant partners photograph dishes on phones in kitchen lighting. The
pipeline turns those raw photos into studio-quality menu imagery with a
four-stage AI transformation chain applied at CDN delivery time:

```
[ Restaurant Partner ]
       │  (1) "Add Dish Photo" — phone camera / file picker
       ▼
[ Foodo Frontend — Cloudinary DIRECT upload ]
       │  (2) signed payload: browser → Cloudinary, BYTES NEVER TOUCH FOODO
       ▼
[ Cloudinary Media Cloud ]
       │  (3) on-the-fly AI transformation engine (URL-driven)
       │     ├─ A. e_improve               — color/exposure/white-balance fix
       │     ├─ B. e_gen_background_replace — studio surface behind the dish
       │     ├─ C. c_fill,g_auto            — content-aware framing
       │     └─ D. f_auto,q_auto            — WebP/AVIF + compression
       ▼
[ Global CDN edge ]  (4) first hit transforms (~1–2 s), then cached
       ▼
[ Customer App & Admin Preview Slider ]  (5) millisecond loads
```

The seller approves via an interactive before/after slider before
anything reaches the customer-facing menu.

---

## 2. The four-stage transformation chain

| Stage | Transformation | Problem it solves |
|-------|----------------|-------------------|
| A | `e_improve` | Kitchen tube lights leave yellow/green casts; AI analyzes the histogram, fixes white balance, boosts contrast, restores natural sauce/garnish colors |
| B | `e_gen_background_replace:prompt_<surface>` | Counters show cutting boards, plastic bags, receipts; boundary-detection cuts out the plate and composites a studio surface |
| C | `c_fill,w_1200,h_900,g_auto` | Phone photos are off-center; CV finds the plate and frames it for any viewport |
| D | `f_auto,q_auto` | 5 MB originals crush mobile data; the CDN serves perceptually-compressed WebP/AVIF per browser |

**Stage order matters**: improve before background replacement (cleaner
matting on a de-tinted photo), framing after cut-out, format selection
last. Two secondary chains exist:

- **Thumbnail** (`e_improve → c_fill,160 → f_auto,q_auto`) — skips the
  expensive background replacement for 64 px menu grids.
- **Before** (`c_limit,w_1200 → f_auto,q_auto`) — NO AI edits, so the
  seller judges the true delta on the slider.

**Studio surfaces** are a fixed server-side table (never free text):
`marble` (default), `slate`, `wood`, `concrete`, `stainless`. Prompt text
is constrained to `[a-z0-9_]` — URL-safe and injection-proof. Switching
surface = a new URL = a new cached variant; the "Again" button re-rolls
the generative result by re-requesting.

---

## 3. Step-by-step flow

### Step 1 — Signed direct upload (bytes bypass Foodo)

1. Seller clicks **Add Dish Photo (AI-enhanced)** on `/seller/menu`.
2. Frontend calls `POST /api/utils/photo/sign` (session-cookie auth,
   30/min rate limit). Utils validates the seller's JWT from the SAME
   cookie-session identity plane as every other service and returns:

```json
{
  "apiKey": "…", "cloudName": "…",
  "timestamp": 1737500000, "signature": "<sha1>",
  "folder": "foodo/dishes/<sellerUserId>",
  "uploadUrl": "https://api.cloudinary.com/v1_1/<cloud>/image/upload"
}
```

3. The browser POSTs the **file itself** straight to `uploadUrl` with the
   signature. 5–10 MB photos never touch Foodo's Node servers — no
   memory spikes, no bandwidth cost, no upload-timeout risk.

Signature details: params are signed in **alphabetical order**
(`folder=…&timestamp=…` + API secret, SHA-1), the folder is whitelisted
to `foodo/<namespace>/…` and scoped per-seller, and the timestamp bounds
the signature's validity (replay window).

An **unsigned preset** (`foodo_dish_unsigned`, idempotently bootstrapped
via `POST /api/utils/photo/preset`, internal-key) is available for the
widget flow; format caps (`jpg,jpeg,png,webp`) are enforced by
Cloudinary itself.

### Step 2 — Enhancement at delivery time

Foodo stores only the Cloudinary **public id / delivery URL**. The
enhancement happens when the URL is first requested: Cloudinary's engine
runs the four-stage chain (~1–2 s on first hit) and caches the result at
the global CDN edge. Every subsequent customer load is milliseconds.
Changing a transformation (different surface, new chain) simply produces
a new cached variant — there is nothing to re-upload and nothing to
re-run server-side.

### Step 3 — Preview + approve (the seller's control gate)

`POST /api/utils/photo/preview` (session-auth) turns a publicId into:

```json
{ "before": "…", "after": "…", "thumbnail": "…", "surface": "marble", "styles": […] }
```

The seller sees the **BeforeAfterSlider** (draggable divider, keyboard
accessible), picks a studio surface, re-rolls if the generative result
isn't appetizing, and only then hits **Approve & Publish to Menu**.

### Step 4 — Persist & display

Approval sends `POST /api/menu-item/new` with JSON
`{ name, description, price, enhancedUrl }`. The restaurant service
**validates the URL shape** (`https://res.cloudinary.com/<cloud>/image/upload/…`,
≤600 chars) and stores it as the item's image. Customer and seller
surfaces render the CDN URL directly — pre-enhanced, pre-compressed,
edge-cached.

---

## 4. Key design decisions

| Decision | Rationale |
|----------|-----------|
| **Direct upload, signed** | Raw photos never consume Foodo memory/bandwidth; the signature keeps upload scopes tight (per-seller folder) without a proxy hop |
| **URL-driven AI, no image servers** | Cloudinary transforms + caches at the edge; Foodo has no GPU cost, no processing queue, no storage of derivatives |
| **Approve gate before publish** | Generative background replacement can misfire; the seller is the judge. Nothing reaches customers unapproved |
| **Fixed surface table, validated URLs** | Prompt text and stored URLs are constrained server-side (`[a-z0-9_]`, URL-shape regex) — no injection into the transformation chain or the menu |
| **Separate thumbnail chain** | Background replacement is the expensive stage; 64 px cards skip it — menu grids stay cheap |
| **"Before" chain is raw** | The slider's left side shows the untouched original (bounded width only) — honest comparison |
| **Legacy multipart fallback preserved** | `POST /menu-item/new` still accepts a file for old clients; the enhancedUrl path is strictly better but not breaking |
| **Upload endpoint hardened** | `/api/utils/upload` previously accepted unauthenticated base64 — an open upload proxy on a payments service. Now internal-key gated, image-MIME-allow-listed, size-capped, folder-namespaced |

---

## 5. API reference

### utils service (:3005)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/utils/photo/sign` | seller session (30/min) | Scoped signed-direct-upload payload |
| POST | `/api/utils/photo/preview` | seller session | before/after/thumbnail URLs for a publicId |
| GET | `/api/utils/photo/styles` | public | Surface-style catalog |
| POST | `/api/utils/photo/preset` | internal key | Idempotent unsigned-preset bootstrap |
| POST | `/api/utils/upload` | **internal key (NEW)** | Legacy passthrough — now fail-closed, MIME-allow-listed, size-capped, `foodo/`-namespaced |

### restaurant service (:3003)

| Method | Path | Change |
|--------|------|--------|
| POST | `/api/menu-item/new` | Accepts `enhancedUrl` (validated Cloudinary URL) as an alternative to the multipart file |

### Frontend

| Piece | Purpose |
|-------|---------|
| `features/photo/api` | `useEnhancePhoto` (sign → upload → preview), `useRestylePreview`, surface options |
| `features/photo/components/before-after-slider` | Draggable, keyboard-accessible comparison slider |
| `features/photo/components/dish-photo-dialog` | Capture → enhance → style → approve flow |
| `app/seller/menu` | "Add Dish Photo (AI-enhanced)" + approved-photo summary card |

---

## 6. Failure & degradation matrix

| Failure | Behavior |
|---------|----------|
| Cloudinary upload fails | Dialog surfaces the provider's error message; seller retries or retakes; nothing persisted |
| First transformation slow (~1–2 s) | Slider shows "Enhancing your photo…" spinner; result is then edge-cached globally |
| `e_gen_background_replace` misfire | Seller re-rolls ("Again") or switches surface; approval gate keeps bad results unpublished |
| Utils photo/sign down | Menu page shows the upload error; the legacy multipart path still works end-to-end |
| Seller's session expired | 401 → the frontend's standard refresh-and-retry interceptor handles it transparently |
| Invalid `enhancedUrl` at menu-item create | Regex validation rejects it → 400; the item is not stored with a foreign URL |

---

## 7. Security posture

| Vector | Defense |
|--------|---------|
| Unsigned upload abuse | Direct upload is signature-scoped (per-seller folder, timestamp); the unsigned preset is format-capped and folder-pinned |
| Open upload proxy | `/api/utils/upload` is now internal-key fail-closed (constant-time compare), image-MIME allow-list, ~10 MB cap |
| Transformation/URL injection | Surface prompts from a fixed `[a-z0-9_]` table; publicId validated (`[A-Za-z0-9_-/]`, no `..`); stored URLs regex-validated at the domain owner |
| Auth scraping | `photo/sign` + `photo/preview` ride the shared cookie-session JWT (15-min access token); 30/min rate limit on signing |
| Bandwidth DoS | Image bytes bypass Foodo entirely; utils' 15 MB parser remains scoped to the internal upload path only |

---

## 8. Configuration (`utils/.env` additions)

```env
# Already required by the platform's Cloudinary usage:
CLOUDINARY_CLOUD_NAME=your-cloud-name
CLOUDINARY_API_KEY=your-api-key
CLOUDINARY_API_SECRET=your-api-secret
# Already present for session parity with sibling services:
JWT_SECRET=…
COOKIE_SECRET=…
INTERNAL_SERVICE_KEY=…
```

New dependency: `cookie-session` (session parity for the photo routes).

No other service needs new configuration. The frontend uses the existing
`/api/utils/*` rewrite — no new Next.js env or route.

---

## 9. Testing

- `utils` and `restaurant`: `tsc --noEmit` clean (route wiring, Express 5
  handler typing, URL validation paths).
- Frontend: `tsc --noEmit` clean (hook contracts, slider props, seller
  page integration).
- Recommended next: a Playwright flow (upload fixture → slider visible →
  approve → item created with a `res.cloudinary.com` URL), and a contract
  test asserting the sign endpoint's SHA-1 against a known
  folder/timestamp pair.

---

## 10. Flow walkthrough — "Paneer Tikka, kitchen counter, fluorescent light"

1. Seller taps **Add Dish Photo** → phone camera opens (file input,
   `capture="environment"`).
2. Sign: `POST /api/utils/photo/sign` → folder
   `foodo/dishes/6540a…`, signature, timestamp.
3. Browser uploads the 6.8 MB HEIC→JPEG straight to Cloudinary →
   `public_id: foodo/dishes/6540a…/paneer_tikka_x9`.
4. Preview: `POST /api/utils/photo/preview` → before/after URLs.
5. Slider: left, the yellow-tinted counter shot; right, `e_improve`
   white-balanced paneer on white marble, perfectly framed. Seller
   switches to **Slate**, likes it better, taps **Again** once for a
   variation, then **Approve & Publish**.
6. `POST /api/menu-item/new` with the enhanced URL → item live on the
   menu. First customer hit transforms (~1.2 s), then the CDN serves
   ~40 KB WebP/AVIF to everyone after.
