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
    res.status(401).json({ message: "Unauthorized" });
    return;
  }
  try {
    let payload = jwt.verify(jwtToken, process.env.JWT_SECRET!) as any;

    // Handle nested user object format: { user: { id, email, role } }
    if (payload.user) {
      payload = payload.user;
    }

    // Normalize user ID across token formats:
    //   - auth service (current): minimal claims { sub, role }
    //   - legacy: { id, ... } or { _id, ... }
    if (payload.sub && !payload._id) {
      payload._id = payload.sub;
    }
    if (payload.id && !payload._id) {
      payload._id = payload.id;
    }
    if (payload._id && !payload.id) {
      payload.id = payload._id;
    }

    req.user = payload;
  } catch (err) {
    res.status(401).json({ message: "Unauthorized" });
    return;
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
    res.status(401).json({
      message: "You are not authorized",
    });
    return;
  }
  next();
};
