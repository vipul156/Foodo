import { Request, Response, NextFunction, RequestHandler } from "express";

// ─── Async error boundary ────────────────────────────────────
// A handler must never leave the caller with a silent 500: the log
// line is what an operator has to work with when a verdict never
// reaches the kitchen. The response body stays generic — internal
// AWS/DynamoDB messages are not part of the API contract — while the
// full error (with stack) goes to CloudWatch.

export const tryCatch = (handler: RequestHandler): RequestHandler => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await handler(req, res, next);
    } catch (error: any) {
      console.error(
        `[verification] ${req.method} ${req.originalUrl ?? req.path} failed:`,
        error,
      );
      return res.status(500).json({
        code: "VERIFICATION_INTERNAL",
        message: "Verification could not be completed",
      });
    }
  };
};
