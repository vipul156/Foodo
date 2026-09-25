import { User } from "../models/User.js";

export interface ListUsersParams {
  role?: string;
  limit?: number;
}

export const listUsers = async (params?: ListUsersParams) => {
  const filter = params?.role ? { role: params.role } : {};
  const limit = params?.limit ? Math.min(params.limit, 500) : 500;

  const users = await User.find(filter)
    .select("-password -refreshTokens")
    .sort({ createdAt: -1 })
    .limit(limit);

  return { count: users.length, users };
};

export const getUserStats = async () => {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [total, newThisMonth] = await Promise.all([
    User.countDocuments({}),
    User.countDocuments({ createdAt: { $gte: monthStart } }),
  ]);

  return { total, newThisMonth };
};