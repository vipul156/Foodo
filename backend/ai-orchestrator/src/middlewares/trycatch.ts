import { Request, Response, NextFunction, RequestHandler } from "express";

export const tryCatch = (handler: RequestHandler): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await handler(req, res, next);
    } catch (error: any) {
      return res.status(500).json({ message: error.message });
    }
  };
};
