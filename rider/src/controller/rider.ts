import { dataUri } from "../config/dataUri.js";
import { AuthRequest } from "../middlewares/isAuth.js";
import { tryCatch } from "../middlewares/trycatch.js";
import { Rider } from "../model/Rider.js";
import { criticalPut, readGet, readPost } from "../config/http.js";
import { publishRiderEvent } from "../config/event.publisher.js";

// Shared internal auth header (evaluated at request time)
const getInternalHeaders = () => ({
  "x-internal-key": process.env.INTERNAL_SERVICE_KEY || "",
});

export const createRider = tryCatch(async (req: AuthRequest, res) => {
  const user = req.user;

  if (!user) {
    return res.status(401).json({
      message: "You are not authorized",
    });
  }

  const file = req.file;

  if (!file) {
    return res.status(400).json({
      message: "File is required",
    });
  }

  const fileBuffer = dataUri(file);

  if (!fileBuffer?.content) {
    return res.status(400).json({
      message: "File is not valid",
    });
  }

  // Upload forward rides the non-critical pool — registration can retry;
  // a saturated upload path must not touch the critical order-update pool.
  const data = await readPost<{ url: string }>(
    `${process.env.UTILS_SERVICE_URL}/api/utils/upload`,
    {
      buffer: fileBuffer.content,
    },
    {},
  );

  const {
    phoneNumber,
    addharNumber,
    drivingLicenseNumber,
    latitude,
    longitude,
  } = req.body;

  if (
    !phoneNumber ||
    !addharNumber ||
    !drivingLicenseNumber ||
    !latitude ||
    !longitude
  ) {
    return res.status(400).json({
      message: "All fields are required",
    });
  }

  const existingRider = await Rider.findOne({ userId: user._id });

  if (existingRider) {
    return res.status(400).json({
      message: "Rider already exists",
    });
  }

  const rider = await Rider.create({
    phoneNumber,
    addharNumber,
    drivingLicenseNumber,
    location: {
      type: "Point",
      coordinates: [longitude, latitude],
    },
    userId: user._id,
    picture: data.url,
  });

  return res.status(201).json({
    message: "Rider created successfully",
    rider,
  });
});

export const fetchMyProfile = tryCatch(async (req: AuthRequest, res) => {
  const user = req.user;

  if (!user) {
    return res.status(401).json({
      message: "You are not authorized",
    });
  }

  const rider = await Rider.findOne({ userId: user._id });

  if (!rider) {
    return res.status(404).json({
      message: "Rider not found",
    });
  }

  return res.status(200).json({
    message: "Rider found",
    rider,
  });
});

export const toogleRiderAvailablity = tryCatch(
  async (req: AuthRequest, res) => {
    const user = req.user;

    if (!user) {
      return res.status(401).json({
        message: "You are not authorized",
      });
    }

    const { isAvailable, latitude, longitude } = req.body;

    if (typeof isAvailable !== "boolean") {
      return res.status(400).json({
        message: "isAvailable must be a boolean",
      });
    }

    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({
        message: "latitude and longitude are required",
      });
    }

    const rider = await Rider.findOne({ userId: user._id });

    if (!rider) {
      return res.status(404).json({
        message: "Rider not found",
      });
    }

    if (isAvailable && !rider.isVerified) {
      return res.status(400).json({
        message: "Rider is not verified",
      });
    }

    // A rider carrying an active delivery cannot go back online —
    // finish the delivery (or have the seller cancel the order) first.
    if (isAvailable) {
      try {
        const data = await readGet<{ order?: unknown }>(
          `${process.env.RESTAURANT_SERVICE_URL}/api/order/current/rider?riderId=${rider._id}`,
          { headers: getInternalHeaders() },
        );
        if (data?.order) {
          return res.status(400).json({
            message: "Finish your active delivery before going online",
          });
        }
      } catch (error) {
        return res.status(503).json({
          message: "Could not verify your delivery status. Try again.",
        });
      }
    }

    rider.isAvailable = isAvailable;
    rider.location = {
      type: "Point",
      coordinates: [longitude, latitude],
    };
    rider.lastActive = new Date();
    await rider.save();

    return res.status(200).json({
      message: "Rider availablity toggled",
      rider,
    });
  },
);

