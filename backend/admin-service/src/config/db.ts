import mongoose from "mongoose";

// ─── Shared Mongo connection ─────────────────────────────────
// Admin now reads/writes the same collections directly, so it needs
// its own connection. Mongoose pools connections per-process, and
// Lambda containers are reused across invocations — calling connect()
// on an already-connected state is a cheap no-op, which is exactly
// what we want in the handler (same pattern as auth's publicHttp).
const connectDB = async () => {
  try {
    if (mongoose.connection.readyState !== 0) {
      return;
    }
    await mongoose.connect(process.env.MONGO_URI!);
    console.log("MongoDB connected (admin-service)");
  } catch (error) {
    console.log(error);
    process.exit(1);
  }
};

export default connectDB;
