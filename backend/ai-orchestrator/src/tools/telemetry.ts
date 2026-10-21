import { internalGet, getInternalHeaders } from "../config/http.js";

// ─── Tool: Delivery telemetry audit ──────────────────────────
// Pulls the rider-side telemetry for the order from the rider service
// and reduces it to hard signals the graph can gate on. The rider
// service owns the data; this tool never invents numbers — missing
// telemetry yields flags:[] with confidence 0.5, not fabricated metrics.

export interface TelemetryAudit {
  flags: string[]; // e.g. ["LONG_DETOUR", "EXCESSIVE_DURATION", "HARD_BRAKING_EVENTS"]
  detourMinutes: number | null; // minutes beyond the direct-route estimate
  totalDurationMinutes: number | null;
  handlingScore: number | null; // 0-1, from accelerometer-derived events
  confidence: number;
}

interface RawTelemetry {
  detourMinutes?: number;
  totalDurationMinutes?: number;
  handlingScore?: number;
  hardBrakingEvents?: number;
  routeDeviationRatio?: number;
}

const clampNum = (v: unknown): number | null =>
  Number.isFinite(Number(v)) ? Number(v) : null;

export const auditDeliveryTelemetry = async (
  orderId: string,
): Promise<TelemetryAudit> => {
  try {
    const data = await internalGet<RawTelemetry>(
      `${process.env.RIDER_SERVICE_URL}/api/rider/telemetry/internal/${orderId}`,
      { headers: getInternalHeaders() },
    );

    const flags: string[] = [];
    const detourMinutes = clampNum(data?.detourMinutes);
    const totalDurationMinutes = clampNum(data?.totalDurationMinutes);
    const handlingScore = clampNum(data?.handlingScore);
    const hardBrakingEvents = clampNum(data?.hardBrakingEvents) ?? 0;

    if (detourMinutes !== null && detourMinutes > 20) {
      flags.push("LONG_DETOUR");
    }
    if (totalDurationMinutes !== null && totalDurationMinutes > 90) {
      flags.push("EXCESSIVE_DURATION");
    }
    if (hardBrakingEvents >= 3) {
      flags.push("HARD_BRAKING_EVENTS");
    }
    if (handlingScore !== null && handlingScore < 0.4) {
      flags.push("POOR_HANDLING");
    }

    return {
      flags,
      detourMinutes,
      totalDurationMinutes,
      handlingScore,
      confidence: 0.9,
    };
  } catch {
    // Telemetry is evidence, not a hard dependency — the graph proceeds
    // with "no signals" rather than failing the case.
    return { flags: [], detourMinutes: null, totalDurationMinutes: null, handlingScore: null, confidence: 0.5 };
  }
};
