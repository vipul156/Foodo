import { Schema, Document, model } from "mongoose";

interface IRider extends Document {
  userId: string;
  picture: string;
  phoneNumber: string;
  addharNumber: string;
  drivingLicenseNumber: string;
  isVerified: boolean;
  location: {
    type: "Point";
    coordinates: [number, number];
  };
  isAvailable: boolean;
  lastActive: Date;

  // Saga claim marker — set atomically in the same findOneAndUpdate that
  // flips isAvailable:true→false in acceptOrder. Every release path is a
  // conditional update keyed on this value ("free me ONLY if I'm still
  // holding order X"), so a stale compensation can never free a rider who
  // already claimed a different order.
  currentOrderId: string | null;
}

const riderSchema = new Schema<IRider>(
  {
    userId: { type: String, required: true, unique: true },
    picture: { type: String, required: true },
    phoneNumber: { type: String, required: true, unique: true },
    addharNumber: { type: String, required: true, unique: true },
    drivingLicenseNumber: { type: String, required: true, unique: true },
    isVerified: { type: Boolean, default: false },
    location: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number], required: true },
    },
    isAvailable: { type: Boolean, default: false },
    lastActive: { type: Date, default: Date.now },
    currentOrderId: { type: String, default: null },
  },
  {
    timestamps: true,
  },
);

riderSchema.index({ location: "2dsphere" });
export const Rider = model<IRider>("Rider", riderSchema);
