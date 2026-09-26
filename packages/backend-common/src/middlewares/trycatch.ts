import { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Wraps an async express handler so thrown errors reach the error middleware.
 *
 * NOTE: this canonical version returns a 500 JSON response. Several services
 * (admin-service, restaurant-service, rider-service) still ship their own
 * near-identical copies — migrate them here deliberately, one service at a
 * time, only if their behavior truly matches.
 */
export const tryCatch =
  (handler: RequestHandler): RequestHandler =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await handler(req, res, next);
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  };
