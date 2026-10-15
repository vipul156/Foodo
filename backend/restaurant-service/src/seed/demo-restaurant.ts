import {
  getUserByEmail,
  getRiderByUserId,
  createRestaurant,
  getRestaurantByOwner,
  updateRestaurantByOwner,
  setRestaurantVerified,
} from "@foodo/backend-common/dynamo";
import {
  createMenuItem,
  listMenuItemsByRestaurant,
} from "../dynamo/cart.js";

// ─── Demo Restaurant + Menu (DynamoDB) ───────────────────────
// Invoked by the auth-service's demo seeder via a Lambda invoke (or run
// once manually) — seeding is not a startup side effect anymore because
// Lambda containers boot per-invocation. Creates a fully verified, open
// restaurant owned by the demo seller account (restaurant@demo.com),
// plus 3 menu items, so the customer app has content.

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

export const seedDemoRestaurant = async (): Promise<void> => {
  try {
    const seller = await getUserByEmail(DEMO_SELLER_EMAIL);
    if (!seller) {
      console.warn(
        "[seed] Demo seller user not found yet — run the auth-service demo seeder first, then seed the restaurant.",
      );
      return;
    }

    // Prefer the demo rider's live location so the 10km matching radius
    // succeeds in the tester's city (same reasoning as the Mongo seeder).
    const demoRiderUser = await getUserByEmail("rider@demo.com");
    const demoRider = demoRiderUser
      ? await getRiderByUserId(demoRiderUser.id)
      : null;

    const riderCoords = demoRider?.location?.coordinates as
      | [number, number]
      | undefined;
    const autoLocation =
      riderCoords && riderCoords.length === 2
        ? snapNearRider(riderCoords)
        : DEFAULT_LOCATION;

    // Upsert by owner — never creates a second restaurant for the seller.
    let restaurant = await getRestaurantByOwner(seller.id);
    if (restaurant) {
      restaurant =
        (await updateRestaurantByOwner(seller.id, {
          name: RESTAURANT_SEED_BASE.name,
          description: RESTAURANT_SEED_BASE.description,
          image: RESTAURANT_SEED_BASE.image,
          phone: RESTAURANT_SEED_BASE.phone,
          isOpen: RESTAURANT_SEED_BASE.isOpen,
        })) ?? restaurant;
      if (!restaurant.isVerified) {
        restaurant = (await setRestaurantVerified(restaurant.id, true)) ?? restaurant;
      }
    } else {
      restaurant = await createRestaurant({
        name: RESTAURANT_SEED_BASE.name,
        description: RESTAURANT_SEED_BASE.description,
        image: RESTAURANT_SEED_BASE.image,
        phone: RESTAURANT_SEED_BASE.phone,
        ownerId: seller.id,
        autoLocation,
      });
      // createRestaurant sets isVerified: false by default, mark verified for demo
      const verified = await setRestaurantVerified(restaurant.id, true);
      if (verified) restaurant = verified;
      if (RESTAURANT_SEED_BASE.isOpen) {
        const opened = await updateRestaurantByOwner(seller.id, { isOpen: true });
        if (opened) restaurant = opened;
      }
    }

    const existing = await listMenuItemsByRestaurant(restaurant.id);
    const existingNames = new Set(existing.map((m) => m.name));

    for (const item of MENU_SEED) {
      if (existingNames.has(item.name)) continue; // idempotent upsert
      await createMenuItem({
        restaurantId: restaurant.id,
        name: item.name,
        description: item.description,
        price: item.price,
        image: item.image,
        category: item.category,
      });
    }

    const menuCount = (await listMenuItemsByRestaurant(restaurant.id)).length;
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
