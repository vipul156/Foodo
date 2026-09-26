import { uploadToCloudinary } from "@foodo/backend-common/cloudinary";
import { dataUri } from "@foodo/backend-common/files";
import { AuthRequest } from "@foodo/backend-common";
import { tryCatch } from "@foodo/backend-common";
import {
  createRestaurant,
  getRestaurantById,
  getRestaurantByOwner,
  listVerifiedRestaurants,
  listRestaurantsNear,
  setRestaurantOpen,
  updateRestaurantByOwner,
} from "@foodo/backend-common/dynamo";
import {
  setCacheablePublic,
  setCacheablePrivate,
} from "@foodo/backend-common/aws";
import jwt from "jsonwebtoken";

export const addRestaurant = tryCatch(async (req: AuthRequest, res) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  const existingRestaurant = await getRestaurantByOwner(String(user._id));

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
    imageUrl,
  } = req.body;
  if (!name || !latitude || !longitude) {
    return res.status(400).json({
      message: "Please give all details",
    });
  }

  // Preferred flow (direct upload): client uploaded via signed params and
  // passes the Cloudinary URL here. Legacy fallback: base64/multipart
  // `file` → server-side upload via the shared signer.
  let resolvedImageUrl: string | undefined =
    typeof imageUrl === "string" && imageUrl ? imageUrl : undefined;
  if (!resolvedImageUrl && file) {
    const buffer = typeof file === "string" ? file : dataUri(file)?.content;
    if (!buffer) {
      return res.status(500).json({
        message: "Internal Server Error",
      });
    }

    resolvedImageUrl = await uploadToCloudinary({
      fileContent: buffer,
      folder: "foodo/restaurants",
      tags: ["foodo", "restaurant"],
    });
  }

  const restaurant = await createRestaurant({
    name,
    description,
    phone,
    ...(resolvedImageUrl && { image: resolvedImageUrl }),
    ownerId: String(user._id),
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
  const restaurant = await getRestaurantByOwner(String(user._id));
  if (!restaurant) {
    return res.status(404).json({ message: "Restaurant not found" });
  }

  // Owner-scoped read: private, never shared at the edge.
  setCacheablePrivate(res, 5);

  if (!user.restaurantId) {
    const token = jwt.sign(
      { user: { ...user, restaurantId: restaurant.id } } as any,
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

    const restaurant = await setRestaurantOpen(String(user._id), status);
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

    const { name, description, phone, file, imageUrl } = req.body;

    const updateFields: Record<string, any> = {};
    if (name !== undefined) updateFields.name = name;
    if (description !== undefined) updateFields.description = description;
    if (phone !== undefined) updateFields.phone = phone;

    if (typeof imageUrl === "string" && imageUrl) {
      updateFields.image = imageUrl;
    } else if (file) {
      const buffer = typeof file === "string" ? file : dataUri(file)?.content;
      if (buffer) {
        updateFields.image = await uploadToCloudinary({
          fileContent: buffer,
          folder: "foodo/restaurants",
          tags: ["foodo", "restaurant"],
        });
      }
    }

    const restaurant = await updateRestaurantByOwner(
      String(user._id),
      updateFields,
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
  const restaurants = await listVerifiedRestaurants();

  // Hot public catalog — the CloudFront tier serves most reads.
  setCacheablePublic(res, 120, 60, 600);

  res.status(200).json({
    success: true,
    count: restaurants.length,
    data: restaurants,
  });
});

// ─── Public: Get Restaurant By ID ────────────────────────────

export const getRestaurantByIdController = tryCatch(async (req, res) => {
  const id = req.params.id as string;
  const restaurant = await getRestaurantById(id);
  if (!restaurant) {
    return res.status(404).json({ message: "Restaurant not found" });
  }
  setCacheablePublic(res, 120, 60, 600);
  res.status(200).json({ success: true, data: restaurant });
});

// ─── Public: Get Nearby Restaurants ──────────────────────────

export const getNearbyRestaurants = tryCatch(async (req, res) => {
  const { longitude, latitude, maxDistance } = req.query;

  if (!longitude || !latitude) {
    const restaurants = await listVerifiedRestaurants();
    setCacheablePublic(res, 120, 60, 600);
    return res.status(200).json({
      success: true,
      count: restaurants.length,
      data: restaurants,
    });
  }

  // Bounding-box + haversine (DynamoDB $near replacement), cached per
  // geohash-free query string at the edge — same URL → same result set.
  const restaurants = await listRestaurantsNear(
    Number(latitude),
    Number(longitude),
    Number(maxDistance) || 50_000,
  );
  setCacheablePublic(res, 60, 30, 300);

  res.status(200).json({
    success: true,
    count: restaurants.length,
    data: restaurants,
  });
});
