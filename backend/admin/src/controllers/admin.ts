import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { tryCatch } from "../lib/trycatch.js";

const lambda = new LambdaClient({ region: process.env.AWS_REGION || "ap-south-1" });

// Function Names from Environment Variables
const AUTH_LAMBDA = process.env.AUTH_INTERNAL_LAMBDA_NAME || "auth-service-internalWorker";
const RESTAURANT_LAMBDA = process.env.RESTAURANT_INTERNAL_LAMBDA_NAME || "restaurant-service-internalWorker";
const RIDER_LAMBDA = process.env.RIDER_INTERNAL_LAMBDA_NAME || "rider-service-internalWorker";

// ─── Generic Lambda Invocation Helper ───────────────────────
async function invokeLambda<TResponse>(
  functionName: string,
  action: string,
  payload: Record<string, unknown> = {}
): Promise<TResponse> {
  const command = new InvokeCommand({
    FunctionName: functionName,
    Payload: Buffer.from(JSON.stringify({ action, payload })),
  });

  const response = await lambda.send(command);

  if (!response.Payload) {
    throw new Error(`Empty payload returned from Lambda: ${functionName}`);
  }

  const resultString = Buffer.from(response.Payload).toString("utf-8");
  const parsed = JSON.parse(resultString);

  // If the target Lambda threw an uncaught error, bubble it up
  if (response.FunctionError) {
    throw new Error(parsed.errorMessage || `Lambda invocation failed for ${functionName}`);
  }

  return parsed as TResponse;
}

// ─── Pending Restaurants ────────────────────────────────────
export const getPendingRestaurants = tryCatch(async (req, res) => {
  const data = await invokeLambda<{
    count: number;
    restaurants: unknown[];
  }>(RESTAURANT_LAMBDA, "LIST_RESTAURANTS", { status: "pending" });

  res.json({
    count: data.count,
    restaurants: data.restaurants,
  });
});

// ─── All Restaurants ────────────────────────────────────────
export const getAllRestaurants = tryCatch(async (req, res) => {
  const data = await invokeLambda<{
    count: number;
    restaurants: unknown[];
  }>(RESTAURANT_LAMBDA, "LIST_RESTAURANTS");

  res.json({
    count: data.count,
    restaurants: data.restaurants,
  });
});

// ─── Pending Riders ─────────────────────────────────────────
export const getPendingRiders = tryCatch(async (req, res) => {
  const data = await invokeLambda<{
    count: number;
    riders: unknown[];
  }>(RIDER_LAMBDA, "LIST_RIDERS", { status: "pending" });

  res.json({
    count: data.count,
    riders: data.riders,
  });
});

// ─── All Riders ─────────────────────────────────────────────
export const getAllRiders = tryCatch(async (req, res) => {
  const data = await invokeLambda<{
    count: number;
    riders: unknown[];
  }>(RIDER_LAMBDA, "LIST_RIDERS");

  res.json({
    count: data.count,
    riders: data.riders,
  });
});

// ─── Users ──────────────────────────────────────────────────
export const getAllUsers = tryCatch(async (req, res) => {
  const role = req.query.role as string | undefined;

  const data = await invokeLambda<{
    count: number;
    users: unknown[];
  }>(AUTH_LAMBDA, "LIST_USERS", { role });

  res.json({
    count: data.count,
    users: data.users,
  });
});

// ─── Verification (Writes) ──────────────────────────────────
export const verifyRestaurant = tryCatch(async (req, res) => {
  const { id } = req.params;

  if (typeof id !== "string") {
    throw new Error("Invalid id");
  }

  await invokeLambda(RESTAURANT_LAMBDA, "VERIFY_RESTAURANT", { id });

  res.json({ message: "Restaurant verified" });
});

export const verifyRider = tryCatch(async (req, res) => {
  const { id } = req.params;

  if (typeof id !== "string") {
    throw new Error("Invalid id");
  }

  await invokeLambda(RIDER_LAMBDA, "VERIFY_RIDER", { id });

  res.json({ message: "Rider verified" });
});

// ─── Platform Stats (Parallel Aggregation) ──────────────────
export const getPlatformStats = tryCatch(async (req, res) => {
  const [users, restaurants, riders, orders] = await Promise.all([
    invokeLambda<{ total: number; newThisMonth: number }>(
      AUTH_LAMBDA,
      "GET_USER_STATS"
    ),
    invokeLambda<{
      total: number;
      verified: number;
      open: number;
      pending: number;
    }>(RESTAURANT_LAMBDA, "GET_RESTAURANT_STATS"),
    invokeLambda<{
      total: number;
      verified: number;
      online: number;
      pending: number;
    }>(RIDER_LAMBDA, "GET_RIDER_STATS"),
    invokeLambda<{
      total: number;
      delivered: number;
      cancelled: number;
      active: number;
      revenue: { total: number; thisMonth: number };
      daily: { date: string; revenue: number; orders: number }[];
      topRestaurants: { name: string; revenue: number; orders: number }[];
    }>(RESTAURANT_LAMBDA, "GET_ORDER_STATS"),
  ]);

  res.json({
    users,
    restaurants,
    riders,
    orders: {
      total: orders.total,
      delivered: orders.delivered,
      cancelled: orders.cancelled,
      active: orders.active,
    },
    revenue: {
      total: orders.revenue.total,
      thisMonth: orders.revenue.thisMonth,
      monthChange: null,
    },
    daily: orders.daily,
    topRestaurants: orders.topRestaurants,
  });
});