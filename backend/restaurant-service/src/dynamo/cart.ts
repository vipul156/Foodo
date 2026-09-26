import { randomUUID } from "crypto";
import {
  PutCommand,
  GetCommand,
  DeleteCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { docClient, TABLE } from "@foodo/backend-common/aws";

// ─── Cart repository (DynamoDB) ──────────────────────────────
// Replaces the mongoose Cart model. One partition per user:
//
//   PK: CART#<userId>   SK: ITEM#<itemId>
//
// "One restaurant per cart" is enforced the same way as before (a query
// for a row from another restaurant), and quantity $inc becomes a
// dynamo ADD on quantity. The whole partition delete (clear cart) is a
// BatchWrite of per-item deletes.

export interface DynamoCartRow {
  pk: string; // CART#<userId>
  sk: string; // ITEM#<itemId>
  userId: string;
  restaurantId: string;
  itemId: string;
  quantity: number;
  createdAt: string;
  updatedAt: string;
}

const cartPk = (userId: string) => `CART#${userId}`;
const itemSk = (itemId: string) => `ITEM#${itemId}`;

export async function getCartRows(userId: string): Promise<DynamoCartRow[]> {
  const out = await docClient().send(
    new QueryCommand({
      TableName: TABLE.carts(),
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": cartPk(userId) },
    }),
  );
  return (out.Items as DynamoCartRow[]) ?? [];
}

/** Guard: any existing row from a DIFFERENT restaurant blocks the add. */
export async function findCartFromDifferentRestaurant(
  userId: string,
  restaurantId: string,
): Promise<DynamoCartRow | null> {
  const rows = await getCartRows(userId);
  return rows.find((r) => r.restaurantId !== restaurantId) ?? null;
}

/**
 * $inc upsert. An UpdateExpression cannot mix ADD and SET paths, so two
 * writes cover both cases: first add inserts the full row (quantity: 1);
 * repeat adds just bump the counter. The GET check keeps double-adds
 * from concurrent tabs correct enough for a cart.
 */
export async function incrementCartItem(
  userId: string,
  restaurantId: string,
  itemId: string,
): Promise<DynamoCartRow> {
  const now = new Date().toISOString();
  const existing = await getCartItem(userId, itemId);

  if (!existing) {
    const row: DynamoCartRow = {
      pk: cartPk(userId),
      sk: itemSk(itemId),
      userId,
      restaurantId,
      itemId,
      quantity: 1,
      createdAt: now,
      updatedAt: now,
    };
    await docClient().send(
      new PutCommand({
        TableName: TABLE.carts(),
        Item: row,
        // Lose an insert race to the concurrent identical add — both
        // meant "make sure this item is in the cart"; re-read instead of
        // double-counting.
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    ).catch((err: any) => {
      if (err?.name !== "ConditionalCheckFailedException") throw err;
    });
    return (await getCartItem(userId, itemId)) ?? row;
  }

  const out = await docClient().send(
    new UpdateCommand({
      TableName: TABLE.carts(),
      Key: { pk: cartPk(userId), sk: itemSk(itemId) },
      UpdateExpression: "ADD quantity :one",
      ExpressionAttributeValues: { ":one": 1 },
      ReturnValues: "ALL_NEW",
    }),
  );
  return out.Attributes as DynamoCartRow;
}

export async function decrementCartItem(
  userId: string,
  itemId: string,
): Promise<DynamoCartRow | null> {
  const out = await docClient()
    .send(
      new UpdateCommand({
        TableName: TABLE.carts(),
        Key: { pk: cartPk(userId), sk: itemSk(itemId) },
        UpdateExpression: "ADD quantity :minusOne",
        ConditionExpression: "quantity > :one",
        ExpressionAttributeValues: {
          ":minusOne": -1,
          ":one": 1,
        },
        ReturnValues: "ALL_NEW",
      }),
    )
    .catch(() => null); // quantity == 1 → caller decides to delete
  return (out?.Attributes as DynamoCartRow | undefined) ?? null;
}

export async function getCartItem(
  userId: string,
  itemId: string,
): Promise<DynamoCartRow | null> {
  const out = await docClient().send(
    new GetCommand({
      TableName: TABLE.carts(),
      Key: { pk: cartPk(userId), sk: itemSk(itemId) },
    }),
  );
  return (out.Item as DynamoCartRow | undefined) ?? null;
}

export async function deleteCartItem(
  userId: string,
  itemId: string,
): Promise<void> {
  await docClient().send(
    new DeleteCommand({
      TableName: TABLE.carts(),
      Key: { pk: cartPk(userId), sk: itemSk(itemId) },
    }),
  );
}

/** Clear cart: delete every row of the user's partition. */
export async function clearCart(userId: string): Promise<void> {
  const rows = await getCartRows(userId);
  await Promise.all(
    rows.map((r) =>
      docClient().send(
        new DeleteCommand({
          TableName: TABLE.carts(),
          Key: { pk: r.pk, sk: r.sk },
        }),
      ),
    ),
  );
}

/**
 * Menu enrichment for getCart/createOrder: batch GetMenuItem rows for
 * the cart's item ids (replaces the populate("itemId") round-trip).
 */
export async function fetchMenuItemsForCart(
  itemIds: string[],
): Promise<Map<string, DynamoMenuItem>> {
  const out = await Promise.all(
    itemIds.map((id) =>
      docClient()
        .send(
          new GetCommand({
            TableName: TABLE.menuItems(),
            Key: { pk: `MENU#${id}`, sk: "ITEM" },
          }),
        )
        .then((r) => r.Item as DynamoMenuItem | undefined)
        .catch(() => undefined),
    ),
  );
  const map = new Map<string, DynamoMenuItem>();
  for (const item of out) {
    if (item) map.set(item.id, item);
  }
  return map;
}

// ─── Menu item repository (service-local, DynamoDB) ──────────

export interface DynamoMenuItem {
  pk: string; // MENU#<itemId>
  sk: string; // ITEM
  id: string;
  restaurantId: string;
  name: string;
  description: string;
  price: number;
  category?: string;
  image: string;
  isAvailable: boolean;
  createdAt: string;
  updatedAt: string;
}

const menuPk = (id: string) => `MENU#${id}`;
export const MENU_ITEM_SK = "ITEM";

export async function createMenuItem(input: {
  restaurantId: string;
  name: string;
  description: string;
  price: number;
  image: string;
  category?: string;
}): Promise<DynamoMenuItem> {
  const id = randomUUID();
  const now = new Date().toISOString();

  const item: DynamoMenuItem = {
    pk: menuPk(id),
    sk: MENU_ITEM_SK,
    id,
    restaurantId: input.restaurantId,
    name: input.name,
    description: input.description,
    price: input.price,
    ...(input.category && { category: input.category }),
    image: input.image,
    isAvailable: true,
    createdAt: now,
    updatedAt: now,
  };

  await docClient().send(
    new PutCommand({ TableName: TABLE.menuItems(), Item: item }),
  );
  return item;
}

export async function getMenuItemById(
  id: string,
): Promise<DynamoMenuItem | null> {
  const out = await docClient().send(
    new GetCommand({
      TableName: TABLE.menuItems(),
      Key: { pk: menuPk(id), sk: MENU_ITEM_SK },
    }),
  );
  return (out.Item as DynamoMenuItem | undefined) ?? null;
}

export async function listMenuItemsByRestaurant(
  restaurantId: string,
): Promise<DynamoMenuItem[]> {
  const out = await docClient().send(
    new QueryCommand({
      TableName: TABLE.menuItems(),
      IndexName: "restaurant-index",
      KeyConditionExpression: "restaurantId = :r",
      ExpressionAttributeValues: { ":r": restaurantId },
    }),
  );
  return (out.Items as DynamoMenuItem[]) ?? [];
}

export async function toggleMenuItemAvailabilityTo(
  id: string,
  isAvailable: boolean,
): Promise<DynamoMenuItem | null> {
  const out = await docClient().send(
    new UpdateCommand({
      TableName: TABLE.menuItems(),
      Key: { pk: menuPk(id), sk: MENU_ITEM_SK },
      UpdateExpression: "SET isAvailable = :v, updatedAt = :now",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: {
        ":v": isAvailable,
        ":now": new Date().toISOString(),
      },
      ReturnValues: "ALL_NEW",
    }),
  ).catch(() => null);
  return (out?.Attributes as DynamoMenuItem | undefined) ?? null;
}

export async function deleteMenuItem(id: string): Promise<void> {
  await docClient().send(
    new DeleteCommand({
      TableName: TABLE.menuItems(),
      Key: { pk: menuPk(id), sk: MENU_ITEM_SK },
    }),
  );
}

// ─── Address repository (service-local, DynamoDB) ────────────

export interface DynamoAddress {
  pk: string; // USER#<userId>
  sk: string; // ADDRESS#<id>
  id: string;
  userId: string;
  mobile: number | string;
  formatterAddress: string;
  location: {
    type: "Point";
    coordinates: [number, number];
  };
  createdAt: string;
}

const addressSk = (id: string) => `ADDRESS#${id}`;

export async function createAddress(input: {
  userId: string;
  mobile: number | string;
  formatterAddress: string;
  location: {
    type: "Point";
    coordinates: [number, number];
  };
}): Promise<DynamoAddress> {
  const id = randomUUID();
  const now = new Date().toISOString();

  const item: DynamoAddress = {
    pk: `USER#${input.userId}`,
    sk: addressSk(id),
    id,
    userId: input.userId,
    mobile: input.mobile,
    formatterAddress: input.formatterAddress,
    location: input.location,
    createdAt: now,
  };

  await docClient().send(
    new PutCommand({ TableName: TABLE.addresses(), Item: item }),
  );
  return item;
}

export async function getAddress(
  userId: string,
  addressId: string,
): Promise<DynamoAddress | null> {
  const out = await docClient().send(
    new GetCommand({
      TableName: TABLE.addresses(),
      Key: { pk: `USER#${userId}`, sk: addressSk(addressId) },
    }),
  );
  return (out.Item as DynamoAddress | undefined) ?? null;
}

export async function listAddresses(
  userId: string,
): Promise<DynamoAddress[]> {
  const out = await docClient().send(
    new QueryCommand({
      TableName: TABLE.addresses(),
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `USER#${userId}`,
        ":prefix": "ADDRESS#",
      },
      ScanIndexForward: false, // newest first
    }),
  );
  return (out.Items as DynamoAddress[]) ?? [];
}

export async function deleteAddress(
  userId: string,
  addressId: string,
): Promise<void> {
  await docClient().send(
    new DeleteCommand({
      TableName: TABLE.addresses(),
      Key: { pk: `USER#${userId}`, sk: addressSk(addressId) },
    }),
  );
}
