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

// ─── Restaurant repository (DynamoDB) ────────────────────────
// Replaces the shared mongoose Restaurant model.
//
//   PK: RESTAURANT#<id>            SK: PROFILE
//   GSI-1 owner-index:     PK=ownerId     SK=createdAt
//   GSI-2 verified-index:  PK=isVerified  SK=name
//
// Geo ($near on 2dsphere) → bounding-box FilterExpression on the
// verified-index query + exact haversine pass in memory (see aws/geo).
// Numbers lat/lon live on the item precisely so the box filter can
// evaluate them server-side.

export interface DynamoRestaurant {
  pk: string;
  sk: string;
  id: string;
  _id: string; // Mongo-compatible alias for frontend consumers
  name: string;
  description?: string;
  image?: string;
  ownerId: string;
  phone: number | string;
  isVerified: boolean;
  autoLocation: {
    type: "Point";
    coordinates: [number, number]; // [lng, lat] GeoJSON — same wire shape
    formattedAddress: string;
  };
  lat: number; // denormalized for the geo FilterExpression
  lon: number;
  isOpen: boolean;
  createdAt: string;
  updatedAt: string;
}

export const restaurantPk = (id: string) => `RESTAURANT#${id}`;
export const RESTAURANT_SK = "PROFILE";

// ─── Reads ───────────────────────────────────────────────────

const toRestaurant = (item: Record<string, unknown> | undefined): DynamoRestaurant | null => {
  if (!item) return null;
  const id = (item.id as string) || (item.pk ? String(item.pk).replace("RESTAURANT#", "") : "");
  return {
    ...item,
    id,
    _id: id,
    isVerified: Boolean(item.isVerified),
  } as DynamoRestaurant;
};

export async function getRestaurantById(
  id: string,
): Promise<DynamoRestaurant | null> {
  const out = await docClient().send(
    new GetCommand({
      TableName: TABLE.restaurants(),
      Key: { pk: restaurantPk(id), sk: RESTAURANT_SK },
    }),
  );
  return toRestaurant(out.Item as Record<string, unknown> | undefined);
}

export async function getRestaurantByOwner(
  ownerId: string,
): Promise<DynamoRestaurant | null> {
  const out = await docClient().send(
    new QueryCommand({
      TableName: TABLE.restaurants(),
      IndexName: "owner-index",
      KeyConditionExpression: "ownerId = :o",
      ExpressionAttributeValues: { ":o": ownerId },
      Limit: 1,
    }),
  );
  return toRestaurant(out.Items?.[0] as Record<string, unknown> | undefined);
}

export async function listVerifiedRestaurants(): Promise<
  DynamoRestaurant[]
> {
  const out = await docClient().send(
    new QueryCommand({
      TableName: TABLE.restaurants(),
      IndexName: "verified-index",
      KeyConditionExpression: "isVerified = :v",
      ExpressionAttributeValues: { ":v": 1 },
    }),
  );
  return ((out.Items as Record<string, unknown>[]) ?? []).map((i) => toRestaurant(i)!);
}

export async function listPendingRestaurants(): Promise<
  DynamoRestaurant[]
> {
  const out = await docClient().send(
    new QueryCommand({
      TableName: TABLE.restaurants(),
      IndexName: "verified-index",
      KeyConditionExpression: "isVerified = :v",
      ExpressionAttributeValues: { ":v": 0 },
    }),
  );
  return ((out.Items as Record<string, unknown>[]) ?? []).map((i) => toRestaurant(i)!);
}

export async function listAllRestaurants(): Promise<DynamoRestaurant[]> {
  const out = await docClient().send(
    new ScanCommand({ TableName: TABLE.restaurants() }),
  );
  return ((out.Items as Record<string, unknown>[]) ?? [])
    .map((i) => toRestaurant(i)!)
    .sort(
      (a, b) => Number(b.isOpen) - Number(a.isOpen) || a.name.localeCompare(b.name),
    );
}

/**
 * $near replacement: verified restaurants within maxDistanceMeters of a
 * point. Bounding box narrows candidates server-side (lat/lon between
 * bounds), haversine exacts and sorts in memory. Inside one metro the
 * candidate set is small — the same tradeoff every DynamoDB geo
 * pattern accepts in exchange for not sharding a global index.
 */
