import { randomUUID } from "crypto";
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  DeleteCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { docClient, TABLE } from "../aws/dynamodb.js";

// ─── Order repository (DynamoDB) ─────────────────────────────
// Replaces the shared mongoose Order model.
//
//   PK: ORDER#<orderId>                SK: ORDER
//   GSI-1 user-orders:        PK=userId        SK=createdAt
//   GSI-2 restaurant-orders:  PK=restaurantId  SK=createdAt
//   GSI-3 rider-orders:       PK=riderId       SK=createdAt
//   GSI-4 status-board:       PK=status        SK=createdAt  (rider matching)
//
// Mongo TTL on expiresAt → DynamoDB TTL attribute on unpaid orders only
// (the TTL marker is removed exactly when the payment consumer clears it,
// preserving the old "$unset: expiresAt" semantics).

import type { OrderStatus, PaymentMethod, PaymentStatus } from "@foodo/types";

export interface DynamoOrderItem {
  itemId: string;
  name: string;
  price: number;
  quantity: number;
}

export interface DynamoOrder {
  pk: string;
  sk: string;
  id: string;
  userId: string;
  restaurantId: string;
  restaurantName: string;
  restaurantLocation?: { latitude: number; longitude: number };
  riderId?: string | null;
  riderPhone?: number | string | null;
  riderName?: string | null;
  riderPicture?: string | null;
  distance: number;
  riderAmount: number;

  items: DynamoOrderItem[];

  subtotal: number;
  deliveryFee: number;
  platformFee: number;
  totalAmount: number;

  addressId: string;
  deliveryAddress: {
    formattedAddress: string;
    mobile: number | string;
    latitude: number;
    longitude: number;
  };

  status: OrderStatus;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;

  paymentIntent?: {
    provider: "razorpay" | "stripe";
    providerOrderId?: string;
    initiatedAt?: string;
  };

  /** ISO timestamp; DynamoDB TTL sweeps unpaid expired orders. */
  expiresAt?: string;
  ttl?: number;

  createdAt: string;
  updatedAt: string;
}

export const orderPk = (id: string) => `ORDER#${id}`;
export const ORDER_SK = "ORDER";

/** paymentIntent.initiatedAt, projected flat for the payment-status GSI. */
export const paymentIntentInitiatedAt = (o: DynamoOrder): string | undefined =>
  o.paymentIntent?.initiatedAt;

