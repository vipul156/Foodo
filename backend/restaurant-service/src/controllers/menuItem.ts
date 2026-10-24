import { tryCatch } from "@foodo/backend-common";
import { AuthRequest } from "@foodo/backend-common";
import {
  getRestaurantById,
  getRestaurantByOwner,
} from "@foodo/backend-common/dynamo";
import {
  createMenuItem,
  listMenuItemsByRestaurant,
  getMenuItemById,
  toggleMenuItemAvailabilityTo,
  deleteMenuItem as deleteMenuItemRow,
} from "../dynamo/cart.js";
import { dataUri } from "@foodo/backend-common/files";
import {
  uploadToCloudinary,
  resolveUploadFolder,
} from "@foodo/backend-common/cloudinary";
import {
  setCacheablePublic,
  setCacheablePrivate,
} from "@foodo/backend-common/aws";

export const createMenuItemController = tryCatch(
  async (req: AuthRequest, res) => {
    if (!req.user) throw new Error("User not found");
    const restaurant = await getRestaurantByOwner(String(req.user.id));
    if (!restaurant) throw new Error("Restaurant not found");
    const { name, description, price } = req.body;
    if (!name || !price) {
      throw new Error("Name and price are required");
    }

    // Preferred flow (direct upload): the client already uploaded the
    // image straight to Cloudinary with a signed payload and passes the
    // URL. Legacy fallback: multipart `file` → server-side upload.
    let imageUrl: string | undefined = req.body?.imageUrl;
    if (!imageUrl) {
      const file = req.file;
      if (!file) {
        throw new Error("Image is required");
      }
      const fileBuffer = dataUri(file);
      if (!fileBuffer?.content) {
        return res.status(500).json({
          message: "Internal Server Error",
        });
      }
      imageUrl = await uploadToCloudinary({
        fileContent: fileBuffer.content,
        folder: resolveUploadFolder("menu-items"),
        tags: ["foodo", "menu-item"],
      });
    }

    const menuItem = await createMenuItem({
      name,
      description,
      price,
      image: imageUrl,
      restaurantId: restaurant.id,
    });
    return res.status(201).json({
      message: "Menu item created successfully",
      menuItem,
    });
  },
);

export const getMenuItems = tryCatch(async (req: AuthRequest, res) => {
  const id = req.params.id as string;
  if (!id) throw new Error("ID is required");
  const menuItems = await listMenuItemsByRestaurant(id);

  // Hot public catalog read — edge-cacheable (CloudFront tier).
  setCacheablePublic(res, 60, 30, 300);

  return res.status(200).json({
    message: "Menu items fetched successfully",
    menuItems,
  });
});

// ─── POST /api/menu-item/bulk ────────────────────────────────
// One-shot seeding from the AI menu parser's review grid.
//
// Ownership comes from the session, never from the body: a seller can
// only write their own menu, whatever restaurant_id the caller sends.
// Names are deduped case-insensitively against the current menu so a
// second publish of the same photo does not fork the catalogue.

interface BulkItemInput {
  category?: unknown;
  name?: unknown;
  description?: unknown;
  price?: unknown;
}

const BULK_LIMIT = 300;

export const bulkCreateMenuItems = tryCatch(
  async (req: AuthRequest, res) => {
    if (!req.user) throw new Error("User not found");
    const restaurant = await getRestaurantByOwner(String(req.user.id));
    if (!restaurant) {
      return res.status(403).json({
        success: false,
        message: "No restaurant is linked to this account",
      });
    }

    const body = (req.body ?? {}) as {
      items?: unknown;
      replace_existing?: unknown;
      restaurant_id?: unknown;
    };
    const claimed =
      typeof body.restaurant_id === "string" ? body.restaurant_id : null;
    if (claimed && claimed !== restaurant.id) {
      return res.status(400).json({
        success: false,
        message: "restaurant_id does not match the signed-in owner",
      });
    }

    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (rawItems.length === 0) {
      return res.status(400).json({ success: false, message: "items is required" });
    }
    if (rawItems.length > BULK_LIMIT) {
      return res.status(400).json({
        success: false,
        message: `At most ${BULK_LIMIT} items per publish`,
      });
    }

    const replaceExisting = body.replace_existing === true;
    const existing = await listMenuItemsByRestaurant(restaurant.id);
    if (replaceExisting) {
      for (const item of existing) {
        await deleteMenuItemRow(item.id);
      }
    }

    const seen = new Set(
      (replaceExisting ? [] : existing).map((item) =>
        item.name.trim().toLowerCase(),
      ),
    );
    const skipped: string[] = [];
    let created = 0;

    for (const raw of rawItems) {
      const item = (raw ?? {}) as BulkItemInput;
      const name = typeof item.name === "string" ? item.name.trim() : "";
      const price =
        typeof item.price === "number" ? item.price : Number(item.price);
      if (!name || !Number.isFinite(price) || price < 0) {
        skipped.push(name || "unnamed");
        continue;
      }

      const key = name.toLowerCase();
      if (seen.has(key)) {
        skipped.push(name);
        continue;
      }
      seen.add(key);

      const category =
        typeof item.category === "string" && item.category.trim()
          ? item.category.trim()
          : undefined;

      await createMenuItem({
        restaurantId: restaurant.id,
        name,
        description:
          typeof item.description === "string" ? item.description.trim() : "",
        price,
        // Parsed menus carry no dish photo; sellers add one per item later.
        image: "",
        ...(category ? { category } : {}),
      });
      created += 1;
    }

    return res.status(200).json({
      success: true,
      created,
      skipped,
      restaurantId: restaurant.id,
    });
  },
);

export const deleteMenuItemController = tryCatch(
  async (req: AuthRequest, res) => {
    if (!req.user) throw new Error("User not found");
    const id = req.params.id as string;
    if (!id) throw new Error("ID is required");
    const menuItem = await getMenuItemById(id);
    if (!menuItem) throw new Error("Menu item not found");

    const restaurant = await getRestaurantById(menuItem.restaurantId);
    if (!restaurant || restaurant.ownerId !== String(req.user.id)) {
      throw new Error("Restaurant not found");
    }

    await deleteMenuItemRow(id);
    return res.status(200).json({
      message: "Menu item deleted successfully",
    });
  },
);

export const toogleMenuItemAvailability = tryCatch(
  async (req: AuthRequest, res) => {
    if (!req.user) throw new Error("User not found");
    const id = req.params.id as string;
    if (!id) throw new Error("ID is required");
    const menuItem = await getMenuItemById(id);
    if (!menuItem) throw new Error("Menu item not found");

    const restaurant = await getRestaurantById(menuItem.restaurantId);
    if (!restaurant || restaurant.ownerId !== String(req.user.id)) {
      throw new Error("Restaurant not found");
    }

    const updated = await toggleMenuItemAvailabilityTo(
      id,
      !menuItem.isAvailable,
    );
    return res.status(200).json({
      message: "Menu item availability toggled successfully",
      menuItem: updated,
    });
  },
);