export const acceptOrder = tryCatch(async (req: AuthRequest, res) => {
  const riderUserId = req.user?._id;
  const { orderId } = req.params;

  if (!riderUserId) {
    return res.status(401).json({
      message: "You are not authorized",
    });
  }

  if (!orderId) {
    return res.status(400).json({
      message: "Order ID is required",
    });
  }

  // ─── Atomic local claim (the only synchronous work) ────────
  // Flipping availability first makes double-clicks impossible at the
  // rider level. The claim also stamps currentOrderId so every later
  // release is a conditional update keyed to THIS order — a stale
  // compensation can never free a rider who already claimed another one.
  // If the order turns out to be gone, the restaurant service's failed
  // assignment publishes rider.order_rejected and the rider event
  // consumer frees this rider again (saga compensation).
  const rider = await Rider.findOneAndUpdate(
    { userId: riderUserId, isAvailable: true },
    { isAvailable: false, lastActive: new Date(), currentOrderId: orderId },
    { new: true },
  );

  if (!rider) {
    return res.status(404).json({
      message: "Rider not found or not available",
    });
  }

  // ─── Publish — with rollback on failure ────────────────────
  // Assignment happens asynchronously: the restaurant service consumes
  // this event, performs the atomic order assignment, and pushes socket
  // updates. But the event MUST reach the broker — if it doesn't, no
  // compensation exists (restaurant never learns of the claim), so we
  // undo the claim right here instead of stranding the rider offline.
  const published = await publishRiderEvent("rider.order_accepted", {
    orderId,
    riderId: rider._id,
    riderUserId: rider.userId,
    // Real name from the auth JWT (picture URL was stored here before —
    // customers don't want a URL as their rider's name).
    riderName:
      (req.user as any)?.name ||
      (req.user as any)?.user?.name ||
      "Delivery Partner",
    riderPhone: rider.phoneNumber,
    // Photo travels separately so the customer app can show an avatar
    riderPicture: rider.picture,
  });

  if (!published) {
    // Conditional rollback: only flips back if this claim still owns the
    // rider (a concurrent release could already have re-enabled them).
    await Rider.findOneAndUpdate(
      {
        _id: rider._id,
        isAvailable: false,
        currentOrderId: orderId,
      },
      { isAvailable: true, currentOrderId: null, lastActive: new Date() },
    );
    return res.status(503).json({
      message: "Could not reach order service — try again",
    });
  }

  return res.status(200).json({ message: "Order accepted" });
});

export const fetchMyCurrentOrder = tryCatch(async (req: AuthRequest, res) => {
  const riderUserId = req.user?._id;

  if (!riderUserId) {
    return res.status(401).json({
      message: "You are not authorized",
    });
  }

  const rider = await Rider.findOne({ userId: riderUserId, isVerified: true });

  if (!rider) {
    return res.status(404).json({
      message: "Rider not found",
    });
  }

  try {
    const data = await readGet<{ order?: unknown }>(
      `${process.env.RESTAURANT_SERVICE_URL}/api/order/current/rider?riderId=${rider._id}`,
      { headers: getInternalHeaders() },
    );

    return res.status(200).json({
      message: "Current order fetched",
      order: data.order,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Error fetching current order",
    });
  }
});

export const fetchMyDeliveryHistory = tryCatch(async (req: AuthRequest, res) => {
  const riderUserId = req.user?._id;

  if (!riderUserId) {
    return res.status(401).json({
      message: "You are not authorized",
    });
  }

  const rider = await Rider.findOne({ userId: riderUserId });

  if (!rider) {
    return res.status(404).json({
      message: "Rider not found",
    });
  }

  try {
    const data = await readGet<{
      count?: number;
      orders?: unknown[];
    }>(
      `${process.env.RESTAURANT_SERVICE_URL}/api/order/history/rider?riderId=${rider._id}`,
      { headers: getInternalHeaders() },
    );

    return res.status(200).json({
      message: "Delivery history fetched",
      count: data.count ?? 0,
      orders: data.orders ?? [],
    });
  } catch (error: any) {
    console.error("Error fetching delivery history:", error?.response?.data || error?.message);
    return res.status(500).json({
      message: "Error fetching delivery history",
    });
  }
});

