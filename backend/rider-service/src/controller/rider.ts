import { AuthRequest, tryCatch } from "@foodo/backend-common";
import { dataUri } from "@foodo/backend-common/files";
import { uploadToCloudinary } from "@foodo/backend-common/cloudinary";
import {
  createRider,
  claimRiderForOrder,
  releaseRiderFromOrder,
  getRiderById,
  getRiderByUserId,
  setRiderAvailability,
  listDeliveredOrdersByRider,
  findCurrentOrderForRider,
  listReadyOrders,
  listRestaurantsNear,
} from "@foodo/backend-common/dynamo";
import { publishRiderEvent } from "../config/events.js";

export const createRiderController = tryCatch(async (req: AuthRequest, res) => {
  const user = req.user;

  if (!user) {
    return res.status(401).json({
      message: "You are not authorized",
    });
  }

  const file = req.file;

  // Preferred flow (direct upload): the rider app already uploaded the
  // photo straight to Cloudinary with signed params and passes the URL.
  // Legacy fallback: multipart `file` → server-side upload via the
  // shared signer (older clients keep working).
  const imageUrl = req.body?.imageUrl as string | undefined;
  if (!file && !imageUrl) {
    return res.status(400).json({
      message: "File is required",
    });
  }

  let pictureUrl: string;
  if (imageUrl && typeof imageUrl === "string") {
    pictureUrl = imageUrl;
  } else {
    const fileBuffer = dataUri(file!);

    if (!fileBuffer?.content) {
      return res.status(400).json({
        message: "File is not valid",
      });
    }

    pictureUrl = await uploadToCloudinary({
      fileContent: fileBuffer.content,
      folder: "foodo/riders/kyc",
      tags: ["foodo", "rider", "kyc"],
    });
  }

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

  const existingRider = await getRiderByUserId(String(user._id));
  if (existingRider) {
    return res.status(400).json({
      message: "Rider already exists",
    });
  }

  const rider = await createRider({
    phoneNumber,
    addharNumber,
    drivingLicenseNumber,
    location: {
      type: "Point",
      coordinates: [Number(longitude), Number(latitude)],
    },
    userId: String(user._id),
    picture: pictureUrl,
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

  const rider = await getRiderByUserId(String(user._id));
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

    const rider = await getRiderByUserId(String(user._id));
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
        const order = await findCurrentOrderForRider(rider.id);
        if (order) {
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

    const updated = await setRiderAvailability(
      String(user._id),
      isAvailable,
      [Number(longitude), Number(latitude)],
    );

    return res.status(200).json({
      message: "Rider availablity toggled",
      rider: updated,
    });
  },
);

export const acceptOrder = tryCatch(async (req: AuthRequest, res) => {
  const riderUserId = req.user?._id;
  const orderId = req.params.orderId as string;

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
  // rider level; currentOrderId makes every later release conditional.
  const rider = await claimRiderForOrder(String(riderUserId), orderId);

  if (!rider) {
    return res.status(404).json({
      message: "Rider not found or not available",
    });
  }

  // ─── Publish — with rollback on failure ────────────────────
  // The event MUST reach the bus: if it doesn't, no compensation exists
  // (restaurant never learns of the claim), so we undo the claim right
  // here instead of stranding the rider offline.
  const published = await publishRiderEvent("rider.order_accepted", {
    orderId,
    riderId: rider.id,
    riderUserId: rider.userId,
    // Real name from the auth JWT (picture URL was stored here before).
    riderName:
      (req.user as any)?.name ||
      (req.user as any)?.user?.name ||
      "Delivery Partner",
    riderPhone: rider.phoneNumber,
    riderPicture: rider.picture,
  });

  if (!published) {
    // Conditional rollback: only flips back if this claim still owns the
    // rider (a concurrent release could already have re-enabled them).
    await releaseRiderFromOrder(
      rider.id,
      orderId,
      { orderId: null, status: "cancelled" },
      async () => {},
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

  const rider = await getRiderByUserId(String(riderUserId));
  if (!rider) {
    return res.status(404).json({
      message: "Rider not found",
    });
  }

  try {
    const order = await findCurrentOrderForRider(rider.id);

    return res.status(200).json({
      message: "Current order fetched",
      order,
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

  const rider = await getRiderByUserId(String(riderUserId));
  if (!rider) {
    return res.status(404).json({
      message: "Rider not found",
    });
  }

  try {
    const orders = await listDeliveredOrdersByRider(rider.id);

    return res.status(200).json({
      message: "Delivery history fetched",
      count: orders.length,
      orders,
    });
  } catch (error: any) {
    console.error("Error fetching delivery history:", error?.message);
    return res.status(500).json({
      message: "Error fetching delivery history",
    });
  }
});

// Available orders for the rider dashboard — paid, ready_for_rider
// orders at restaurants within 10km of the rider's last known location.
export const fetchAvailableOrders = tryCatch(async (req: AuthRequest, res) => {
  const riderUserId = req.user?._id;

  if (!riderUserId) {
    return res.status(401).json({
      message: "You are not authorized",
    });
  }

  const rider = await getRiderByUserId(String(riderUserId));
  if (!rider) {
    return res.status(404).json({
      message: "Rider not found",
    });
  }

  const [longitude, latitude] = rider.location.coordinates;

  try {
    // Nearby restaurants (geo bounding box + haversine), then filter the
    // ready-for-rider board to those restaurants — the $near + $in pair.
    const nearbyRestaurants = await listRestaurantsNear(
      latitude,
      longitude,
      10_000,
    );
    const nearbyIds = new Set(nearbyRestaurants.map((r) => r.id));

    const readyOrders = await listReadyOrders(200);
    const orders = readyOrders.filter((o) => nearbyIds.has(o.restaurantId));

    return res.status(200).json({
      message: "Available orders fetched",
      count: orders.length,
      orders,
    });
  } catch (error: any) {
    console.error("Error fetching available orders:", error?.message);
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

  const rider = await getRiderByUserId(String(riderUserId));
  if (!rider) {
    return res.status(404).json({
      message: "Rider not found",
    });
  }

  const orderId = (req.body?.orderId || req.params?.orderId) as string;

  if (!orderId) {
    return res.status(400).json({
      message: "Order ID is required",
    });
  }

  // ─── Publish the intent; the order owner applies the transition ──
  // Riders live on flaky mobile networks — the event carries the rider
  // id so the owner's consumer binds the transition to THIS rider.
  // Publish failure returns 503 so the app can retry; the claim is NOT
  // rolled back (nothing was rejected; the delivery is still real).
  const published = await publishRiderEvent("rider.order_status_changed", {
    orderId,
    riderId: rider.id,
  });

  if (!published) {
    return res.status(503).json({
      message: "Could not reach order service — try again",
    });
  }

  return res.status(202).json({
    message: "Order status update queued",
    orderId,
  });
});
