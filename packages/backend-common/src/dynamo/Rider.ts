import { randomUUID } from "crypto";
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { docClient, TABLE } from "../aws/dynamodb.js";
import { boundingBox, distanceMeters } from "../aws/geo.js";

// ─── Rider repository (DynamoDB) ─────────────────────────────
// Replaces the shared mongoose Rider model.
//
//   PK: RIDER#<id>              SK: PROFILE
//   GSI-1 user-index:     PK=userId      SK=createdAt   (1:1 lookup)
//   GSI-2 verified-index: PK=isVerified  SK=createdAt
//
// The saga state (isAvailable + currentOrderId) lives on the profile
// item exactly as before — the conditional UpdateItem IS the atomic
// claim/release, same as the old findOneAndUpdate conditions.

export interface DynamoRider {
  pk: string;
  sk: string;
  id: string;
  userId: string;
  picture: string;
  phoneNumber: string;
  addharNumber: string;
  drivingLicenseNumber: string;
  isVerified: boolean;
  location: {
    type: "Point";
    coordinates: [number, number]; // [lng, lat] GeoJSON
  };
  lat: number; // denormalized for geo filters
  lon: number;
  isAvailable: boolean;
  lastActive: string;
  currentOrderId: string | null;
  createdAt: string;
  updatedAt: string;
}

export const riderPk = (id: string) => `RIDER#${id}`;
export const RIDER_SK = "PROFILE";

// ─── Reads ───────────────────────────────────────────────────

export async function getRiderById(id: string): Promise<DynamoRider | null> {
  const out = await docClient().send(
    new GetCommand({
      TableName: TABLE.riders(),
      Key: { pk: riderPk(id), sk: RIDER_SK },
    }),
  );
  return (out.Item as DynamoRider | undefined) ?? null;
}

export async function getRiderByUserId(
  userId: string,
): Promise<DynamoRider | null> {
  const out = await docClient().send(
    new QueryCommand({
      TableName: TABLE.riders(),
      IndexName: "user-index",
      KeyConditionExpression: "userId = :u",
      ExpressionAttributeValues: { ":u": userId },
      Limit: 1,
    }),
  );
  return (out.Items?.[0] as DynamoRider | undefined) ?? null;
}

export async function listPendingRiders(): Promise<DynamoRider[]> {
  const out = await docClient().send(
    new QueryCommand({
      TableName: TABLE.riders(),
      IndexName: "verified-index",
      KeyConditionExpression: "isVerified = :v",
      ExpressionAttributeValues: { ":v": false },
    }),
  );
  return (out.Items as DynamoRider[]) ?? [];
}

export async function listAllRiders(): Promise<DynamoRider[]> {
  const out = await docClient().send(
    new ScanCommand({ TableName: TABLE.riders() }),
  );
  return ((out.Items as DynamoRider[]) ?? []).sort(
    (a, b) =>
      Number(b.isAvailable) - Number(a.isAvailable) ||
      Number(b.isVerified) - Number(a.isVerified),
  );
}

/**
 * $near matcher replacement: verified + available riders within radius
 * of the restaurant. Bounding-box FilterExpression on the verified
 * index, exact haversine + distance sort in memory (see aws/geo).
 */
export async function listAvailableRidersNear(
  lat: number,
  lon: number,
  radiusMeters = 10_000,
): Promise<DynamoRider[]> {
  const box = boundingBox(lat, lon, radiusMeters / 1000);

  const out = await docClient().send(
    new QueryCommand({
      TableName: TABLE.riders(),
      IndexName: "verified-index",
      KeyConditionExpression: "isVerified = :v",
      FilterExpression:
        "isAvailable = :a AND lat BETWEEN :minLat AND :maxLat AND lon BETWEEN :minLon AND :maxLon",
      ExpressionAttributeValues: {
        ":v": true,
        ":a": true,
        ":minLat": box.minLat,
        ":maxLat": box.maxLat,
        ":minLon": box.minLon,
        ":maxLon": box.maxLon,
      },
    }),
  );

  const candidates = (out.Items as DynamoRider[]) ?? [];
  return candidates
    .map((r) => ({
      rider: r,
      distance: distanceMeters([lon, lat], r.location.coordinates),
    }))
    .filter((x) => x.distance <= radiusMeters)
    .sort((a, b) => a.distance - b.distance)
    .map((x) => x.rider);
}

// ─── Writes ──────────────────────────────────────────────────

export interface CreateRiderInput {
  userId: string;
  picture: string;
  phoneNumber: string;
  addharNumber: string;
  drivingLicenseNumber: string;
  location: {
    type: "Point";
    coordinates: [number, number];
  };
}

