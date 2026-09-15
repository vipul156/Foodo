import { User } from "../models/User.js";

// ─── Demo Accounts ───────────────────────────────────────────
// Created automatically on first boot so the frontend "Demo Login"
// quick-login buttons always have real, working credentials.
// Profiles include photos; the seller/rider records themselves are
// seeded by their own services (restaurant + rider seeders).

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
      const existing = await User.findOne({ email: demo.email });
      if (existing) {
        // Keep the profile photo in sync with the seed definition
        if (existing.image !== demo.image) {
          existing.image = demo.image;
          await existing.save();
        }
        continue;
      }

      // Password is hashed by the pre-save hook on the User model
      await User.create(demo);
      console.log(`[seed] Demo ${demo.role} account ready: ${demo.email}`);
    } catch (error) {
      console.error(`[seed] Failed to seed ${demo.email}:`, error);
    }
  }
};
