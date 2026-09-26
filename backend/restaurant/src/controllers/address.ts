import mongoose from "mongoose";
import { AuthRequest } from "../middlewares/isAuth.js";
import { tryCatch } from "../middlewares/trycatch.js";
import { Address } from "../models/Address.js";

export const createAddress = tryCatch(async (req: AuthRequest, res) => {
  const user = req.user;
  if (!user) {
    throw new Error("User not found");
  }

  const { mobile, formatterAddress, latitude, longitude } = req.body;

  if (!mobile || !formatterAddress) {
    throw new Error("Mobile and address are required");
  }

  if (latitude == null || longitude == null) {
    throw new Error("Location coordinates are required");
  }

  const newAddress = await Address.create({
    userId: user._id.toString(),
    mobile,
    formatterAddress,
    location: {
      type: "Point",
      coordinates: [Number(longitude), Number(latitude)],
    },
  });

  return res.status(201).json({
    success: true,
    message: "Address created successfully",
    data: newAddress,
  });
});

export const deleteAddress = tryCatch(async (req: AuthRequest, res) => {
  const user = req.user;
  if (!user) {
    throw new Error("User not found");
  }

  const { id } = req.params;

  if (!id) {
    throw new Error("Address ID is required");
  }

  const address = await Address.findOne({
    _id: id,
    userId: user._id.toString(),
  });

  if (!address) {
    throw new Error("Address not found");
  }

  await address.deleteOne();

  return res.status(200).json({
    success: true,
    message: "Address deleted successfully",
  });
});

export const getMyAddresses = tryCatch(async (req: AuthRequest, res) => {
  const user = req.user;
  if (!user) {
    throw new Error("User not found");
  }

  const addresses = await Address.find({
    userId: user._id.toString(),
  }).sort({ createdAt: -1 });

  return res.status(200).json({
    success: true,
    data: addresses,
  });
});
