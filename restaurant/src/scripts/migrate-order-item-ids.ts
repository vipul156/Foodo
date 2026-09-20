// ============================================================
// Foodo — One-time Order items.itemId migration
// Run: npx tsx scripts/migrate-order-item-ids.ts
//
// orders.items.itemId was stored as a 24-char hex STRING; the schema
// now types it as ObjectId (ref MenuItem). ObjectId $in queries do not
// match string-stored values, so historical orders would silently lose
// menu-image enrichment. This script converts every string itemId to a
// real ObjectId in place. Safe to re-run: already-converted docs are
// skipped, and non-hex strings (if any) are left untouched.
// ============================================================

import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error("❌ MONGO_URI is not set in .env");
  process.exit(1);
}

async function migrate() {
  await mongoose.connect(MONGO_URI!);
  console.log("📦 Connected to MongoDB");

  const collection = mongoose.connection.collection("orders");

  // Scan raw docs — schema casting is bypassed deliberately so we can
  // see which itemIds are still stored as strings.
  const orders = await collection.find({}).toArray();

  let fixedOrders = 0;
  let fixedItems = 0;

  for (const order of orders) {
    const items = Array.isArray(order.items) ? order.items : [];
    let changed = false;

    const newItems = items.map((item: any) => {
      if (typeof item?.itemId === "string" && mongoose.isValidObjectId(item.itemId)) {
        changed = true;
        fixedItems++;
        return { ...item, itemId: new mongoose.Types.ObjectId(item.itemId) };
      }
      return item;
    });

    if (changed) {
      await collection.updateOne(
        { _id: order._id },
        { $set: { items: newItems } },
      );
      fixedOrders++;
    }
  }

  console.log(
    `✅ Migration complete: ${fixedOrders} order(s) updated, ${fixedItems} itemId(s) converted.`,
  );
  await mongoose.disconnect();
  console.log("📦 Disconnected from MongoDB");
}

migrate().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