// Legacy callers pass Mongo ObjectIds; Dynamo ids are UUIDs. Kept as a
// format guard so a stale Mongo id fails loudly instead of silently
// returning "not found" (which the saga would misread as "expired").
export const isValidOrderId = (id: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
  /^[0-9a-f]{24}$/i.test(id);

// ─── Reads ───────────────────────────────────────────────────

export async function getOrderById(
  id: string,
): Promise<DynamoOrder | null> {
  const out = await docClient().send(
    new GetCommand({
      TableName: TABLE.orders(),
      Key: { pk: orderPk(id), sk: ORDER_SK },
    }),
  );
  return (out.Item as DynamoOrder | undefined) ?? null;
}

/** getMyOrders: paid orders of one user, newest first. */
export async function listOrdersByUser(
  userId: string,
  limit = 50,
): Promise<DynamoOrder[]> {
  const out = await docClient().send(
    new QueryCommand({
      TableName: TABLE.orders(),
      IndexName: "user-orders",
      KeyConditionExpression: "userId = :u",
      // paymentStatus is the GSI sort-key prefix guard: paid rows only
      FilterExpression: "paymentStatus = :paid",
      ExpressionAttributeValues: { ":u": userId, ":paid": "paid" },
      ScanIndexForward: false, // createdAt desc
      Limit: limit,
    }),
  );
  return (out.Items as DynamoOrder[]) ?? [];
}

/**
 * fetchRestaurantOrders: keyset-paginated paid orders of one restaurant,
 * newest first. Cursor = "createdAt|id" (same wire contract as the Mongo
 * version); ties on createdAt break on id so pages never overlap.
 */
export async function listOrdersByRestaurant(
  restaurantId: string,
  opts: { limit?: number; cursor?: string | null } = {},
): Promise<{ orders: DynamoOrder[]; nextCursor: string | null }> {
  const limit = opts.limit ?? 50;

  let exclusiveStart: Record<string, unknown> | undefined;
  if (opts.cursor) {
    const [ts, id] = opts.cursor.split("|");
    if (ts && id) {
      // ExclusiveStartKey must be a full key of the INDEX being queried
      // (GSI keys are projected attribute values, not table keys).
      exclusiveStart = { restaurantId, createdAt: ts, id };
    }
  }

  const out = await docClient().send(
    new QueryCommand({
      TableName: TABLE.orders(),
      IndexName: "restaurant-orders",
      KeyConditionExpression: "restaurantId = :r",
      FilterExpression: "paymentStatus = :paid",
      ExpressionAttributeValues: { ":r": restaurantId, ":paid": "paid" },
      ScanIndexForward: false,
      Limit: limit + 1, // one extra row detects a next page, no count query
      ...(exclusiveStart && { ExclusiveStartKey: exclusiveStart }),
    }),
  );

  const items = (out.Items as DynamoOrder[]) ?? [];
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  const last = page[page.length - 1];

  return {
    orders: page,
    nextCursor:
      hasMore && last ? `${last.createdAt}|${last.id}` : null,
  };
}

/** Rider history: delivered + paid orders, newest first. */
export async function listDeliveredOrdersByRider(
  riderId: string,
  limit = 50,
): Promise<DynamoOrder[]> {
  const out = await docClient().send(
    new QueryCommand({
      TableName: TABLE.orders(),
      IndexName: "rider-orders",
      KeyConditionExpression: "riderId = :r",
      FilterExpression: "paymentStatus = :paid AND #s = :delivered",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":r": riderId,
        ":paid": "paid",
        ":delivered": "delivered",
      },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (out.Items as DynamoOrder[]) ?? [];
}

/** Rider's active delivery: any status but delivered, newest first. */
export async function findCurrentOrderForRider(
  riderId: string,
): Promise<DynamoOrder | null> {
  const out = await docClient().send(
    new QueryCommand({
      TableName: TABLE.orders(),
      IndexName: "rider-orders",
      KeyConditionExpression: "riderId = :r",
      FilterExpression: "#s <> :delivered",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":r": riderId, ":delivered": "delivered" },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  return (out.Items?.[0] as DynamoOrder | undefined) ?? null;
}

/**
 * getReadyOrdersNearRider + the matcher: paid + ready_for_rider across
 * ALL restaurants. On Mongo this was a status index scan; here the
 * status-board GSI serves it directly.
 */
export async function listReadyOrders(limit = 100): Promise<DynamoOrder[]> {
  const out = await docClient().send(
    new QueryCommand({
      TableName: TABLE.orders(),
      IndexName: "status-board",
      KeyConditionExpression: "#s = :ready",
      FilterExpression: "paymentStatus = :paid",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":ready": "ready_for_rider", ":paid": "paid" },
      ScanIndexForward: true, // oldest first (fairness), as before
      Limit: limit,
    }),
  );
  return (out.Items as DynamoOrder[]) ?? [];
}

// ─── Writes ──────────────────────────────────────────────────

export interface CreateOrderInput {
  userId: string;
  restaurantId: string;
  restaurantName: string;
  restaurantLocation: { latitude: number; longitude: number };
  items: DynamoOrderItem[];
  subtotal: number;
  deliveryFee: number;
  platformFee: number;
  totalAmount: number;
  distance: number;
  riderAmount: number;
  addressId: string;
  deliveryAddress: {
    formattedAddress: string;
    mobile: number | string;
    latitude: number;
    longitude: number;
  };
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  expiresAt: Date | null; // null → COD (no payment window)
}

/**
 * Transactional create: order + (COD) cart clear commit together — the
 * Mongo session.withTransaction equivalent (TransactWriteItems), so a
 * failed cart delete can't orphan an order and vice versa.
 */
export async function createOrder(
  input: CreateOrderInput,
  cartClear?: { userId: string; itemIds?: string[] },
): Promise<DynamoOrder> {
  const id = randomUUID();
  const now = new Date().toISOString();

  const item: DynamoOrder = {
    pk: orderPk(id),
    sk: ORDER_SK,
    id,
    userId: input.userId,
    restaurantId: input.restaurantId,
    restaurantName: input.restaurantName,
    restaurantLocation: input.restaurantLocation,
    distance: input.distance,
    riderAmount: input.riderAmount,
    items: input.items,
    subtotal: input.subtotal,
    deliveryFee: input.deliveryFee,
    platformFee: input.platformFee,
    totalAmount: input.totalAmount,
    addressId: input.addressId,
    deliveryAddress: input.deliveryAddress,
    status: "placed",
    paymentMethod: input.paymentMethod,
    paymentStatus: input.paymentStatus,
    createdAt: now,
    updatedAt: now,
  };

  if (input.expiresAt) {
    item.expiresAt = input.expiresAt.toISOString();
    // DynamoDB TTL attribute (epoch seconds) — swept automatically once
    // past; the same role Mongo's expireAfterSeconds index played.
    item.ttl = Math.floor(input.expiresAt.getTime() / 1000);
  }

  // Flat projection for the payment-status GSI (reconciliation query:
  // paymentStatus = pending AND initiatedAt <= cutoff). The GSI cannot
  // reach into the nested paymentIntent map, so the attribute is mirrored
  // at the top level; stampPaymentIntent keeps it in sync.
  if (input.paymentMethod !== "cod") {
    const initDate = new Date().toISOString();
    (item as any).paymentIntentInitiatedAt = initDate;
    item.paymentIntent = {
      provider: input.paymentMethod as any,
      initiatedAt: initDate,
    };
  }

  const transactItems: any[] = [
    {
      Put: {
        TableName: TABLE.orders(),
        Item: item,
      },
    },
  ];

  if (cartClear?.itemIds && cartClear.itemIds.length > 0) {
    for (const itemId of cartClear.itemIds) {
      transactItems.push({
        Delete: {
          TableName: TABLE.carts(),
          Key: { pk: `CART#${cartClear.userId}`, sk: `ITEM#${itemId}` },
        },
      });
    }
  }

  try {
    await docClient().send(new TransactWriteCommand({ TransactItems: transactItems }));
  } catch (err: any) {
    const reasons = err?.CancellationReasons || err?.cancellationReasons;
    if (reasons) {
      console.error(
        "[createOrder] DynamoDB TransactionCanceledException CancellationReasons:",
        JSON.stringify(reasons, null, 2)
      );
      const specificMessages = reasons
        .map((r: any, idx: number) => `[Item ${idx}: ${r.Code || "None"}${r.Message ? ` - ${r.Message}` : ""}]`)
        .join(", ");
      throw new Error(`DynamoDB Transaction Failed: ${specificMessages}`);
    }
    throw err;
  }
  return item;
}

/**
 * Atomic rider claim — the double-assignment guard. Conditional update:
 * no rider yet AND still ready_for_rider AND paid. No match → the order
 * is gone/taken/expired and the caller compensates (frees the rider).
 */
export async function assignRider(
  orderId: string,
  rider: {
    riderId: string;
    riderName?: string;
    riderPhone?: number | string;
    riderPicture?: string | null;
  },
): Promise<DynamoOrder | null> {
  const out = await docClient().send(
    new UpdateCommand({
      TableName: TABLE.orders(),
      Key: { pk: orderPk(orderId), sk: ORDER_SK },
      UpdateExpression:
        "SET riderId = :r, riderName = :rn, riderPhone = :rp, riderPicture = :pic, #s = :assigned, updatedAt = :now",
      ConditionExpression:
        "attribute_exists(pk) AND (attribute_not_exists(riderId) OR riderId = :none) AND #s = :ready AND paymentStatus = :paid",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":r": rider.riderId,
        ":rn": rider.riderName ?? null,
        ":rp": rider.riderPhone ?? null,
        ":pic": rider.riderPicture ?? null,
        ":assigned": "rider_assigned",
        ":ready": "ready_for_rider",
        ":paid": "paid",
        ":none": null,
        ":now": new Date().toISOString(),
      },
      ReturnValues: "ALL_NEW",
    }),
  ).catch(() => null); // ConditionalCheckFailedException → claim lost

  return (out?.Attributes as DynamoOrder | undefined) ?? null;
}

/**
 * Seller transition (preparing/ready_for_rider/accepted) with the same
 * "must be paid" guard the Mongo controller enforced in code.
 */
export async function setOrderStatus(
  orderId: string,
  status: OrderStatus,
): Promise<DynamoOrder | null> {
  const out = await docClient().send(
    new UpdateCommand({
      TableName: TABLE.orders(),
      Key: { pk: orderPk(orderId), sk: ORDER_SK },
      UpdateExpression: "SET #s = :status, updatedAt = :now",
      ConditionExpression: "attribute_exists(pk) AND paymentStatus = :paid",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":status": status,
        ":paid": "paid",
        ":now": new Date().toISOString(),
      },
      ReturnValues: "ALL_NEW",
    }),
  ).catch(() => null);
  return (out?.Attributes as DynamoOrder | undefined) ?? null;
}

/**
 * Idempotent rider-driven transition: picked_up must come from
 * rider_assigned, delivered from picked_up — redeliveries match neither
 * guard and no-op, exactly like the old $ne-style guards.
 */
export async function transitionRiderStatus(
  orderId: string,
  riderId: string,
): Promise<DynamoOrder | null> {
  const current = await getOrderById(orderId);
  if (!current || current.riderId !== riderId) return null;

  const next =
    current.status === "rider_assigned"
      ? "picked_up"
      : current.status === "picked_up"
        ? "delivered"
        : null;
  if (!next) return null;

  const out = await docClient().send(
    new UpdateCommand({
      TableName: TABLE.orders(),
      Key: { pk: orderPk(orderId), sk: ORDER_SK },
      UpdateExpression: "SET #s = :next, updatedAt = :now",
      ConditionExpression: "#s = :expected",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":next": next,
        ":expected": current.status,
        ":now": new Date().toISOString(),
      },
      ReturnValues: "ALL_NEW",
    }),
  ).catch(() => null); // lost a race → redelivery handles it
  return (out?.Attributes as DynamoOrder | undefined) ?? null;
}

/** Payment success (webhook/consumer): idempotent flip + TTL removal. */
export async function markOrderPaid(
  orderId: string,
): Promise<DynamoOrder | null> {
  const out = await docClient().send(
    new UpdateCommand({
      TableName: TABLE.orders(),
      Key: { pk: orderPk(orderId), sk: ORDER_SK },
      UpdateExpression:
        "SET paymentStatus = :paid, #s = :placed, updatedAt = :now REMOVE expiresAt, ttl",
      ConditionExpression: "paymentStatus <> :paid",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":paid": "paid",
        ":placed": "placed",
        ":now": new Date().toISOString(),
      },
      ReturnValues: "ALL_NEW",
    }),
  ).catch(() => null); // already paid → no-op (webhook redeliveries)
  return (out?.Attributes as DynamoOrder | undefined) ?? null;
}

