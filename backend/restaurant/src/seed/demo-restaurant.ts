import mongoose from "mongoose";
import { Restaurant } from "../models/Restaurant.js";
import { MenuItem } from "../models/MenuItem.js";

// ─── Demo Restaurant + Menu ──────────────────────────────────
// Runs on restaurant-service startup. Creates a fully verified,
// open restaurant owned by the demo seller account
// (restaurant@demo.com — seeded by the auth service), plus 3
// menu items with real photos, so the customer app has content.

const DEMO_SELLER_EMAIL = "restaurant@demo.com";

const RESTAURANT_SEED_BASE = {
  name: "Spice Villa",
  description:
    "North Indian kitchen serving buttery curries, smoky tandoori and fresh-baked naan since 1998.",
  image:
    "https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=1200&q=80",
  phone: 9876543210,
  isVerified: true,
  isOpen: true,
};

// Default: Delhi city centre. Overridden at seed time by the demo
// rider's live location so the ~10km rider-matching radius always holds.
const DEFAULT_LOCATION = {
  type: "Point" as const,
  coordinates: [77.2167, 28.6328] as [number, number], // Connaught Place, Delhi
  formattedAddress: "1, Foodo Demo Kitchen, Connaught Place, New Delhi",
};

// ~500m east of the rider so the pairing looks natural on a map
const snapNearRider = (
  coords: [number, number],
): { type: "Point"; coordinates: [number, number]; formattedAddress: string } => ({
  type: "Point",
  coordinates: [coords[0] + 0.005, coords[1]],
  formattedAddress: "Foodo Demo Kitchen (near demo rider)",
});

// Prices in rupees, matching the ₹ formatting used across the frontend
const MENU_SEED = [
  {
    name: "Paneer Butter Masala",
    description:
      "Soft cottage cheese simmered in a rich tomato-cashew gravy with a swirl of cream.",
    price: 249,
    category: "Main Course",
    image:
      "https://images.unsplash.com/photo-1567337710282-00832b415979?w=800&q=80",
    isAvailable: true,
  },
  {
    name: "Tandoori Chicken (Half)",
    description:
      "Overnight-marinated chicken roasted in a clay oven, served with mint chutney.",
    price: 329,
    category: "Tandoor",
    image:
      "https://images.unsplash.com/photo-1601050690597-df0568f70950?w=800&q=80",
    isAvailable: true,
  },
  {
    name: "Garlic Naan",
    description:
      "Hand-stretched naan brushed with garlic butter and coriander, straight from the tandoor.",
    price: 59,
    category: "Breads",
    image:
      "https://images.unsplash.com/photo-1613082410785-22292e8426e7?w=800&q=80",
    isAvailable: true,
  },
];

const upsert = async (
  model: mongoose.Model<any>,
  match: Record<string, unknown>,
  payload: Record<string, unknown>,
) => {
  const existing = await model.findOne(match);
  if (existing) {
    await model.updateOne(match, { $set: payload });
    return model.findOne(match);
  }
  return model.create({ ...match, ...payload });
};

export const seedDemoRestaurant = async (): Promise<void> => {
  try {
    // The auth service creates the seller user; find it here.
    // If auth hasn't run yet, retry on next boot (or when both are up).
    // The User model lives in the auth service, so register a minimal,
    // schemaless local copy just for this lookup.
    const UserModel: mongoose.Model<any> =
      (mongoose.models.User as mongoose.Model<any>) ??
      mongoose.model("User", new mongoose.Schema({}, { strict: false }));
    const seller = await UserModel.findOne({ email: DEMO_SELLER_EMAIL });

    if (!seller) {
      console.warn(
        "[seed] Demo seller user not found yet — start the auth service once, then restart this service to attach the restaurant.",
      );
      return;
    }

    // Prefer the demo rider's live location so "$near" matching in the
    // order-ready consumer (10km radius) succeeds in the tester's city.
    // Look the rider up via the demo rider USER (same identity the rider
    // service seeds) — picking an arbitrary verified rider could snap the
    // restaurant to a stray test rider in another city.
    const UserModel2: mongoose.Model<any> =
      (mongoose.models.User as mongoose.Model<any>) ??
      mongoose.model("User", new mongoose.Schema({}, { strict: false }));
    const demoRiderUser = await UserModel2.findOne({ email: "rider@demo.com" });
    const RiderModel: mongoose.Model<any> =
      (mongoose.models.Rider as mongoose.Model<any>) ??
      mongoose.model("Rider", new mongoose.Schema({}, { strict: false }));
    const demoRider = demoRiderUser
      ? await RiderModel.findOne({ userId: demoRiderUser._id.toString(), isVerified: true })
      : null;

    const riderCoords = demoRider?.location?.coordinates as
      | [number, number]
      | undefined;
    const autoLocation =
      riderCoords && riderCoords.length === 2
        ? snapNearRider(riderCoords)
        : DEFAULT_LOCATION;

    const restaurant = await upsert(
      Restaurant,
      { ownerId: seller._id.toString() },
      { ...RESTAURANT_SEED_BASE, autoLocation },
    );

    for (const item of MENU_SEED) {
      await upsert(MenuItem, { restaurantId: restaurant._id, name: item.name }, item);
    }

    const menuCount = await MenuItem.countDocuments({
      restaurantId: restaurant._id,
    });
    console.log(
      `[seed] Demo restaurant "${RESTAURANT_SEED_BASE.name}" ready with ${menuCount} menu items` +
        (riderCoords
          ? " (located near demo rider)"
          : " (default location — demo rider profile not found)"),
    );
  } catch (error) {
    console.error("[seed] Demo restaurant seeding failed:", error);
  }
};
