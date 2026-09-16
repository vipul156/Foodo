// ============================================================
// Foodo — Geolocation + Reverse Geocoding Helpers
// ============================================================
// Browser geolocation plus address lookup via OpenStreetMap's
// free Nominatim API (no API key required). Falls back to raw
// coordinates when the lookup fails so flows never block.

export interface Coords {
  latitude: number;
  longitude: number;
}

interface NominatimResponse {
  display_name?: string;
  address?: {
    house_number?: string;
    road?: string;
    neighbourhood?: string;
    suburb?: string;
    city?: string;
    town?: string;
    village?: string;
    state?: string;
    postcode?: string;
  };
  error?: string;
}

/** Promise wrapper around navigator.geolocation.getCurrentPosition */
export function getCurrentPosition(options?: PositionOptions): Promise<Coords> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error("Geolocation is not supported by your browser"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
        }),
      (err) => {
        const messages: Record<number, string> = {
          1: "Location permission denied. Enable it in your browser settings.",
          2: "Location information is unavailable right now.",
          3: "Location request timed out. Try again.",
        };
        reject(new Error(messages[err.code] || "Could not detect your location."));
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000, ...options },
    );
  });
}

/** Human-readable address from coordinates, e.g. "12, MG Road, Indiranagar, Bengaluru 560038" */
export async function reverseGeocode(
  latitude: number,
  longitude: number,
): Promise<string> {
  const fallback = `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;

  try {
    const url = new URL("https://nominatim.openstreetmap.org/reverse");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("lat", String(latitude));
    url.searchParams.set("lon", String(longitude));
    url.searchParams.set("zoom", "18");
    url.searchParams.set("addressdetails", "1");

    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return fallback;

    const data = (await res.json()) as NominatimResponse;
    if (data.error || !data.address) return fallback;

    const a = data.address;
    const parts = [
      [a.house_number, a.road].filter(Boolean).join(" "),
      a.neighbourhood || a.suburb,
      a.city || a.town || a.village,
      a.state,
    ].filter(Boolean) as string[];

    const address = parts.join(", ");
    return a.postcode ? `${address} ${a.postcode}` : address || fallback;
  } catch {
    return fallback;
  }
}
