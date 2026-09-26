import mongoose from "mongoose";

// ─── Shared Mongo connection (mongoose) ──────────────────────
// One connection helper for every service that talks to the shared
// Foodo database (auth, restaurant, rider, admin, utils). Mongoose
// pools connections per-process, and Lambda containers are reused
// across invocations — calling connect() on an already-connected
// state is a cheap no-op, which is what the serverless handlers want.
//
// Import from the "./db" subpath: keeps mongoose out of the package
// root, so middlewares-only consumers never load it.

const connectDB = async () => {
  try {
    // 0 = disconnected. Reconnect attempts on a live connection are
    // skipped so repeated handler invocations don't stack connections.
    if (mongoose.connection.readyState !== 0) {
      return;
    }
    await mongoose.connect(process.env.MONGO_URI!);
    console.log("MongoDB connected");
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
};

export default connectDB;
