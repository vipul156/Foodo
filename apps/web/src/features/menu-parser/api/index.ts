// ============================================================
// Foodo — AI Menu Parser (seller photo → review grid → publish)
// ============================================================
// Contract owner: backend/ai-menu-parser (FastAPI + Gemini vision).
//
//   POST /api/menu-parser/parse  { imageUrl }        → ParseDraft
//   POST /api/menu-parser/bulk   { restaurant_id, items, replace_existing }
//                                                    → { created, skipped }
//
// The parser never writes to the catalogue. The seller reviews every
// row, then bulk-publish proxies the verified items into
// restaurant-service, which owns the menu and re-checks ownership
// against the forwarded session cookie.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { restaurantApi } from "@/lib/api-client";

export type SpiceLevel = "none" | "mild" | "medium" | "hot" | "unknown";

export interface ParsedMenuItem {
  name: string;
  description: string;
  price: number;
  currency: string;
  is_veg: boolean | null;
  spicy_level: SpiceLevel;
  allergens: string[];
  category_hint: string;
}

export interface ParsedCategory {
  name: string;
  items: ParsedMenuItem[];
}

export interface ParseDraft {
  draft_id: string;
  image_url: string;
  categories: ParsedCategory[];
  warnings: string[];
  provider: string;
  duration_ms: number;
}

/** What the review grid sends back. Dietary flags are read by the
 *  model but the menu-item record has no field for them yet, so they
 *  are not published — sending them would claim a persistence we do
 *  not have. */
export interface PublishItem {
  category: string;
  name: string;
  description: string;
  price: number;
}

export interface PublishResult {
  created: number;
  skipped: string[];
  restaurant_id: string | null;
}

/** Read a hosted menu photo. Cheap to retry: nothing is persisted. */
export function useParseMenuImage() {
  return useMutation({
    mutationFn: (imageUrl: string) =>
      restaurantApi.post<ParseDraft>("/menu-parser/parse", { imageUrl }),
  });
}

/** The seller's explicit publish. `replace_existing` deletes the
 *  current menu first — the UI must make that impossible to trigger by
 *  accident. */
export function usePublishParsedMenu(restaurantId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: { items: PublishItem[]; replaceExisting: boolean }) =>
      restaurantApi.post<PublishResult>("/menu-parser/bulk", {
        restaurant_id: restaurantId,
        items: vars.items,
        replace_existing: vars.replaceExisting,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["menu-items", restaurantId] });
    },
  });
}
