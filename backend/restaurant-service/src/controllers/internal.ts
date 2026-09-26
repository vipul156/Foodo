import type { Request, Response } from "express";
import { tryCatch } from "@foodo/backend-common";
import {
  listRestaurants as listRestaurantsData,
  verifyRestaurantById,
  getRestaurantStats as getRestaurantStatsData,
  getOrderStats as getOrderStatsData,
} from "@foodo/backend-common/models";

// ─── Internal: Restaurant + Order endpoints (admin) ─────────
// Thin Express adapters over the shared data functions in
// @foodo/backend-common/models — the same functions admin-service now
// calls directly, so "pending = isVerified:false" can't drift between
// caller and owner.

// GET /api/internal/restaurants?status=pending|all
export const listRestaurants = tryCatch(async (req: Request, res: Response) => {
  const data = await listRestaurantsData(req.query.status);
  return res.json(data);
});

// PATCH /api/internal/restaurants/:id/verify
export const verifyRestaurant = tryCatch(async (req: Request, res: Response) => {
  const { id } = req.params;

  if (typeof id !== "string") {
    return res.status(400).json({ message: "Invalid id" });
  }

  const result = await verifyRestaurantById(id);
  return res.json(result);
});

// GET /api/internal/restaurants/stats
export const getRestaurantStats = tryCatch(
  async (req: Request, res: Response) => {
    const stats = await getRestaurantStatsData();
    return res.json(stats);
  },
);

// GET /api/internal/orders/stats
export const getOrderStats = tryCatch(async (req: Request, res: Response) => {
  const stats = await getOrderStatsData();
  return res.json(stats);
});
