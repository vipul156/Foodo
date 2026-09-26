import mongoose, { Schema, model, type Document, type Model } from "mongoose";

// ─── Restaurant model (shared) ───────────────────────────────
// Owner: restaurant-service. Admin reads restaurants through the
// shared schema.

export interface IRestaurant extends Document {
  name: string;
  description: string;
  image: string;
  ownerId: string;
  phone: number;
  isVerified: boolean;

  autoLocation: {
    type: "Point";
    coordinates: [number, number];
    formattedAddress: string;
  };
  isOpen: boolean;
}

export const restaurantSchema = new Schema<IRestaurant>(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String },
    image: { type: String },
    ownerId: { type: String, required: true },
    phone: { type: Number, required: true },
    isVerified: { type: Boolean, default: false },
    autoLocation: {
      type: { type: String, enum: ["Point"], required: true },
      coordinates: { type: [Number], required: true },
      formattedAddress: { type: String, required: true },
    },
    isOpen: { type: Boolean, default: false },
  },
  {
    timestamps: true,
  },
);

restaurantSchema.index({ autoLocation: "2dsphere" });

// Reuse an existing registration (hot-reload / multi-entry bundles)
// before defining through the shared schema — mongoose throws
// OverwriteModelError on a second registration of the same name.
export const Restaurant: Model<IRestaurant> =
  (mongoose.models.Restaurant as Model<IRestaurant> | undefined) ??
  model<IRestaurant>("Restaurant", restaurantSchema);
