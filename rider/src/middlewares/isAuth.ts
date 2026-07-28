import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AuthRequest extends Request {
  user?: jwt.JwtPayload;
  session?: {
    token?: string;
    [key: string]: any;
  };
}

export const isAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
  const token = req.session?.token;
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

export const isSeller = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  const user = req.user;
  if (user && user.role != "seller") {
    return res.status(401).json({
      message: "You are not authorized seller",
    });
    return;
  }
  next();
};

export const isRider = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  const user = req.user;
  if (user && user.role != "rider") {
    return res.status(401).json({
      message: "You are not authorized rider",
    });
    return;
  }
  next();
};
