import type { Request, Response } from "express";
import { tryCatch } from "@foodo/backend-common";
import {
  listRiders as listRidersData,
  verifyRiderById,
  getRiderStats as getRiderStatsData,
} from "@foodo/backend-common/models";

// ─── Internal: Rider endpoints (admin) ──────────────────────
// Thin Express adapters over the shared data functions in
// @foodo/backend-common/models — the same functions admin-service now
// calls directly, so "pending = isVerified:false" can't drift between
// caller and owner.
// GET /api/internal/riders?status=pending|all
export const listRiders = tryCatch(async (req: Request, res: Response) => {
  const data = await listRidersData(req.query.status);
  return res.json(data);
});

// PATCH /api/internal/riders/:id/verify
export const verifyRider = tryCatch(async (req: Request, res: Response) => {
  const { id } = req.params;

  if (typeof id !== "string") {
    return res.status(400).json({ message: "Invalid id" });
  }

  const result = await verifyRiderById(id);
  return res.json(result);
});

// GET /api/internal/riders/stats
export const getRiderStats = tryCatch(async (req: Request, res: Response) => {
  const stats = await getRiderStatsData();
  return res.json(stats);
});
