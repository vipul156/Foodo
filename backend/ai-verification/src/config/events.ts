import { makeDomainEventPublisher } from "@foodo/backend-common/aws";

// ─── Verification event publisher (SNS) ───────────────────────
// Every verdict is published onto the platform's domain-event topic
// (foodo-events). Consumers (fraud scoring, seller scorecards,
// dispute tooling) subscribe with their own filter policy on the
// event name — the request path never knows about them.
//
// The event carries the verdict row, so a consumer never has to call
// back into this service to learn what happened.
//
// Best-effort by design: verification is analytics/fraud telemetry. A
// dropped publish must never turn a good verdict into a failed
// request — the verdict itself is already persisted in DynamoDB.

const publishDomainEvent = makeDomainEventPublisher();

export type VerificationEventType = "verification.packing" | "verification.delivery";

export const publishVerificationEvent = async (
  type: VerificationEventType,
  data: unknown,
): Promise<void> => {
  await publishDomainEvent(type, data);
};
