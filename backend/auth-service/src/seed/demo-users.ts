import bcrypt from "bcrypt";
import {
  createUser,
  getUserByEmail,
} from "@foodo/backend-common/dynamo";

// ─── Demo Accounts (DynamoDB) ────────────────────────────────
// Idempotent one-time seeder — run via a Lambda invoke, a script, or a
// custom resource on deploy; Lambda containers must not seed on boot.
// Creates the demo customer/seller/rider users so the frontend "Demo
// Login" quick-login buttons always have real, working credentials.
// Profiles (restaurant/rider records) are seeded by their own services.

const DEMO_USERS = [
  {
    name: "Aarav Sharma",
    email: "customer@demo.com",
    password: "customer123",
    role: "customer" as const,
    image:
      "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=400&q=80",
  },
  {
    name: "Rohit Verma",
    email: "restaurant@demo.com",
    password: "restaurant123",
    role: "seller" as const,
    image:
      "https://images.unsplash.com/photo-1583394293214-28ded15ee548?w=400&q=80",
  },
  {
    name: "Vikram Singh",
    email: "rider@demo.com",
    password: "rider123",
    role: "rider" as const,
    image:
      "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=400&q=80",
  },
];

export const seedDemoUsers = async (): Promise<void> => {
  for (const demo of DEMO_USERS) {
    try {
      const existing = await getUserByEmail(demo.email);
      if (existing) continue; // idempotent — never duplicate demo users

      await createUser({
        name: demo.name,
        email: demo.email,
        password: await bcrypt.hash(demo.password, 10),
        role: demo.role,
        image: demo.image,
      });
      console.log(`[seed] Demo ${demo.role} account ready: ${demo.email}`);
    } catch (error) {
      console.error(`[seed] Failed to seed ${demo.email}:`, error);
    }
  }
};
