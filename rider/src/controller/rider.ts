import { dataUri } from "../config/dataUri.js";
import { AuthRequest } from "../middlewares/isAuth.js";
import { tryCatch } from "../middlewares/trycatch.js";
import { Rider } from "../model/Rider.js";
import axios from "axios";

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

  const { data } = await axios.post(
    `${process.env.UTILS_SERVICE_URL}/api/utils/upload`,
    {
      buffer: fileBuffer.content,
    },
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

  const rider = await Rider.findOne({ userId: riderUserId, isAvailable: true });

  if (!rider) {
    return res.status(404).json({
      message: "Rider not found",
    });
  }

  try {
    const { data } = await axios.put(
      `${process.env.RESTAURANT_SERVICE_URL}/api/order/assign/rider`,
      {
        riderId: rider._id,
        orderId,
        riderUserId: rider.userId,
        riderName: rider.picture,
        riderPhone: rider.phoneNumber,
      },
      {
        headers: {
          "x-internal-key": process.env.INTERNAL_SERVICE_KEY,
        },
      },
    );

    if (data.success) {
      const riderDetails = await Rider.findOneAndUpdate(
        {
          userId: riderUserId,
          isAvailable: true,
        },
        {
          isAvailable: false,
        },
        {
          new: true,
        },
      );

      res.json({ message: "Order accepted" });
    }
  } catch (error) {
    return res.status(500).json({
      message: "Error accepting order",
      error,
    });
  }
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
    const { data } = await axios.get(
      `${process.env.RESTAURANT_SERVICE_URL}/api/order/current/rider?riderId=${rider._id}`,
      {
        headers: {
          "x-internal-key": process.env.INTERNAL_SERVICE_KEY,
        },
      },
    );

    return res.status(200).json({
      message: "Current order fetched",
      order: data.order,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Error fetching current order",
      error,
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

  const { orderId } = req.params;

  try {
    const { data } = await axios.put(
      `${process.env.RESTAURANT_SERVICE_URL}/api/order/update/status/rider`,
      {
       orderId
      },
      {
        headers: {
          "x-internal-key": process.env.INTERNAL_SERVICE_KEY,
        },
      },
    );

    return res.status(200).json({
      message: "Order status updated",
      order: data.order,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Error updating order status",
      error,
    });
  }
});
