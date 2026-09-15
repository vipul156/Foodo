import mongoose from "mongoose";
import { Rider } from "../model/Rider.js";

// ─── Demo Rider Profile ──────────────────────────────────────
// Runs on rider-service startup. Creates a fully onboarded rider
// profile for the demo rider account (rider@demo.com — seeded by
// the auth service): photo, KYC docs, verified, available, live
// location in Bangalore city centre.

const DEMO_RIDER_EMAIL = "rider@demo.com";

const RIDER_SEED = {
  picture:
    "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=400&q=80",
  phoneNumber: "9876500011",
  addharNumber: "4321 8765 1122",
  drivingLicenseNumber: "KA0520190001234",
  isVerified: true,
  isAvailable: true,
  location: {
    type: "Point" as const,
    coordinates: [77.5946, 12.9716] as [number, number], // Bangalore
  },
};

export const seedDemoRider = async (): Promise<void> => {
  try {
    // The User model lives in the auth service, so register a minimal,
    // schemaless local copy just for this lookup.
    const UserModel: mongoose.Model<any> =
      (mongoose.models.User as mongoose.Model<any>) ??
      mongoose.model("User", new mongoose.Schema({}, { strict: false }));
    const riderUser = await UserModel.findOne({ email: DEMO_RIDER_EMAIL });

    if (!riderUser) {
      console.warn(
        "[seed] Demo rider user not found yet — start the auth service once, then restart this service to attach the rider profile.",
      );
      return;
    }

    const userId = riderUser._id.toString();
    const existing = await Rider.findOne({ userId });

    if (existing) {
      // Keep the demo profile in sync (photo, verification, location)
      await Rider.updateOne({ userId }, { $set: RIDER_SEED });
      console.log("[seed] Demo rider profile refreshed (verified & available)");
      return;
    }

    await Rider.create({ userId, ...RIDER_SEED });
    console.log("[seed] Demo rider onboarded: verified, available, Bangalore");
  } catch (error) {
    console.error("[seed] Demo rider seeding failed:", error);
  }
};
