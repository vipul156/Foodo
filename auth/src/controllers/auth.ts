import { User } from "../models/User.js";
import { tryCatch } from "../middlewares/trycatch.js";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import { AuthRequest } from "../middlewares/isAuth.js";

const allowedRoles = ["customer", "rider", "seller"] as const;
type Role = (typeof allowedRoles)[number];

export const registerUser = tryCatch(async (req, res) => {
  const { name, email, password, role, image } = req.body;
  if (!allowedRoles.includes(role))
    return res.status(400).json({ message: "Invalid role" });
  let user = await User.findOne({ email });
  if (!user) {
    user = await User.create({ name, email, password, role, image });
    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role },
      process.env.JWT_SECRET!,
      { expiresIn: "7d" },
    );
    req.session = { jwt: token };
    return res.status(201).json({ message: "User created successfully", user, token });
  } else {
    return res.status(400).json({ message: "User already exists" });
  }
});

export const loginUser = tryCatch(async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });
  if (!user) {
    return res.status(400).json({ message: "User not found" });
  } else {
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(400).json({ message: "Invalid password" });
    } else {
      const token = jwt.sign(
        { id: user._id, email: user.email, role: user.role },
        process.env.JWT_SECRET!,
        { expiresIn: "7d" },
      );
      req.session = { jwt: token };
      return res.status(200).json({ message: "User logged in successfully", user, token });
    }
  }
});

export const getUser = tryCatch(async (req: AuthRequest, res) => {
  const user = req.user;
  return res.status(200).json({ message: "User fetched successfully", user });
});

export const logoutUser = tryCatch(async (req, res) => {
  // Clear the session cookie — cookieSession sets it to null to delete it
  req.session = null;
  return res.status(200).json({ message: "Logged out successfully" });
});
