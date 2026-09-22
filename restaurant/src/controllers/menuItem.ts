import { MenuItem } from "../models/MenuItem.js";
import { tryCatch } from "../middlewares/trycatch.js";
import { AuthRequest } from "../middlewares/isAuth.js";
import { Restaurant } from "../models/Restaurant.js";
import { dataUri } from "../config/dataUri.js";
import { uploadViaBreaker } from "../config/http.js";
import { parserViaBreaker } from "../config/parser.http.js";

export const createMenuItem = tryCatch(async (req: AuthRequest, res) => {
  if (!req.user) throw new Error("User not found");
  const restaurant = await Restaurant.findOne({ ownerId: req.user._id });
  if (!restaurant) throw new Error("Restaurant not found");
  const { name, description, price, enhancedUrl } = req.body;
  if (!name || !price) {
    throw new Error("Name and price are required");
  }

  // ─── Photo pipeline (Cloudinary direct upload) ─────────────
  // The seller's browser uploads the photo DIRECTLY to Cloudinary and
  // the AI-enhanced delivery URL arrives here as `enhancedUrl`. In that
  // flow no image bytes pass through this service at all.
  // Fallback: the legacy multipart path forwards the file to the utils
  // upload endpoint (internal-key gated) for partners on old clients.
  let imageUrl: string | undefined;
  if (
    typeof enhancedUrl === "string" &&
    /^https:\/\/res\.cloudinary\.com\/[A-Za-z0-9_\-]+\/image\/upload\/.+/.test(
      enhancedUrl
    ) &&
    enhancedUrl.length <= 600
  )
  {
    imageUrl = enhancedUrl;
  } else {
    const file = req.file;
    if (!file) {
      throw new Error("Image is required");
    }
    const fileBuffer = dataUri(file);
    if (!fileBuffer) {
      return res.status(500).json({
        message: "Internal Server Error",
      });
    }

    // Non-critical pool + breaker — upload retries are cheap; they must
    // never queue behind (or trip breakers for) the critical release path.
    const data = await uploadViaBreaker<{
      url: string;
    }>(`${process.env.UTILS_SERVICE_URL}/api/utils/upload`, {
      buffer: fileBuffer.content,
    });
    imageUrl = data.url;
  }

  const menuItem = await MenuItem.create({
    name,
    description,
    price,
    image: imageUrl!,
    restaurantId: restaurant._id,
    isAvailable: true,
  });
  return res.status(201).json({
    message: "Menu item created successfully",
    menuItem,
  });
});

// ─── AI menu import (vision parse proxy) ────────────────────
// The restaurant service owns authorization; the Python ai-menu-parser
// service owns vision. The owner's session cookie is forwarded so the
// parser can rate-limit per identity — and the bulk publish flows back
// through this service (the ONLY writer to the menu collection).
export const aiParseMenu = tryCatch(async (req: AuthRequest, res) => {
  if (!req.user) throw new Error("User not found");
  const restaurant = await Restaurant.findOne({ ownerId: req.user._id });
  if (!restaurant) throw new Error("Restaurant not found");

  const { imageUrl } = req.body as { imageUrl?: unknown };
  if (typeof imageUrl !== "string" || !imageUrl.startsWith("https://") || imageUrl.length > 600) {
    return res.status(400).json({ message: "imageUrl (https) is required" });
  }

  const draft = await parserViaBreaker<unknown>(
    `${process.env.MENU_PARSER_SERVICE_URL}/api/menu-parser/parse`,
    { imageUrl },
    { headers: { cookie: req.headers.cookie ?? "" } },
  );
  return res.status(200).json(draft);
});

