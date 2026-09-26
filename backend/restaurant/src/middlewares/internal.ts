import { Request, Response, NextFunction } from "express";

// Internal endpoints are for service-to-service calls only. They trust the
// shared INTERNAL_SERVICE_KEY header — never user JWTs or cookies.
export const isInternal = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (req.headers["x-internal-key"] !== process.env.INTERNAL_SERVICE_KEY) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  next();
};
