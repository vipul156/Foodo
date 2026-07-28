import { AuthRequest } from "../middlewares/isAuth.js";
import { tryCatch } from "../middlewares/trycatch.js";
import mongoose from "mongoose";
import { Cart } from "../models/Cart.js";

export const addToCart = tryCatch(async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  const userId = req.user._id;
  const { restaurantId, itemId } = req.body;

  if (
    !mongoose.Types.ObjectId.isValid(restaurantId) ||
    !mongoose.Types.ObjectId.isValid(itemId)
  ) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid restaurant or item id" });
  }

  const cartFromDifferentRestaurant = await Cart.findOne({
    user: userId,
    restaurant: { $ne: restaurantId },
  });

  if (cartFromDifferentRestaurant) {
    return res.status(400).json({
      success: false,
      message: "You can only have one restaurant in your cart",
    });
  }

  const cart = await Cart.findOneAndUpdate(
    { user: userId, restaurant: restaurantId },
    { $inc: { quantity: 1 }, $setOnInsert: { userId, restaurantId, itemId } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  return res
    .status(200)
    .json({ success: true, message: "Item added to cart", cart });
});

export const getCart = tryCatch(async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  const userId = req.user._id;
  const cart = await Cart.find({ user: userId })
    .populate("itemId")
    .populate("restaurantId");

  let subtotal = 0;
  let cartLength = 0;

  for (const cartItem of cart) {
    const item: any = cartItem.itemId;

    subtotal += item.price * cartItem.quantity;
    cartLength += cartItem.quantity;
  }

  return res.status(200).json({ success: true, cart, subtotal, cartLength });
});

export const icreamentQuantity = tryCatch(async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  const userId = req.user._id;
  const { itemId } = req.body;

  if (!mongoose.Types.ObjectId.isValid(itemId)) {
    return res.status(400).json({ success: false, message: "Invalid item id" });
  }

  const cartItem = await Cart.findOneAndUpdate(
    { userId, itemId },
    { $inc: { quantity: 1 } },
    { new: true },
  );

  if (!cartItem) {
    return res
      .status(404)
      .json({ success: false, message: "Item not found in cart" });
  }

  return res
    .status(200)
    .json({ success: true, message: "Quantity increased", cartItem });
});

export const decrementQuantity = tryCatch(async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  const userId = req.user._id;
  const { itemId } = req.body;

  if (!mongoose.Types.ObjectId.isValid(itemId)) {
    return res.status(400).json({ success: false, message: "Invalid item id" });
  }

  const cartItem = await Cart.findOne({ userId, itemId });

  if (!cartItem) {
    return res
      .status(404)
      .json({ success: false, message: "Item not found in cart" });
  }

  if (cartItem.quantity == 1) {
    await Cart.deleteOne({ userId, itemId });
  } else {
    await Cart.updateOne({ userId, itemId }, { $inc: { quantity: -1 } });
  }

  return res.status(200).json({ success: true, message: "Quantity decreased" });
});

export const clearCart = tryCatch(async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  const userId = req.user._id;

  await Cart.deleteMany({ userId });

  return res.status(200).json({ success: true, message: "Cart cleared" });
});
