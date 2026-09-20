import type { Request, Response } from "express";
import { tryCatch } from "../middlewares/trycatch.js";
import { User } from "../models/User.js";

// ─── Internal: List Users (admin) ───────────────────────────
// The admin service reads users through this endpoint instead of querying
// the users collection raw — credentials never leave this service.
// GET /api/internal/users?role=customer|seller|rider|admin
export const listUsers = tryCatch(async (req: Request, res: Response) => {
  const role = typeof req.query.role === "string" ? req.query.role : undefined;
  const filter = role ? { role } : {};

  const users = await User.find(filter)
    .select("-password -token")
    .sort({ createdAt: -1 })
    .limit(500);

  return res.json({ count: users.length, users });
});

// ─── Internal: User Stats (admin analytics) ─────────────────
// GET /api/internal/users/stats
export const getUserStats = tryCatch(async (req: Request, res: Response) => {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [total, newThisMonth] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments({ createdAt: { $gte: monthStart } }),
  ]);

  return res.json({ total, newThisMonth });
});