/** Stamp the provider intent (idempotent $set semantics). */
export async function stampPaymentIntent(
  orderId: string,
  provider: "razorpay" | "stripe",
  providerOrderId: string,
): Promise<DynamoOrder | null> {
  const out = await docClient().send(
    new UpdateCommand({
      TableName: TABLE.orders(),
      Key: { pk: orderPk(orderId), sk: ORDER_SK },
      UpdateExpression:
        "SET paymentIntent = :intent, paymentIntentInitiatedAt = :initiated, updatedAt = :now",
      ConditionExpression: "paymentStatus <> :paid",
      ExpressionAttributeValues: {
        ":intent": {
          provider,
          providerOrderId,
          initiatedAt: new Date().toISOString(),
        },
        ":initiated": new Date().toISOString(),
        ":paid": "paid",
        ":now": new Date().toISOString(),
      },
      ReturnValues: "ALL_NEW",
    }),
  ).catch(() => null);
  return (out?.Attributes as DynamoOrder | undefined) ?? null;
}

/**
 * Idempotent payment claim for utils: rejects paid/cancelled orders and
 * returns the trusted amount + any attached provider order id.
 */
export async function claimOrderForPayment(
  orderId: string,
  provider: "razorpay" | "stripe",
): Promise<{ order: DynamoOrder; attachedProviderOrderId: string | null } | null> {
  let out = await docClient().send(
    new UpdateCommand({
      TableName: TABLE.orders(),
      Key: { pk: orderPk(orderId), sk: ORDER_SK },
      UpdateExpression:
        "SET paymentIntent = if_not_exists(paymentIntent, :initIntent), updatedAt = :now",
      ConditionExpression:
        "attribute_exists(pk) AND paymentStatus <> :paid AND #s <> :cancelled",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":initIntent": {
          provider,
          initiatedAt: new Date().toISOString(),
        },
        ":now": new Date().toISOString(),
        ":paid": "paid",
        ":cancelled": "cancelled",
      },
      ReturnValues: "ALL_NEW",
    }),
  ).catch(async (err) => {
    // If paymentIntent already exists and provider needs to update
    return await docClient().send(
      new UpdateCommand({
        TableName: TABLE.orders(),
        Key: { pk: orderPk(orderId), sk: ORDER_SK },
        UpdateExpression:
          "SET paymentIntent.provider = :p, paymentIntent.initiatedAt = :now, updatedAt = :now",
        ConditionExpression:
          "attribute_exists(pk) AND paymentStatus <> :paid AND #s <> :cancelled",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":p": provider,
          ":now": new Date().toISOString(),
          ":paid": "paid",
          ":cancelled": "cancelled",
        },
        ReturnValues: "ALL_NEW",
      }),
    ).catch((e) => {
      console.error("[claimOrderForPayment] Update failed:", e);
      return null;
    });
  });

  if (!out?.Attributes) return null;
  const order = out.Attributes as DynamoOrder;
  return {
    order,
    attachedProviderOrderId:
      order.paymentIntent?.provider === provider
        ? order.paymentIntent?.providerOrderId ?? null
        : null,
  };
}

/** Cancel (customer or seller). Guard: nothing en route yet. */
export async function cancelOrder(
  orderId: string,
): Promise<DynamoOrder | null> {
  const out = await docClient().send(
    new UpdateCommand({
      TableName: TABLE.orders(),
      Key: { pk: orderPk(orderId), sk: ORDER_SK },
      UpdateExpression: "SET #s = :cancelled, updatedAt = :now",
      ConditionExpression:
        "#s <> :delivered AND #s <> :picked_up",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":cancelled": "cancelled",
        ":delivered": "delivered",
        ":picked_up": "picked_up",
        ":now": new Date().toISOString(),
      },
      ReturnValues: "ALL_NEW",
    }),
  ).catch(() => null);
  return (out?.Attributes as DynamoOrder | undefined) ?? null;
}
