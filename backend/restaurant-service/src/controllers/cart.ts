import { AuthRequest, tryCatch } from "@foodo/backend-common";
import {
  findCartFromDifferentRestaurant,
  incrementCartItem,
  decrementCartItem,
  getCartItem,
  deleteCartItem,
  clearCart,
  getCartRows,
  fetchMenuItemsForCart,
} from "../dynamo/cart.js";

export const addToCart = tryCatch(async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  const userId = String(req.user._id);
  const { restaurantId, itemId } = req.body;

  if (!restaurantId || !itemId) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid restaurant or item id" });
  }

  const cartFromDifferentRestaurant = await findCartFromDifferentRestaurant(
    userId,
    restaurantId,
  );

  if (cartFromDifferentRestaurant) {
    return res.status(400).json({
      success: false,
      message: "You can only have one restaurant in your cart",
    });
  }

  const cart = await incrementCartItem(userId, restaurantId, itemId);

  return res
    .status(200)
    .json({ success: true, message: "Item added to cart", cart });
});

export const getCart = tryCatch(async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  const userId = String(req.user._id);

  const rows = await getCartRows(userId);
  const menuById = await fetchMenuItemsForCart(rows.map((r) => r.itemId));

  // Same response contract as the populate() version: cart rows carry
  // their restaurant + full item; missing items are skipped.
  const cart = rows
    .map((row) => {
      const item = menuById.get(row.itemId);
      if (!item) return null;
      return {
        ...row,
        itemId: item,
        restaurantId: { _id: row.restaurantId },
      };
    })
    .filter(Boolean);

  let subtotal = 0;
  let cartLength = 0;

  for (const cartItem of cart as any[]) {
    subtotal += cartItem.itemId.price * cartItem.quantity;
    cartLength += cartItem.quantity;
  }

  return res.status(200).json({ success: true, cart, subtotal, cartLength });
});

export const icreamentQuantity = tryCatch(async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  const userId = String(req.user._id);
  const { itemId } = req.body;

  if (!itemId) {
    return res.status(400).json({ success: false, message: "Invalid item id" });
  }

  // Increment needs the row's restaurantId; a missing row is a 404
  // (the add endpoint owns first-insert).
  const existing = await getCartItem(userId, itemId);
  if (!existing) {
    return res
      .status(404)
      .json({ success: false, message: "Item not found in cart" });
  }

  const cartItem = await incrementCartItem(
    userId,
    existing.restaurantId,
    itemId,
  );

  return res
    .status(200)
    .json({ success: true, message: "Quantity increased", cartItem });
});

export const decrementQuantity = tryCatch(async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  const userId = String(req.user._id);
  const { itemId } = req.body;

  if (!itemId) {
    return res.status(400).json({ success: false, message: "Invalid item id" });
  }

  const cartItem = await getCartItem(userId, itemId);
  if (!cartItem) {
    return res
      .status(404)
      .json({ success: false, message: "Item not found in cart" });
  }

  if (cartItem.quantity <= 1) {
    await deleteCartItem(userId, itemId);
  } else {
    await decrementCartItem(userId, itemId);
  }

  return res.status(200).json({ success: true, message: "Quantity decreased" });
});

export const removeItem = tryCatch(async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  const userId = String(req.user._id);
  const { itemId } = req.body;

  if (!itemId) {
    return res.status(400).json({ success: false, message: "Invalid item id" });
  }

  const existing = await getCartItem(userId, itemId);
  if (!existing) {
    return res
      .status(404)
      .json({ success: false, message: "Item not found in cart" });
  }

  await deleteCartItem(userId, itemId);

  return res
    .status(200)
    .json({ success: true, message: "Item removed from cart" });
});

export const clearCartController = tryCatch(async (req: AuthRequest, res) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  const userId = String(req.user._id);

  await clearCart(userId);

  return res.status(200).json({ success: true, message: "Cart cleared" });
});
