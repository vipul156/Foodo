import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, TABLE } from "../aws/dynamodb.js";

// ─── Voucher repository (DynamoDB) ───────────────────────────
// Bounded goodwill credits the AI tier may issue when it refuses to
// move money (verified damage, but the customer's trust score is
// below the autonomous-refund threshold).
//
//   PK: VOUCHER#<code>   SK: VOUCHER
//   GSI customer-index : customerId → createdAt
//
// The voucher is RECORDED, not yet redeemed at checkout: the code is
// reserved (FOODO-AGENT-) and review tooling can revoke it. The
// amount is capped by the caller (the agent's VOUCHER_CAP), so a
// manipulated model can never mint arbitrary value.

export type VoucherStatus = "active" | "redeemed" | "revoked";

export interface Voucher {
  code: string;
  customerId: string;
  amount: number;
  reason: string;
  issuedBy: string;
  status: VoucherStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateVoucherInput {
  code: string;
  customerId: string;
  amount: number;
  reason: string;
  issuedBy: string;
}

const tableName = () => TABLE.vouchers();
const pk = (code: string) => `VOUCHER#${code}`;
const SK = "VOUCHER";

export async function createVoucher(
  input: CreateVoucherInput,
): Promise<Voucher> {
  const now = new Date().toISOString();
  const voucher: Voucher = {
    code: input.code,
    customerId: input.customerId,
    amount: input.amount,
    reason: input.reason,
    issuedBy: input.issuedBy,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };

  await docClient().send(
    new PutCommand({
      TableName: tableName(),
      Item: { ...voucher, pk: pk(input.code), sk: SK },
      // A code is issued once. A replay (the agent retrying) must not
      // create a second live voucher for the same case.
      ConditionExpression: "attribute_not_exists(pk)",
    }),
  );

  return voucher;
}

export async function getVoucher(code: string): Promise<Voucher | null> {
  const out = await docClient().send(
    new GetCommand({
      TableName: tableName(),
      Key: { pk: pk(code), sk: SK },
    }),
  );
  return out.Item ? toVoucher(out.Item) : null;
}

export async function setVoucherStatus(
  code: string,
  status: VoucherStatus,
): Promise<Voucher | null> {
  const out = await docClient()
    .send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { pk: pk(code), sk: SK },
        UpdateExpression: "SET #status = :status, updatedAt = :now",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": status,
          ":now": new Date().toISOString(),
        },
        ReturnValues: "ALL_NEW",
      }),
    )
    .catch(() => null);
  return out?.Attributes ? toVoucher(out.Attributes) : null;
}

const toVoucher = (item: Record<string, any>): Voucher => ({
  code: String(item.code),
  customerId: String(item.customerId ?? ""),
  amount: Number(item.amount ?? 0),
  reason: String(item.reason ?? ""),
  issuedBy: String(item.issuedBy ?? ""),
  status: (item.status ?? "active") as VoucherStatus,
  createdAt: String(item.createdAt ?? ""),
  updatedAt: String(item.updatedAt ?? item.createdAt ?? ""),
});
