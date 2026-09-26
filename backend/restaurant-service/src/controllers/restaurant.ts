import { uploadViaBreaker } from "../config/http.js";
import { dataUri } from "../config/dataUri.js";
import { AuthRequest } from "../middlewares/isAuth.js";
import { tryCatch } from "../middlewares/trycatch.js";
import { Restaurant } from "../models/Restaurant.js";
import jwt from "jsonwebtoken";

export const addRestaurant = tryCatch(async (req: AuthRequest, res) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  const existingRestaurant = await Restaurant.findOne({
    ownerId: user._id,
  });

  if (existingRestaurant) {
    return res.status(400).json({
      message: "You already have a restaurant",
    });
  }

  const {
    name,
    description,
    latitude,
    longitude,
    formattedAddress,
    phone,
    file,
  } = req.body;
  if (!name || !latitude || !longitude) {
    return res.status(400).json({
      message: "Please give all details",
    });
  }

  // Upload image if provided (accepts base64 data URI string from JSON body)
  let imageUrl: string | undefined;
  if (file) {
    // file can be a base64 data URI string (from JSON body) or a multer File object
    const buffer = typeof file === "string" ? file : dataUri(file)?.content;
    if (!buffer) {
      return res.status(500).json({
        message: "Internal Server Error",
      });
    }

    // Non-critical pool + breaker — upload retries are cheap.
    const data = await uploadViaBreaker<{
      url: string;
    }>(`${process.env.UTILS_SERVICE_URL}/api/utils/upload`, { buffer });
    imageUrl = data.url;
  }

  const restaurant = await Restaurant.create({
    name,
    description,
    phone,
    ...(imageUrl && { image: imageUrl }),
    ownerId: user._id,
    autoLocation: {
      type: "Point",
      coordinates: [Number(longitude), Number(latitude)],
      formattedAddress,
    },
  });
  res
    .status(200)
    .json({ message: "Restaurant added successfully", restaurant });
});

export const getMyRestaurant = tryCatch(async (req: AuthRequest, res) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  const restaurant = await Restaurant.findOne({
    ownerId: user._id,
  });
  if (!restaurant) {
    return res.status(404).json({ message: "Restaurant not found" });
  }

  if (!user.restaurantId) {
    const token = jwt.sign(
      { user: { ...user, restaurantId: restaurant._id } } as any,
      process.env.JWT_SECRET!,
      { expiresIn: "7d" },
    );
    return res
      .status(200)
      .json({ message: "Restaurant fetched successfully", restaurant, token });
  }
  res
    .status(200)
    .json({ message: "Restaurant fetched successfully", restaurant });
});

export const updateRestaurantStatus = tryCatch(
  async (req: AuthRequest, res) => {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { status } = req.body;
    if (status === undefined || status === null) {
      return res.status(400).json({
        message: "Please provide status",
      });
    }

    const restaurant = await Restaurant.findOneAndUpdate(
      { ownerId: user._id },
      { isOpen: status },
      { new: true },
    );
    if (!restaurant) {
      return res.status(404).json({ message: "Restaurant not found" });
    }

    res
      .status(200)
      .json({ message: "Restaurant status updated successfully", restaurant });
  },
);

export const updateRestaurantDetails = tryCatch(
  async (req: AuthRequest, res) => {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const { name, description, phone, file } = req.body;

    const updateFields: Record<string, any> = {};
    if (name !== undefined) updateFields.name = name;
    if (description !== undefined) updateFields.description = description;
    if (phone !== undefined) updateFields.phone = phone;

    // Handle image upload if provided
    if (file) {
      const buffer = typeof file === "string" ? file : dataUri(file)?.content;
      if (buffer) {
        const data = await uploadViaBreaker<{
          url: string;
        }>(`${process.env.UTILS_SERVICE_URL}/api/utils/upload`, { buffer });
        updateFields.image = data.url;
      }
    }

    const restaurant = await Restaurant.findOneAndUpdate(
      { ownerId: user._id },
      updateFields,
      { new: true },
    );
    if (!restaurant) {
      return res.status(404).json({ message: "Restaurant not found" });
    }

    res
      .status(200)
      .json({ message: "Restaurant details updated successfully", restaurant });
  },
);

// ─── Public: Get All Restaurants ────────────────────────────

export const getAllRestaurants = tryCatch(async (req, res) => {
  const restaurants = await Restaurant.find({ isVerified: true });
  res.status(200).json({
    success: true,
    count: restaurants.length,
    data: restaurants,
  });
});

// ─── Public: Get Restaurant By ID ────────────────────────────

export const getRestaurantById = tryCatch(async (req, res) => {
  const { id } = req.params;
  const restaurant = await Restaurant.findById(id);
  if (!restaurant) {
    return res.status(404).json({ message: "Restaurant not found" });
  }
  res.status(200).json({ success: true, data: restaurant });
});

// ─── Public: Get Nearby Restaurants ──────────────────────────

export const getNearbyRestaurants = tryCatch(async (req, res) => {
  const { longitude, latitude, maxDistance } = req.query;

  if (!longitude || !latitude) {
    // If no location provided, return all verified restaurants
    const restaurants = await Restaurant.find({ isVerified: true });
    return res.status(200).json({
      success: true,
      count: restaurants.length,
      data: restaurants,
    });
  }

  const restaurants = await Restaurant.find({
    isVerified: true,
    autoLocation: {
      $near: {
        $geometry: {
          type: "Point",
          coordinates: [Number(longitude), Number(latitude)],
        },
        $maxDistance: Number(maxDistance) || 50000, // default 50km
      },
    },
  });

  res.status(200).json({
    success: true,
    count: restaurants.length,
    data: restaurants,
  });
});
