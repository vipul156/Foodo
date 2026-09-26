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
    const decode = jwt.verify(jwtToken, process.env.JWT_SECRET!) as any;

    // Normalize user ID across token formats:
    //   - auth service (current): minimal claims { sub, role }
    //   - legacy: { id, ... } or { _id, ... }
    if (decode.sub && !decode._id) {
      decode._id = decode.sub;
    }
    if (decode.id && !decode._id) {
      decode._id = decode.id;
    }
    if (decode._id && !decode.id) {
      decode.id = decode._id;
    }

    req.user = decode as any;
  } catch (err) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
};
