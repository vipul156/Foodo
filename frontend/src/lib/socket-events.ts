// ============================================================
// Foodo — Socket.IO Event Name Constants
// ============================================================
// Centralized event names shared between backend and frontend.
// Backend events (emitted via realtime service):
//   - "order:new"           → restaurant:{restaurantId} — new paid order
//   - "order:update"        → user:{userId}       — order status changed
//   - "order:rider_assigned" → restaurant:{restaurantId} — rider accepted
//   - "order:rider_assigned" → user:{userId}       — rider picked up
//   - "order:delivered"      → user:{userId}       — order delivered
//   - "order:available"      → user:{riderUserId}  — nearby order for rider
// ============================================================

export const SOCKET_EVENTS = {
  /** Sent when payment completes → restaurant:{restaurantId} */
  ORDER_NEW: "order:new",

  /** Sent when seller updates order status → user:{userId} */
  ORDER_UPDATE: "order:update",

  /** Sent when rider accepts an order → restaurant:{restaurantId} */
  RIDER_ASSIGNED: "order:rider_assigned",

  /** Sent when order is delivered → user:{userId} */
  ORDER_DELIVERED: "order:delivered",

  /** Sent when a nearby order is available for a rider → user:{riderUserId} */
  ORDER_AVAILABLE: "order:available",
} as const;

export type SocketEventName = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];

// ─── Payload Types ─────────────────────────────────────────

export interface OrderNewPayload {
  orderId: string;
}

export interface OrderUpdatePayload {
  orderId: string;
  status: string;
}

export interface RiderAssignedPayload {
  order: {
    _id: string;
    restaurantId: string;
    status: string;
    riderId?: string;
    riderName?: string;
    riderPhone?: number;
  };
}

export interface OrderDeliveredPayload {
  _id: string;
  userId: string;
  status: string;
}

export interface OrderAvailablePayload {
  orderId: string;
  restaurantId: string;
}
