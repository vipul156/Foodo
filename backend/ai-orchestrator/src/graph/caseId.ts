// ─── Case ID generator ───────────────────────────────────────
// Dependency-free, collision-resistant ID: timestamp + random entropy.
// Format: arb_<base36 time>_<random>, e.g. arb_m2xk9f3_qpx7a1b2c3d4
export const generateCaseId = (): string =>
  `arb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
