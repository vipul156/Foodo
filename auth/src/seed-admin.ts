// ============================================================
// Foodo — Seed Admin Script
// Run: npx tsx src/seed-admin.ts
//
// Creates an admin user directly in MongoDB (bypasses the
// register endpoint which blocks the "admin" role).
// ============================================================

import mongoose from "mongoose";
import bcrypt from "bcrypt";
import dotenv from "dotenv";

dotenv.config();

const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error("❌ MONGO_URI is not set in .env");
  process.exit(1);
}

// ─── User schema (minimal copy — matches auth/src/models/User.ts) ──

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, required: true },
  image: { type: String },
});

userSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  this.password = await bcrypt.hash(this.password, 10);
});

const User = mongoose.model("User", userSchema);

// ─── Seed ─────────────────────────────────────────────────────

async function seedAdmin() {
  await mongoose.connect(MONGO_URI!);
  console.log("📦 Connected to MongoDB");

  // Accept credentials from CLI args, fallback to defaults
  const email = process.argv[2] || "admin@foodo.com";
  const password = process.argv[3] || "admin123";
  const existing = await User.findOne({ email });

  if (existing) {
    console.log(`⚠️  User "${email}" already exists (role: ${existing.role})`);
    await mongoose.disconnect();
    return;
  }

  const user = await User.create({
    name: "Admin",
    email,
    password,
    role: "admin",
  });

  console.log(`✅ Admin user created:`);
  console.log(`   Email:    ${user.email}`);
  console.log(`   Password: ${password}`);
  console.log(`   Role:     ${user.role}`);

  await mongoose.disconnect();
  console.log("📦 Disconnected from MongoDB");
}

seedAdmin().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
