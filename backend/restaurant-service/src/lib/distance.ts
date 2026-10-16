// ─── Server-side distance (Haversine) ────────────────────────
// Distance comes from the two coordinate pairs the system already
// stores (restaurant.autoLocation + saved address location) — never
// from the client, which controls both rider payout and what the
// customer sees.

const EARTH_RADIUS_KM = 6371;

export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

/**
 * Road-ish distance for rider payout: straight-line distance with a
 * detour factor (roads rarely go straight), floored at 1 km so the
 * rider is never underpaid on a sub-kilometer delivery.
 */
export function deliveryDistanceKm(
  restaurantCoords: [number, number],
  addressCoords: [number, number],
): number {
  const [rLon, rLat] = restaurantCoords; // GeoJSON: [lng, lat]
  const [aLon, aLat] = addressCoords;
  const straight = haversineKm(rLat, rLon, aLat, aLon);
  return Math.max(1, straight * 1.3);
}
