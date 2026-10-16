// ─── Geo helpers (replaces Mongo 2dsphere $near) ─────────────
// MongoDB's $near is server-side; DynamoDB has no geo index. The Foodo
// query shapes are small-bounded (riders within 10km, restaurants within
// 50km of a point inside one metro), so a bounding-box prefilter + exact
// haversine pass is the standard replacement pattern: the box is computed
// from the search radius and matched against indexed lat/lon numbers,
// then candidates are distance-checked and sorted in Lambda memory.

const EARTH_RADIUS_KM = 6371;

const toRad = (deg: number) => (deg * Math.PI) / 180;

export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
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
 * Input order matches the stored GeoJSON pairs: [lng, lat].
 */
export function deliveryDistanceKm(
  restaurantCoords: [number, number],
  addressCoords: [number, number],
): number {
  const [rLon, rLat] = restaurantCoords;
  const [aLon, aLat] = addressCoords;
  const straight = haversineKm(rLat, rLon, aLat, aLon);
  return Math.max(1, straight * 1.3);
}

export interface GeoBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

/**
 * Lat/lon bounding box around a point for a radius in KM. Used as the
 * DynamoDB KeyCondition/Filter prefilter before the exact haversine
 * pass — cuts the scanned candidates to the box instead of the table.
 * Stored coordinates are GeoJSON [longitude, latitude].
 */
export function boundingBox(
  lat: number,
  lon: number,
  radiusKm: number,
): GeoBox {
  const latDelta = radiusKm / 111.32; // ~111.32 km per degree latitude
  const cos = Math.max(Math.cos(toRad(lat)), 0.01); // guard polar edge
  const lonDelta = radiusKm / (111.32 * cos);

  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLon: lon - lonDelta,
    maxLon: lon + lonDelta,
  };
}

/** Exact distance in meters between two GeoJSON [lng, lat] pairs. */
export function distanceMeters(
  a: [number, number],
  b: [number, number],
): number {
  return haversineKm(a[1], a[0], b[1], b[0]) * 1000;
}
