import axios from "axios";
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

  if (file) {
    const fileBuffer = dataUri(file);
    if (!fileBuffer) {
      return res.status(500).json({
        message: "Internal Server Error",
      });
    }

    const { data } = await axios.post(
      `${process.env.UTILS_SERVICE_URL}/api/upload`,
      {
        buffer: fileBuffer.content,
      },
    );

    const restaurant = await Restaurant.create({
      name,
      description,
      phone,
      image: data.url,
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
  }
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
    if (!status) {
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

    const { name, description, phone } = req.body;

    const restaurant = await Restaurant.findOneAndUpdate(
      { ownerId: user._id },
      { name, description, phone },
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
