import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AuthRequest extends Request {
  user?: jwt.JwtPayload;
  session?: {
    jwt?: string;
    [key: string]: any;
  };
}

export const isAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
  const jwtToken = req.session?.jwt;
  if (!jwtToken) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  try {
    const decode = jwt.verify(jwtToken, process.env.JWT_SECRET!);
    req.user = decode as any;
  } catch (err) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
};

export const isAdmin = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  const user = req.user;
  if (user && user.role !== "admin") {
    return res.status(401).json({
      message: "You are not authorized",
    });
    return;
  }
  next();
};
