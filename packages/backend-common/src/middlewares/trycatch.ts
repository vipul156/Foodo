import { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Plain variant — used by restaurant-, rider-, auth-, and utils-service.
 * Any thrown error becomes a 500 JSON response.
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

/**
 * Status-preserving variant — extracted verbatim from admin-service.
 * Errors from owning services carry their real HTTP status (404 not found,
 * 400 invalid id, 403 forbidden) — keep it; everything else is 500.
 */
export const tryCatchStatus =
  (handler: RequestHandler): RequestHandler =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await handler(req, res, next);
    } catch (error: any) {
      const status =
        typeof error?.status === "number" &&
        error.status >= 400 &&
        error.status < 600
          ? error.status
          : 500;
      return res.status(status).json({ message: error.message });
    }
  };
