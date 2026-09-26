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
import { uploadToCloudinary } from "@foodo/backend-common/cloudinary";
import {
  setCacheablePublic,
  setCacheablePrivate,
} from "@foodo/backend-common/aws";

export const createMenuItemController = tryCatch(
  async (req: AuthRequest, res) => {
    if (!req.user) throw new Error("User not found");
    const restaurant = await getRestaurantByOwner(String(req.user._id));
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
        folder: "foodo/menu-items",
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

export const deleteMenuItemController = tryCatch(
  async (req: AuthRequest, res) => {
    if (!req.user) throw new Error("User not found");
    const id = req.params.id as string;
    if (!id) throw new Error("ID is required");
    const menuItem = await getMenuItemById(id);
    if (!menuItem) throw new Error("Menu item not found");

    const restaurant = await getRestaurantById(menuItem.restaurantId);
    if (!restaurant || restaurant.ownerId !== String(req.user._id)) {
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
    if (!restaurant || restaurant.ownerId !== String(req.user._id)) {
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