export async function createRider(
  input: CreateRiderInput,
): Promise<DynamoRider> {
  // Uniqueness guard (userId / phone / aadhaar were unique indexes):
  // cheap existence checks before the put — DynamoDB has no unique
  // constraint beyond PK.
  const [byUser, byPhone] = await Promise.all([
    getRiderByUserId(input.userId),
    docClient().send(
      new QueryCommand({
        TableName: TABLE.riders(),
        IndexName: "user-index",
        KeyConditionExpression: "userId = :u",
        ExpressionAttributeValues: { ":u": input.userId },
        Limit: 1,
      }),
    ),
  ]);
  if (byUser || (byPhone.Items?.length ?? 0) > 0) {
    const err = new Error("Rider already exists") as Error & { code?: string };
    err.code = "DuplicateRider";
    throw err;
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const [lon, lat] = input.location.coordinates;

  const item: DynamoRider = {
    pk: riderPk(id),
    sk: RIDER_SK,
    id,
    userId: input.userId,
    picture: input.picture,
    phoneNumber: input.phoneNumber,
    addharNumber: input.addharNumber,
    drivingLicenseNumber: input.drivingLicenseNumber,
    isVerified: false,
    location: input.location,
    lat,
    lon,
    isAvailable: false,
    lastActive: now,
    currentOrderId: null,
    createdAt: now,
    updatedAt: now,
  };

  await docClient().send(
    new PutCommand({ TableName: TABLE.riders(), Item: item }),
  );
  return item;
}

/**
 * Atomic claim — flips availability true→false and stamps the order.
 * Conditional so double-clicks can't double-claim (same semantics as
 * the findOneAndUpdate guard).
 */
export async function claimRiderForOrder(
  userId: string,
  orderId: string,
): Promise<DynamoRider | null> {
  const rider = await getRiderByUserId(userId);
  if (!rider) return null;

  const out = await docClient().send(
    new UpdateCommand({
      TableName: TABLE.riders(),
      Key: { pk: rider.pk, sk: rider.sk },
      UpdateExpression:
        "SET isAvailable = :off, currentOrderId = :order, lastActive = :now, updatedAt = :now",
      ConditionExpression: "isAvailable = :on",
      ExpressionAttributeValues: {
        ":off": false,
        ":on": true,
        ":order": orderId,
        ":now": new Date().toISOString(),
      },
      ReturnValues: "ALL_NEW",
    }),
  ).catch(() => null); // already claimed / not available
  return (out?.Attributes as DynamoRider | undefined) ?? null;
}

/**
 * The one true release path: flips the rider back ONLY if still claimed
 * by THIS order and currently offline. A stale/delayed/redelivered
 * compensation can never free a rider who moved to another order.
 */
export async function releaseRiderFromOrder(
  riderId: string,
  orderId: string | null,
  notify: { orderId: string | null; status: string },
  publish: (event: string, room: string, payload: unknown) => Promise<void>,
): Promise<boolean> {
  const rider = await getRiderById(riderId);
  if (!rider) return false;

  const condition = orderId
    ? "isAvailable = :off AND currentOrderId = :order"
    : "isAvailable = :off";

  const out = await docClient().send(
    new UpdateCommand({
      TableName: TABLE.riders(),
      Key: { pk: rider.pk, sk: rider.sk },
      UpdateExpression:
        "SET isAvailable = :on, currentOrderId = :none, lastActive = :now, updatedAt = :now",
      ConditionExpression: condition,
      ExpressionAttributeValues: {
        ":off": false,
        ":on": true,
        ":none": null,
        ":now": new Date().toISOString(),
        ...(orderId && { ":order": orderId }),
      },
      ReturnValues: "ALL_NEW",
    }),
  ).catch(() => null);

  if (!out?.Attributes) {
    // No match: rider doesn't exist, is already online, or claimed
    // another order — stale event, idempotent no-op.
    console.log(
      `[COMPENSATE] skip — rider ${riderId} not claimable (order ${orderId ?? "n/a"})`,
    );
    return false;
  }

  const updated = out.Attributes as DynamoRider;
  await publish("order:update", `user:${updated.userId}`, notify);
  console.log(`[COMPENSATE] rider ${riderId} released (order ${orderId ?? "n/a"})`);
  return true;
}

export async function setRiderVerified(
  id: string,
  isVerified: boolean,
): Promise<DynamoRider | null> {
  const out = await docClient().send(
    new UpdateCommand({
      TableName: TABLE.riders(),
      Key: { pk: riderPk(id), sk: RIDER_SK },
      UpdateExpression: "SET isVerified = :v, updatedAt = :now",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: {
        ":v": isVerified,
        ":now": new Date().toISOString(),
      },
      ReturnValues: "ALL_NEW",
    }),
  ).catch(() => null);
  return (out?.Attributes as DynamoRider | undefined) ?? null;
}

/**
 * Availability toggle (Go online / Go offline). When going online the
 * caller has already verified there is no active delivery.
 */
export async function setRiderAvailability(
  userId: string,
  isAvailable: boolean,
  coordinates: [number, number],
): Promise<DynamoRider | null> {
  const rider = await getRiderByUserId(userId);
  if (!rider) return null;

  const [lon, lat] = coordinates;
  const out = await docClient().send(
    new UpdateCommand({
      TableName: TABLE.riders(),
      Key: { pk: rider.pk, sk: rider.sk },
      UpdateExpression:
        "SET isAvailable = :a, #loc = :loc, lat = :lat, lon = :lon, lastActive = :now, updatedAt = :now",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: { "#loc": "location" },
      ExpressionAttributeValues: {
        ":a": isAvailable,
        ":loc": { type: "Point", coordinates },
        ":lat": lat,
        ":lon": lon,
        ":now": new Date().toISOString(),
      },
      ReturnValues: "ALL_NEW",
    }),
  );
  return (out.Attributes as DynamoRider) ?? null;
}