// ─── One-click bulk seeding (owner-verified review grid) ─────
// The frontend sends the FINAL, human-confirmed array. Every item is
// validated server-side; descriptions are optional (parsed menus may
// have none) and images default to the standard placeholder, matching
// the manual create path. Option `replaceExisting` clears the current
// menu first so an import is idempotent to re-run.
export const bulkCreateMenuItems = tryCatch(async (req: AuthRequest, res) => {
  if (!req.user) throw new Error("User not found");
  const restaurant = await Restaurant.findOne({ ownerId: req.user._id });
  if (!restaurant) throw new Error("Restaurant not found");

  const { items, replaceExisting } = req.body as {
    items?: unknown;
    replaceExisting?: boolean;
  };
  if (!Array.isArray(items) || items.length === 0 || items.length > 300) {
    return res.status(400).json({ message: "items (1–300) are required" });
  }

  interface ParsedRow {
    category?: unknown;
    name?: unknown;
    description?: unknown;
    price?: unknown;
    is_veg?: unknown;
    isVeg?: unknown;
    spicy_level?: unknown;
    spicyLevel?: unknown;
    allergens?: unknown;
  }

  const docs: Array<{
    name: string;
    description: string;
    price: number;
    category: string;
    image: string;
    isVeg: boolean | null;
  }> = [];
  const skipped: string[] = [];

  for (const raw of items as ParsedRow[]) {
    const name = typeof raw?.name === "string" ? raw.name.trim() : "";
    const price = Number(raw?.price);
    if (!name || name.length > 120 || !Number.isFinite(price) || price < 0) {
      skipped.push(name || "unnamed item");
      continue;
    }
    const category =
      typeof raw?.category === "string" && raw.category.trim()
        ? raw.category.trim().slice(0, 80)
        : "Others";
    const description =
      typeof raw?.description === "string" ? raw.description.trim().slice(0, 500) : "";
    const isVegRaw = raw?.is_veg ?? raw?.isVeg;
    const spicyRaw = raw?.spicy_level ?? raw?.spicyLevel;
    const spicy = typeof spicyRaw === "string" ? spicyRaw.toLowerCase() : "";

    docs.push({
      name,
      description,
      price: Math.round(price * 100) / 100,
      category,
      // Menu imports don't carry photos; the standard dish placeholder
      // keeps customer UI rendering consistent until the owner adds one
      // via the photo pipeline.
      image: "https://res.cloudinary.com/demo/image/upload/dish-placeholder.png",
      isVeg: typeof isVegRaw === "boolean" ? isVegRaw : null,
    });
    // Allergen tags are stored on the item name level only in this schema;
    // spicy hints (if any) surface via the description suffix.
    if (spicy && spicy !== "unknown" && description) {
      // keep description as-is — spicy_level is not persisted in this schema
    }
  }

  if (docs.length === 0) {
    return res.status(400).json({ message: "no valid items to import" });
  }

  if (replaceExisting) {
    await MenuItem.deleteMany({ restaurantId: restaurant._id });
  }
  const created = await MenuItem.insertMany(docs, { ordered: false });

  return res.status(201).json({
    message: "Menu imported successfully",
    created: created.length,
    skipped,
    restaurantId: restaurant._id,
  });
});

export const getMenuItems = tryCatch(async (req: AuthRequest, res) => {
  const { id } = req.params;
  if (!id) throw new Error("ID is required");
  const menuItems = await MenuItem.find({ restaurantId: id });
  return res.status(200).json({
    message: "Menu items fetched successfully",
    menuItems,
  });
});

export const deleteMenuItem = tryCatch(async (req: AuthRequest, res) => {
  if (!req.user) throw new Error("User not found");
  const { id } = req.params;
  if (!id) throw new Error("ID is required");
  const menuItem = await MenuItem.findById(id);
  if (!menuItem) throw new Error("Menu item not found");

  const restaurant = await Restaurant.findOne({
    ownerId: req.user._id,
    _id: menuItem.restaurantId,
  });
  if (!restaurant) throw new Error("Restaurant not found");

  await menuItem.deleteOne();
  return res.status(200).json({
    message: "Menu item deleted successfully",
  });
});

export const toogleMenuItemAvailability = tryCatch(
  async (req: AuthRequest, res) => {
    if (!req.user) throw new Error("User not found");
    const { id } = req.params;
    if (!id) throw new Error("ID is required");
    const menuItem = await MenuItem.findById(id);
    if (!menuItem) throw new Error("Menu item not found");

    const restaurant = await Restaurant.findOne({
      ownerId: req.user._id,
      _id: menuItem.restaurantId,
    });
    if (!restaurant) throw new Error("Restaurant not found");

    menuItem.isAvailable = !menuItem.isAvailable;
    await menuItem.save();
    return res.status(200).json({
      message: "Menu item availability toggled successfully",
      menuItem,
    });
  },
);
