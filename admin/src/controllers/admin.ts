import { ObjectId } from "mongodb";
import { tryCatch } from "./trycatch.js";
import {
  getRestaurantCollection,
  getRidersCollection,
} from "../util/collection.js";

export const getPendingRestaurants = tryCatch(async (req, res) => {
  const restaurantCollection = await getRestaurantCollection();
  const restaurants = await restaurantCollection
    .find({ isVerified: false })
    .toArray();

  res.json({
    count: restaurants.length,
    restaurants,
  });
});

export const getPendingRiders = tryCatch(async (req, res) => {
  const riderCollection = await getRidersCollection();
  const riders = await riderCollection.find({ isVerified: false }).toArray();

  res.json({
    count: riders.length,
    riders,
  });
});

export const verifyRestaurant = tryCatch(async (req, res) => {
  const { id } = req.params;

  if (typeof id !== "string") {
    throw new Error("Invalid id");
  }

  if (!ObjectId.isValid(id)) {
    throw new Error("Invalid id");
  }

  const restaurantCollection = await getRestaurantCollection();
  await restaurantCollection.updateOne(
    { _id: new ObjectId(id) },
    { $set: { isVerified: true, updatedAt: new Date() } },
  );

  if (!restaurantCollection) {
    throw new Error("Restaurant not found");
  }
  
  res.json({ message: "Restaurant verified" });
});


export const verifyRider = tryCatch(async (req, res) => {
  const { id } = req.params;

  if (typeof id !== "string") {
    throw new Error("Invalid id");
  }

  if (!ObjectId.isValid(id)) {
    throw new Error("Invalid id");
  }

  const riderCollection = await getRidersCollection();
  await riderCollection.updateOne(
    { _id: new ObjectId(id) },
    { $set: { isVerified: true, updatedAt: new Date() } },
  );

  if (!riderCollection) {
    throw new Error("Rider not found");
  }
  
  res.json({ message: "Rider verified" });
});