import { MenuItem } from "../models/MenuItem.js";
import { tryCatch } from "@foodo/backend-common";
import { AuthRequest } from "@foodo/backend-common";
import { Restaurant } from "../models/Restaurant.js";
import { dataUri } from "@foodo/backend-common/files";
import { uploadToCloudinary } from "@foodo/backend-common/cloudinary";

export const createMenuItem = tryCatch(async (req: AuthRequest, res) => {
  if (!req.user) throw new Error("User not found");
  const restaurant = await Restaurant.findOne({ ownerId: req.user._id });
  if (!restaurant) throw new Error("Restaurant not found");
  const { name, description, price } = req.body;
  if (!name || !price) {
    throw new Error("Name and price are required");
  }

  // Preferred flow (direct upload): the client already uploaded the image
  // straight to Cloudinary with a signed payload and passes the URL here.
  // Legacy fallback: multipart `file` → server-side upload via the shared
  // signer (kept so older clients / API users keep working).
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

  const menuItem = await MenuItem.create({
    name,
    description,
    price,
    image: imageUrl,
    restaurantId: restaurant._id,
    isAvailable: true,
  });
  return res.status(201).json({
    message: "Menu item created successfully",
    menuItem,
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
