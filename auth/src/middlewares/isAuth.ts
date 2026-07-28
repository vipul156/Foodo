import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AuthRequest extends Request {
  user?: string | jwt.JwtPayload;
}

export const isAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
  // Try to get token from session first, then fall back to Authorization header
  let token = req.session?.token;

  if (!token) {
    const authHeader = req.headers["authorization"];
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7);
    }
  }

  if (!token) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  try {
    const decode = jwt.verify(token, process.env.JWT_SECRET!);
    req.user = decode as any;
  } catch (err) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
};
