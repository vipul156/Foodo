import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AuthRequest extends Request {
  user?: jwt.JwtPayload;
  session?: {
    jwt?: string;
    [key: string]: any;
  } | null | undefined;
}

export const isAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
  const jwtToken = req.session?.jwt;
  if (!jwtToken) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  try {
    let payload = jwt.verify(jwtToken, process.env.JWT_SECRET!) as any;

    // Handle nested user object format: { user: { id, email, role, restaurantId } }
    // This happens when getMyRestaurant re-signs the JWT with a nested user.
    if (payload.user) {
      payload = payload.user;
    }

    // Normalize user ID: auth service JWT uses 'id' (not '_id')
    if (payload.id && !payload._id) {
      payload._id = payload.id;
    }
    if (payload._id && !payload.id) {
      payload.id = payload._id;
    }

    req.user = payload;
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