export async function listRestaurantsNear(
  lat: number,
  lon: number,
  maxDistanceMeters = 50_000,
): Promise<DynamoRestaurant[]> {
  const box = boundingBox(lat, lon, maxDistanceMeters / 1000);

  const out = await docClient().send(
    new QueryCommand({
      TableName: TABLE.restaurants(),
      IndexName: "verified-index",
      KeyConditionExpression: "isVerified = :v",
      FilterExpression:
        "lat BETWEEN :minLat AND :maxLat AND lon BETWEEN :minLon AND :maxLon",
      ExpressionAttributeValues: {
        ":v": 1,
        ":minLat": box.minLat,
        ":maxLat": box.maxLat,
        ":minLon": box.minLon,
        ":maxLon": box.maxLon,
      },
    }),
  );

  const candidates = (((out.Items as Record<string, unknown>[]) ?? []).map((i) => toRestaurant(i)!));
  return candidates
    .map((r) => ({
      restaurant: r,
      distance: distanceMeters(
        [lon, lat],
        r.autoLocation.coordinates,
      ),
    }))
    .filter((x) => x.distance <= maxDistanceMeters)
    .sort((a, b) => a.distance - b.distance)
    .map((x) => x.restaurant);
}

// ─── Writes ──────────────────────────────────────────────────

export interface CreateRestaurantInput {
  name: string;
  description?: string;
  image?: string;
  ownerId: string;
  phone: number | string;
  autoLocation: {
    type: "Point";
    coordinates: [number, number];
    formattedAddress: string;
  };
}

export async function createRestaurant(
  input: CreateRestaurantInput,
): Promise<DynamoRestaurant> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const [lon, lat] = input.autoLocation.coordinates;

  const item: Record<string, unknown> = {
    pk: restaurantPk(id),
    sk: RESTAURANT_SK,
    id,
    name: input.name,
    ...(input.description && { description: input.description }),
    ...(input.image && { image: input.image }),
    ownerId: input.ownerId,
    phone: input.phone,
    isVerified: 0,
    autoLocation: input.autoLocation,
    lat,
    lon,
    isOpen: false,
    createdAt: now,
    updatedAt: now,
  };

  await docClient().send(
    new PutCommand({ TableName: TABLE.restaurants(), Item: item }),
  );
  return toRestaurant(item)!;
}

export async function updateRestaurantByOwner(
  ownerId: string,
  updates: Partial<
    Pick<DynamoRestaurant, "name" | "description" | "phone" | "image" | "isOpen">
  >,
): Promise<DynamoRestaurant | null> {
  const existing = await getRestaurantByOwner(ownerId);
  if (!existing) return null;

  const names = Object.keys(updates).filter(
    (k) => (updates as Record<string, unknown>)[k] !== undefined,
  );
  if (names.length === 0) return existing;

  const expr = names
    .map((k, i) => `#f${i} = :v${i}`)
    .join(", ");
  const attrNames = Object.fromEntries(
    names.map((k, i) => [`#f${i}`, k]),
  );
  const attrValues = Object.fromEntries(
    names.map((k, i) => [
      `:v${i}`,
      (updates as Record<string, unknown>)[k],
    ]),
  );

  const out = await docClient().send(
    new UpdateCommand({
      TableName: TABLE.restaurants(),
      Key: { pk: restaurantPk(existing.id), sk: RESTAURANT_SK },
      UpdateExpression: `SET ${expr}, updatedAt = :now`,
      ExpressionAttributeNames: { ...attrNames },
      ExpressionAttributeValues: { ...attrValues, ":now": new Date().toISOString() },
      ReturnValues: "ALL_NEW",
    }),
  );
  return toRestaurant(out.Attributes as Record<string, unknown> | undefined);
}

export async function setRestaurantVerified(
  id: string,
  isVerified: boolean,
): Promise<DynamoRestaurant | null> {
  const out = await docClient().send(
    new UpdateCommand({
      TableName: TABLE.restaurants(),
      Key: { pk: restaurantPk(id), sk: RESTAURANT_SK },
      UpdateExpression: "SET isVerified = :v, updatedAt = :now",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: {
        ":v": isVerified ? 1 : 0,
        ":now": new Date().toISOString(),
      },
      ReturnValues: "ALL_NEW",
    }),
  ).catch(() => null);
  return toRestaurant(out?.Attributes as Record<string, unknown> | undefined);
}

export async function setRestaurantOpen(
  ownerId: string,
  isOpen: boolean,
): Promise<DynamoRestaurant | null> {
  return updateRestaurantByOwner(ownerId, { isOpen });
}