// Available orders for the rider dashboard — paid orders marked
// ready_for_rider at restaurants within 10km of the rider's last known
// location. Lets a rider who logs in / refreshes *after* the socket
// "order:available" broadcast still see (and accept) the offer.
export const fetchAvailableOrders = tryCatch(async (req: AuthRequest, res) => {
  const riderUserId = req.user?._id;

  if (!riderUserId) {
    return res.status(401).json({
      message: "You are not authorized",
    });
  }

  const rider = await Rider.findOne({ userId: riderUserId });

  if (!rider) {
    return res.status(404).json({
      message: "Rider not found",
    });
  }

  const [longitude, latitude] = rider.location.coordinates;

  try {
    const data = await readGet<{
      count?: number;
      orders?: unknown[];
    }>(
      `${process.env.RESTAURANT_SERVICE_URL}/api/order/ready/rider`,
      {
        params: { latitude, longitude },
        headers: getInternalHeaders(),
      },
    );

    return res.status(200).json({
      message: "Available orders fetched",
      count: data.count ?? 0,
      orders: data.orders ?? [],
    });
  } catch (error: any) {
    console.error(
      "Error fetching available orders:",
      error?.response?.data || error?.message,
    );
    return res.status(500).json({
      message: "Error fetching available orders",
    });
  }
});

export const updateOrderStatus = tryCatch(async (req: AuthRequest, res) => {
  const riderUserId = req.user?._id;

  if (!riderUserId) {
    return res.status(401).json({
      message: "You are not authorized",
    });
  }

  const rider = await Rider.findOne({ userId: riderUserId });

  if (!rider) {
    return res.status(404).json({
      message: "Rider not found",
    });
  }

  const orderId = req.body?.orderId || req.params?.orderId;

  if (!orderId) {
    return res.status(400).json({
      message: "Order ID is required",
    });
  }

  try {
    // Critical pool + breaker: rider payouts flow from status updates;
    // they must never queue behind the non-critical read pool.
    const data = await criticalPut<{
      order?: { status?: string };
    }>(
      `${process.env.RESTAURANT_SERVICE_URL}/api/order/update/status/rider`,
      { orderId },
      { headers: getInternalHeaders() },
    );

    // Delivered → the rider is automatically available again and shows
    // Online. Until then they stay Offline with the delivery in progress.
    // Conditional + clears the claim marker atomically.
    let updatedRider = null;
    if (data.order?.status === "delivered") {
      updatedRider = await Rider.findOneAndUpdate(
        { userId: riderUserId, isAvailable: false, currentOrderId: orderId },
        { isAvailable: true, currentOrderId: null, lastActive: new Date() },
        { new: true },
      );
    }

    return res.status(200).json({
      message: "Order status updated",
      order: data.order,
      rider: updatedRider || rider,
    });
  } catch (error: any) {
    console.error("Error updating order status:", error?.response?.data || error?.message);
    return res.status(500).json({
      message: "Error updating current order",
    });
  }
});

// Called by the restaurant service when an assigned order is cancelled —
// frees the rider so they can go online again.
export const releaseRiderInternal = tryCatch(async (req, res) => {
  if (req.headers["x-internal-key"] !== process.env.INTERNAL_SERVICE_KEY) {
    return res.status(403).json({ message: "Forbidden" });
  }

  const { riderId, orderId } = req.body;

  if (!riderId) {
    return res.status(400).json({ message: "riderId is required" });
  }

  // Conditional release: flips the rider back ONLY if they are still
  // claimed by this order. A stale call (rider already released and
  // re-claimed by another order) matches nothing and is a no-op — it can
  // never free a rider who moved on. All current callers send orderId;
  // the bare-riderId branch only exists as a legacy fallback and keeps
  // the old free-any-offline-rider semantics.
  const rider = await Rider.findOneAndUpdate(
    orderId
      ? { _id: riderId, isAvailable: false, currentOrderId: orderId }
      : { _id: riderId, isAvailable: false },
    { isAvailable: true, currentOrderId: null, lastActive: new Date() },
    { new: true },
  );

  if (!rider) {
    // No match: either the rider doesn't exist, or this release is stale.
    // Both are fine for the caller (idempotent) — report success.
    return res.status(200).json({
      success: true,
      message: "Rider already released or claimed by another order",
    });
  }

  // Rider dashboard learns the assignment fell through — over the fanout
  // exchange, never over HTTP.
  await publishRiderEvent(
    "order:update",
    { orderId: null, status: "cancelled" },
    `user:${rider.userId}`,
  );

  return res.status(200).json({
    success: true,
    message: "Rider released",
  });
});
