import { Types } from "mongoose";
import type { Request, Response } from "express";
import { tryCatch } from "../middlewares/trycatch.js";
import { Rider } from "../model/Rider.js";

// ─── Internal: List Riders (admin) ──────────────────────────
// The admin service reads riders through this endpoint instead of querying
// the collections raw. "Pending" is defined HERE, in the service that owns
// riders, so the rule can't drift elsewhere.
// GET /api/internal/riders?status=pending|all
export const listRiders = tryCatch(async (req: Request, res: Response) => {
  const status = req.query.status;

  if (status === "pending") {
    const riders = await Rider.find({ isVerified: false });
    return res.json({ count: riders.length, riders });
  }

  // Online first, then verified — for the admin roster view.
  const riders = await Rider.find({}).sort({ isAvailable: -1, isVerified: -1 });
  return res.json({ count: riders.length, riders });
});

// ─── Internal: Verify a Rider (admin) ───────────────────────
// Verification is a mutation on this service's data, so it lives here.
// PATCH /api/internal/riders/:id/verify
export const verifyRider = tryCatch(async (req: Request, res: Response) => {
  const { id } = req.params;

  if (typeof id !== "string") {
    return res.status(400).json({ message: "Invalid id" });
  }

  if (!Types.ObjectId.isValid(id)) {
    return res.status(400).json({ message: "Invalid id" });
  }

  const rider = await Rider.findByIdAndUpdate(
    id,
    { isVerified: true },
    { new: true },
  );

  if (!rider) {
    return res.status(404).json({ message: "Rider not found" });
  }

  return res.json({ message: "Rider verified", rider });
});

// ─── Internal: Rider Stats (admin analytics) ────────────────
// GET /api/internal/riders/stats
export const getRiderStats = tryCatch(async (req: Request, res: Response) => {
  const [total, verified, online] = await Promise.all([
    Rider.countDocuments({}),
    Rider.countDocuments({ isVerified: true }),
    Rider.countDocuments({ isAvailable: true, isVerified: true }),
  ]);

  return res.json({ total, verified, online, pending: total - verified });
});
