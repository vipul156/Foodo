// ============================================================
// Foodo — Live Rider Tracking Map (Leaflet + OpenStreetMap)
// ============================================================
// Renders the live delivery trip: restaurant pickup pin, customer
// drop-off pin, and the rider marker that moves in real time from
// `rider:location` socket pings relayed through the realtime service.
//
// Free stack — OSM tiles, no API key. Leaflet touches `window`, so the
// actual map is dynamically imported (ssr: false) by the wrapper below.

"use client";

import { useEffect, useMemo } from "react";
import L from "leaflet";
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  Polyline,
  useMap,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";

export interface LiveTrackingMapProps {
  orderId: string;
  restaurant: { name: string; latitude: number; longitude: number };
  dropoff: { formattedAddress: string; latitude: number; longitude: number };
  rider: { latitude: number; longitude: number } | null;
}

// ─── Custom divIcon markers (no image assets, theme-aware) ────

function restaurantIcon() {
  return L.divIcon({
    className: "foodo-marker",
    html: `<div class="foodo-marker__pin foodo-marker__pin--restaurant"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/></svg></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function dropoffIcon() {
  return L.divIcon({
    className: "foodo-marker",
    html: `<div class="foodo-marker__pin foodo-marker__pin--dropoff"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></svg></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function riderIcon() {
  return L.divIcon({
    className: "foodo-marker",
    html: `<div class="foodo-marker__pin foodo-marker__pin--rider"><span class="foodo-marker__pulse"></span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/></svg></div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

// ─── Map helpers ──────────────────────────────────────────────

/** Recenter/zoom to fit all three points whenever they change materially. */
function FitBounds({
  points,
}: {
  points: [number, number][];
}) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 0) return;
    if (points.length === 1) {
      map.setView(points[0], 15);
      return;
    }
    map.fitBounds(L.latLngBounds(points), {
      padding: [40, 40],
      maxZoom: 16,
    });
  }, [map, points]);
  return null;
}

// ─── Main component ───────────────────────────────────────────

export default function LiveTrackingMap({
  orderId,
  restaurant,
  dropoff,
  rider,
}: LiveTrackingMapProps) {
  const restaurantPos = useMemo<[number, number]>(
    () => [restaurant.latitude, restaurant.longitude],
    [restaurant.latitude, restaurant.longitude],
  );
  const dropoffPos = useMemo<[number, number]>(
    () => [dropoff.latitude, dropoff.longitude],
    [dropoff.latitude, dropoff.longitude],
  );
  const riderPos = useMemo<[number, number] | null>(
    () => (rider ? [rider.latitude, rider.longitude] : null),
    [rider?.latitude, rider?.longitude],
  );

  const fitPoints = useMemo(() => {
    const pts: [number, number][] = [restaurantPos, dropoffPos];
    if (riderPos) pts.push(riderPos);
    return pts;
  }, [restaurantPos, dropoffPos, riderPos]);

  return (
    <MapContainer
      center={restaurantPos}
      zoom={14}
      scrollWheelZoom={false}
      className="h-full w-full z-0"
      attributionControl
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      <FitBounds points={fitPoints} />

      {/* Pickup → dropoff route line */}
      <Polyline
        positions={[restaurantPos, dropoffPos]}
        pathOptions={{
          color: "var(--map-route, #7c3aed)",
          weight: 3,
          opacity: 0.6,
          dashArray: "6 8",
        }}
      />

      <Marker position={restaurantPos} icon={restaurantIcon()}>
        <Popup>{restaurant.name} — Pickup</Popup>
      </Marker>

      <Marker position={dropoffPos} icon={dropoffIcon()}>
        <Popup>Drop off — {dropoff.formattedAddress}</Popup>
      </Marker>

      {riderPos && (
        <Marker position={riderPos} icon={riderIcon()} zIndexOffset={1000}>
          <Popup>Your rider is here</Popup>
        </Marker>
      )}
    </MapContainer>
  );
}
