import {
  getUserByEmail,
  getRiderByUserId,
  createRider,
  setRiderVerified,
  setRiderAvailability,
} from "@foodo/backend-common/dynamo";

// ─── Demo Rider Profile (DynamoDB) ───────────────────────────
// Seeds the rider profile for Vikram Singh (rider@demo.com) so that:
// 1. The demo rider can immediately receive/accept orders.
// 2. The demo restaurant location can snap near the rider.
// 3. The frontend rider portal shows a verified, online rider by default.

const DEMO_RIDER_EMAIL = "rider@demo.com";

const DEMO_RIDER_BASE = {
  phoneNumber: "9876543211",
  addharNumber: "123456789012",
  drivingLicenseNumber: "DL-1420110012345",
  picture: "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=400&q=80",
  location: {
    type: "Point" as const,
    coordinates: [77.2167, 28.6328] as [number, number], // Connaught Place, New Delhi
  },
};

export const seedDemoRider = async (): Promise<void> => {
  try {
    const riderUser = await getUserByEmail(DEMO_RIDER_EMAIL);
    if (!riderUser) {
      console.warn(
        "[seed] Demo rider user not found yet — seed auth demo users first.",
      );
      return;
    }

    let rider = await getRiderByUserId(riderUser.id);
    if (!rider) {
      rider = await createRider({
        userId: riderUser.id,
        picture: DEMO_RIDER_BASE.picture,
        phoneNumber: DEMO_RIDER_BASE.phoneNumber,
        addharNumber: DEMO_RIDER_BASE.addharNumber,
        drivingLicenseNumber: DEMO_RIDER_BASE.drivingLicenseNumber,
        location: DEMO_RIDER_BASE.location,
      });
      console.log(`[seed] Demo rider profile created for ${DEMO_RIDER_EMAIL}`);
    }

    if (!rider.isVerified) {
      const verified = await setRiderVerified(rider.id, true);
      if (verified) rider = verified;
      console.log(`[seed] Demo rider ${DEMO_RIDER_EMAIL} marked as verified.`);
    }

    if (!rider.isAvailable) {
      const online = await setRiderAvailability(
        riderUser.id,
        true,
        DEMO_RIDER_BASE.location.coordinates,
      );
      if (online) rider = online;
      console.log(`[seed] Demo rider ${DEMO_RIDER_EMAIL} set online & available.`);
    }
  } catch (error) {
    console.error("[seed] Demo rider seeding failed:", error);
  }
};
