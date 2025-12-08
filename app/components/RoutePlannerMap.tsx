"use client";

import { useMemo, useEffect, useRef } from "react";
import { MapContainer, TileLayer, Marker, Polyline, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { RoutePoint } from "./RoutePlanner";

// Fix Leaflet default icon issue
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

// Custom icons for different point types
const createIcon = (color: string, label: string) => {
  return L.divIcon({
    html: `
      <div style="
        background-color: ${color};
        width: 32px;
        height: 32px;
        border-radius: 50%;
        border: 3px solid white;
        box-shadow: 0 2px 5px rgba(0,0,0,0.3);
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        font-weight: bold;
        font-size: 12px;
      ">
        ${label}
      </div>
    `,
    className: "",
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -16],
  });
};

const nfoIcon = createIcon("#3B82F6", "N"); // Blue for NFO
const warehouseIcon = createIcon("#8B5CF6", "W"); // Purple for Warehouse  
const siteIcon = createIcon("#F97316", "S"); // Orange for Site

// LocalStorage key for persisting map view across tab switches
const VIEW_STORAGE_KEY = "route-planner-map-view-v1";

// Component to fit bounds ONCE per new route (controlled by routeFitToken)
// After initial fit, user's manual zoom/pan is respected until next Route click
// Also handles view persistence across tab switches
function MapViewController({ points, routeFitToken }: { points: RoutePoint[]; routeFitToken: number }) {
  const map = useMap();
  const lastFitTokenRef = useRef<number>(0);
  const hasRestoredViewRef = useRef(false);
  const isInitialMountRef = useRef(true);

  // On mount: try to restore saved view from localStorage
  useEffect(() => {
    if (!map) return;
    if (hasRestoredViewRef.current) return;
    hasRestoredViewRef.current = true;

    if (typeof window === "undefined") return;

    try {
      const raw = window.localStorage.getItem(VIEW_STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { lat: number; lng: number; zoom: number };
        map.setView([saved.lat, saved.lng], saved.zoom);
        // Mark that we've handled initial mount - don't auto-fit
        isInitialMountRef.current = false;
        // Also set lastFitTokenRef to current token so we don't immediately fit
        lastFitTokenRef.current = routeFitToken;
        return;
      }
    } catch (e) {
      console.error("Failed to restore route planner map view", e);
    }

    // No saved view - if we have points and a route token > 0, fit to them
    if (points.length > 0 && routeFitToken > 0) {
      const bounds = L.latLngBounds(points.map(p => [p.lat, p.lng]));
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14 });
      lastFitTokenRef.current = routeFitToken;
    }
    isInitialMountRef.current = false;
  }, [map, points, routeFitToken]);

  // Fit to bounds only when routeFitToken changes (user clicked Route for new route)
  useEffect(() => {
    if (!map) return;
    if (points.length === 0) return;
    if (routeFitToken === 0) return;
    
    // Skip if this is initial mount (handled above) or token hasn't changed
    if (isInitialMountRef.current) return;
    if (routeFitToken === lastFitTokenRef.current) return;

    const bounds = L.latLngBounds(points.map(p => [p.lat, p.lng]));
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14 });
    lastFitTokenRef.current = routeFitToken;
  }, [map, points, routeFitToken]);

  // Save map view to localStorage on every pan/zoom
  useEffect(() => {
    if (!map) return;
    if (typeof window === "undefined") return;

    const handleMoveEnd = () => {
      const center = map.getCenter();
      const zoom = map.getZoom();
      const payload = { lat: center.lat, lng: center.lng, zoom };
      window.localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(payload));
    };

    map.on("moveend", handleMoveEnd);
    return () => {
      map.off("moveend", handleMoveEnd);
    };
  }, [map]);

  return null;
}

// Component to handle map resize (fixes grey tiles issue)
function MapSizeFixer() {
  const map = useMap();

  useEffect(() => {
    // Invalidate size on mount and after short delay
    const timeoutId = setTimeout(() => {
      map.invalidateSize();
    }, 100);

    // Also handle window resize
    const handleResize = () => {
      map.invalidateSize();
    };
    window.addEventListener("resize", handleResize);

    return () => {
      clearTimeout(timeoutId);
      window.removeEventListener("resize", handleResize);
    };
  }, [map]);

  return null;
}

interface RoutePlannerMapProps {
  points: RoutePoint[];
  routeCoordinates: [number, number][] | null; // [lng, lat] pairs from ORS
  routeFitToken: number; // Incremented when a new route is requested, triggers one-time fit-to-bounds
}

export default function RoutePlannerMap({ points, routeCoordinates, routeFitToken }: RoutePlannerMapProps) {
  // Convert ORS coordinates [lng, lat] to Leaflet [lat, lng]
  const routeLatLngs = useMemo(() => {
    if (!routeCoordinates) return [];
    return routeCoordinates.map(([lng, lat]) => [lat, lng] as [number, number]);
  }, [routeCoordinates]);

  // Default center (Saudi Arabia)
  const defaultCenter: [number, number] = [21.5, 39.2];
  const defaultZoom = 6;

  // Get icon based on point type
  const getIcon = (type: RoutePoint["type"]) => {
    switch (type) {
      case "nfo":
        return nfoIcon;
      case "warehouse":
        return warehouseIcon;
      case "site":
        return siteIcon;
      default:
        return nfoIcon;
    }
  };

  return (
    <MapContainer
      center={defaultCenter}
      zoom={defaultZoom}
      className="h-full w-full"
      style={{ minHeight: "400px" }}
    >
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      />
      
      <MapSizeFixer />
      
      <MapViewController points={points} routeFitToken={routeFitToken} />

      {/* Route polyline */}
      {routeLatLngs.length > 0 && (
        <Polyline
          positions={routeLatLngs}
          pathOptions={{
            color: "#22C55E",
            weight: 5,
            opacity: 0.8,
          }}
        />
      )}

      {/* Markers for each point */}
      {points.map((point, idx) => (
        <Marker
          key={`${point.type}-${idx}`}
          position={[point.lat, point.lng]}
          icon={getIcon(point.type)}
        >
          {/* Tooltip with label */}
        </Marker>
      ))}

      {/* Legend */}
      <div className="leaflet-bottom leaflet-left">
        <div className="leaflet-control bg-white rounded-lg shadow-lg p-3 m-3">
          <div className="text-xs font-semibold text-slate-700 mb-2">Legend</div>
          <div className="space-y-1 text-xs">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-full bg-blue-500 border-2 border-white shadow-sm"></div>
              <span className="text-slate-600">NFO</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-full bg-purple-500 border-2 border-white shadow-sm"></div>
              <span className="text-slate-600">Warehouse</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-full bg-orange-500 border-2 border-white shadow-sm"></div>
              <span className="text-slate-600">Site</span>
            </div>
            {routeLatLngs.length > 0 && (
              <div className="flex items-center gap-2 pt-1 border-t border-slate-200">
                <div className="w-4 h-1 bg-green-500 rounded"></div>
                <span className="text-slate-600">Driving route</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </MapContainer>
  );
}
