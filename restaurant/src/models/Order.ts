import { Schema, Document, model } from "mongoose";

export interface IOrder extends Document {
  userId: string;
  restaurantId: string;
  restaurantName: string;
  restaurantLocation?: {
    latitude: number;
    longitude: number;
  };
  riderId?: string | null;
  riderPhone: number | null;
  riderName: string | null;
  riderPicture?: string | null;
  distance: number;
  riderAmount: number;

  items: {
    itemId: string;
    name: string;
    price: number;
    quauntity: number;
  }[];

  subtotal: number;
  deliveryFee: number;
  platformFee: number;
  totalAmount: number;

  addressId: string;
  deliveryAddress: {
    formattedAddress: string;
    mobile: number;
    latitude: number;
    longitude: number;
  };

  status:
    | "placed"
    | "accepted"
    | "preparing"
    | "ready_for_rider"
    | "rider_assigned"
    | "picked_up"
    | "delivered"
    | "cancelled";

  paymentMethod: "razorpay" | "stripe" | "cod";
  paymentStatus: "pending" | "paid" | "failed";

  expiresAt: Date;
}

const orderSchema = new Schema<IOrder>({
  userId: { type: String, required: true },
  restaurantId: { type: String, required: true },
  restaurantLocation: {
    latitude: { type: Number },
    longitude: { type: Number },
  },
  restaurantName: { type: String, required: true },
  riderId: { type: String, default: null },
  riderName: { type: String, default: null },
  riderPhone: { type: Number, default: null },
  riderAmount: { type: Number, required: true },
  distance: { type: Number, required: true },
  items: [
    {
      itemId: String,
      name: String,
      price: Number,
      quantity: Number,
    },
  ],

  subtotal: Number,
  deliveryFee: Number,
  platformFee: Number,
  totalAmount: Number,

  addressId: {
    type: String,
    required: true,
  },

  deliveryAddress: {
    formattedAddress: { type: String, required: true },
    mobile: { type: Number, required: true },
    latitude: Number,
    longitude: Number,
  },

  status: {
    type: String,
    enum: [
      "placed",
      "accepted",
      "preparing",
      "ready_for_rider",
      "rider_assigned",
      "picked_up",
      "delivered",
      "cancelled",
    ],
    default: "placed"
  },

  paymentMethod: {
    type: String,
    enum: ["razorpay", "stripe", "cod"],
    required: true,
  },

  paymentStatus: {
    type: String,
    enum: ["pending", "paid", "failed"],
    default: "pending",
  },

  expiresAt: {
    type: Date,
    index: {expireAfterSeconds: 0},
  }
},{
    timestamps: true
});

export const Order = model<IOrder>("Order", orderSchema);
