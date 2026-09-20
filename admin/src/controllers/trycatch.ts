import { Request, Response, NextFunction, RequestHandler } from "express";

export const tryCatch = (handler: RequestHandler): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await handler(req, res, next);
    } catch (error: any) {
      // Errors from owning services carry their real HTTP status (404 not
      // found, 400 invalid id, 403 forbidden) — keep it; everything else is 500.
      const status =
        typeof error?.status === "number" &&
        error.status >= 400 &&
        error.status < 600
          ? error.status
          : 500;
      return res.status(status).json({ message: error.message });
    }
  };
};
