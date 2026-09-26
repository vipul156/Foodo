import { makeFanoutPublisher } from "@foodo/backend-common/queue";
import { manager } from "./rabbitmq.js";

// ─── Realtime event publisher (fanout) ──────────────────────
// Publish-and-forget onto the fanout exchange the realtime service owns.
// The order hot path never waits on — or even knows about — the socket
// tier: no HTTP call, no timeout, no socket exhaustion, and a realtime
// outage degrades UI updates only, never the order API.
// Message shape matches the old /api/internal/emit contract exactly:
// { event, room, payload }. Built on the shared fanout publisher.
export const publishRealtimeEvent = makeFanoutPublisher(manager);
