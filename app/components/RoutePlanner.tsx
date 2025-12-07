"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import dynamic from "next/dynamic";
import { SiteRecord, calculateDistanceKm, hasValidLocation, formatDistanceLabel } from "../lib/nfoHelpers";

// Dynamic import for the map to avoid SSR issues
const RoutePlannerMap = dynamic(() => import("./RoutePlannerMap"), {
  ssr: false,
  loading: () => (
    <div className="h-full bg-slate-100 rounded-xl flex items-center justify-center">
      <p className="text-slate-500">Loading map...</p>
    </div>
  ),
});

// Types
export type WarehouseRecord = {
  id: number;
  name: string;
  region: string | null;
  latitude: number | null;
  longitude: number | null;
  is_active: boolean;
};

export type EnrichedNfoForRouting = {
  username: string;
  name: string | null;
  lat: number | null;
  lng: number | null;
  home_location: string | null;
};

export type RouteResult = {
  coordinates: [number, number][]; // [lng, lat] pairs
  distanceMeters: number;
  durationSeconds: number;
  viaWarehouse: boolean;
  warehouseName?: string;
  isFallback?: boolean; // True if ORS couldn't route and we're showing straight-line
};

export type RoutePlannerState = {
  selectedSiteId: string;
  selectedWarehouseId: string;
  selectedNfoUsername: string;
  routeResult: RouteResult | null;
  siteSearch: string;
  nfoSearch: string;
};

export type RoutePoint = {
  type: "nfo" | "warehouse" | "site";
  lat: number;
  lng: number;
  label: string;
};

interface RoutePlannerProps {
  nfos: EnrichedNfoForRouting[];
  sites: SiteRecord[];
  warehouses: WarehouseRecord[];
  state: RoutePlannerState;
  onStateChange: (next: RoutePlannerState) => void;
}

export default function RoutePlanner({ nfos, sites, warehouses, state, onStateChange }: RoutePlannerProps) {
  // Helper to update state partially
  const updateState = useCallback((patch: Partial<RoutePlannerState>) => {
    onStateChange({ ...state, ...patch });
  }, [state, onStateChange]);

  // Route loading state (local only - doesn't need persistence)
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);

  // Destructure state for easier access
  const {
    selectedSiteId,
    selectedWarehouseId,
    selectedNfoUsername,
    routeResult,
    siteSearch,
    nfoSearch,
  } = state;

  // Deduplicate sites by site_id (Site_Coordinates can have duplicate site_ids)
  const uniqueSites = useMemo(() => {
    return Array.from(
      new Map(sites.filter(s => s.site_id).map(s => [s.site_id, s])).values()
    );
  }, [sites]);

  // Filter sites based on search
  const filteredSites = useMemo(() => {
    if (!siteSearch.trim()) return uniqueSites;
    const term = siteSearch.toLowerCase();
    return uniqueSites.filter(s =>
      `${s.site_id} ${s.name ?? ""} ${s.area ?? ""}`
        .toLowerCase()
        .includes(term)
    );
  }, [uniqueSites, siteSearch]);

  // Filter NFOs based on search
  const filteredNfos = useMemo(() => {
    if (!nfoSearch.trim()) return nfos;
    const term = nfoSearch.toLowerCase();
    return nfos.filter(n =>
      `${n.username} ${n.name ?? ""} ${n.home_location ?? ""}`
        .toLowerCase()
        .includes(term)
    );
  }, [nfos, nfoSearch]);

  // Filter warehouses to only active ones
  const activeWarehouses = useMemo(() => {
    return warehouses.filter(w => w.is_active);
  }, [warehouses]);

  // Get selected entities
  const selectedSite = useMemo(() => {
    return sites.find(s => s.site_id === selectedSiteId) ?? null;
  }, [sites, selectedSiteId]);

  const selectedWarehouse = useMemo(() => {
    if (!selectedWarehouseId) return null;
    return activeWarehouses.find(w => String(w.id) === selectedWarehouseId) ?? null;
  }, [activeWarehouses, selectedWarehouseId]);

  const selectedNfo = useMemo(() => {
    return nfos.find(n => n.username === selectedNfoUsername) ?? null;
  }, [nfos, selectedNfoUsername]);

  // Check if we can route
  const canRoute = useMemo(() => {
    if (!selectedNfo || !selectedSite) return false;
    if (!hasValidLocation({ lat: selectedNfo.lat, lng: selectedNfo.lng })) return false;
    if (!hasValidLocation({ lat: selectedSite.latitude, lng: selectedSite.longitude })) return false;
    if (selectedWarehouse && !hasValidLocation({ lat: selectedWarehouse.latitude, lng: selectedWarehouse.longitude })) {
      return false;
    }
    return true;
  }, [selectedNfo, selectedSite, selectedWarehouse]);

  // Compute air distances
  const airDistances = useMemo(() => {
    if (!selectedNfo || !selectedSite) return null;
    if (!hasValidLocation({ lat: selectedNfo.lat, lng: selectedNfo.lng })) return null;
    if (!hasValidLocation({ lat: selectedSite.latitude, lng: selectedSite.longitude })) return null;

    const nfoToSite = calculateDistanceKm(
      { lat: selectedNfo.lat, lng: selectedNfo.lng },
      { lat: selectedSite.latitude, lng: selectedSite.longitude }
    );

    let nfoToWarehouse: number | null = null;
    let warehouseToSite: number | null = null;

    if (selectedWarehouse && hasValidLocation({ lat: selectedWarehouse.latitude, lng: selectedWarehouse.longitude })) {
      nfoToWarehouse = calculateDistanceKm(
        { lat: selectedNfo.lat, lng: selectedNfo.lng },
        { lat: selectedWarehouse.latitude, lng: selectedWarehouse.longitude }
      );
      warehouseToSite = calculateDistanceKm(
        { lat: selectedWarehouse.latitude, lng: selectedWarehouse.longitude },
        { lat: selectedSite.latitude, lng: selectedSite.longitude }
      );
    }

    return { nfoToSite, nfoToWarehouse, warehouseToSite };
  }, [selectedNfo, selectedSite, selectedWarehouse]);

  // Build route points for map
  const routePoints = useMemo((): RoutePoint[] => {
    const points: RoutePoint[] = [];

    if (selectedNfo && hasValidLocation({ lat: selectedNfo.lat, lng: selectedNfo.lng })) {
      points.push({
        type: "nfo",
        lat: selectedNfo.lat!,
        lng: selectedNfo.lng!,
        label: selectedNfo.name ? `${selectedNfo.username} – ${selectedNfo.name}` : selectedNfo.username,
      });
    }

    if (selectedWarehouse && hasValidLocation({ lat: selectedWarehouse.latitude, lng: selectedWarehouse.longitude })) {
      points.push({
        type: "warehouse",
        lat: selectedWarehouse.latitude!,
        lng: selectedWarehouse.longitude!,
        label: selectedWarehouse.name,
      });
    }

    if (selectedSite && hasValidLocation({ lat: selectedSite.latitude, lng: selectedSite.longitude })) {
      points.push({
        type: "site",
        lat: selectedSite.latitude!,
        lng: selectedSite.longitude!,
        label: selectedSite.name ? `${selectedSite.site_id} – ${selectedSite.name}` : selectedSite.site_id,
      });
    }

    return points;
  }, [selectedNfo, selectedWarehouse, selectedSite]);

  // Fetch route from ORS backend via our API route (with increased search radius)
  const fetchRoute = useCallback(async () => {
    if (!canRoute || !selectedNfo || !selectedSite) return;

    // Clear previous route data before starting new fetch
    setRouteLoading(true);
    setRouteError(null);
    updateState({ routeResult: null });

    try {
      // Build coordinates array: NFO -> (optional Warehouse) -> Site
      // Format: [lng, lat] pairs as ORS expects
      const coords: [number, number][] = [];
      
      coords.push([selectedNfo.lng!, selectedNfo.lat!]);
      
      if (selectedWarehouse && hasValidLocation({ lat: selectedWarehouse.latitude, lng: selectedWarehouse.longitude })) {
        coords.push([selectedWarehouse.longitude!, selectedWarehouse.latitude!]);
      }
      
      coords.push([selectedSite.longitude!, selectedSite.latitude!]);

      // Debug logging: log coordinates being sent
      console.log("RoutePlanner fetchRoute coords", {
        nfo: { lat: selectedNfo.lat, lng: selectedNfo.lng },
        warehouse: selectedWarehouse ? { lat: selectedWarehouse.latitude, lng: selectedWarehouse.longitude } : null,
        site: { lat: selectedSite.latitude, lng: selectedSite.longitude, id: selectedSite.site_id },
        coordsArray: coords,
      });

      // Call our API route which handles ORS with increased search radius
      const response = await fetch("/api/ors-route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          coordinates: coords,
          profile: "driving-car",
        }),
      });

      const data = await response.json();
      console.log("RoutePlanner API response:", data);

      // Check if ORS could build a route
      if (!data.ok) {
        // ORS could not build a proper driving route even with larger radius.
        // Fallback: create a straight-line route and show neutral message
        console.log("RoutePlanner ORS fallback - creating straight line route");
        
        // Build straight-line coordinates for the fallback polyline
        const straightLineCoords: [number, number][] = coords;
        
        // Calculate straight-line distance for display
        const startPt = { lat: selectedNfo.lat!, lng: selectedNfo.lng! };
        const endPt = { lat: selectedSite.latitude!, lng: selectedSite.longitude! };
        const R = 6371; // Earth's radius in km
        const dLat = (endPt.lat - startPt.lat) * Math.PI / 180;
        const dLon = (endPt.lng - startPt.lng) * Math.PI / 180;
        const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                  Math.cos(startPt.lat * Math.PI / 180) * Math.cos(endPt.lat * Math.PI / 180) *
                  Math.sin(dLon/2) * Math.sin(dLon/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        const airDistanceKm = R * c;

        updateState({
          routeResult: {
            coordinates: straightLineCoords,
            distanceMeters: airDistanceKm * 1000,
            durationSeconds: 0, // Unknown for straight line
            viaWarehouse: !!selectedWarehouse,
            warehouseName: selectedWarehouse?.name,
            isFallback: true, // Flag to indicate this is a straight-line fallback
          },
        });
        // Don't set routeError - keep it neutral
        setRouteLoading(false);
        return;
      }

      // Success - use the route from ORS
      updateState({
        routeResult: {
          coordinates: data.route.coordinates,
          distanceMeters: data.route.distanceMeters,
          durationSeconds: data.route.durationSeconds,
          viaWarehouse: !!selectedWarehouse,
          warehouseName: selectedWarehouse?.name,
          isFallback: false,
        },
      });
    } catch (error) {
      console.error("RoutePlanner fetch error:", error);
      // Even on network error, don't show scary message - just clear the route
      updateState({ routeResult: null });
    } finally {
      setRouteLoading(false);
    }
  }, [canRoute, selectedNfo, selectedSite, selectedWarehouse, updateState]);

  // Clear all selections and route
  const handleClearRoute = useCallback(() => {
    updateState({
      selectedSiteId: "",
      selectedWarehouseId: "",
      selectedNfoUsername: "",
      routeResult: null,
      siteSearch: "",
      nfoSearch: "",
    });
    setRouteError(null);
  }, [updateState]);

  // Format duration
  const formatDuration = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes} min`;
  };

  // Format distance
  const formatDistance = (meters: number): string => {
    const km = meters / 1000;
    return `${km.toFixed(1)} km`;
  };

  return (
    <div className="flex gap-4 h-[calc(100vh-12rem)]">
      {/* Left side: Control panel */}
      <div className="w-80 flex-shrink-0 space-y-4">
        {/* Site selector */}
        <div className="bg-white rounded-xl shadow p-4">
          <label className="block text-sm font-medium text-slate-700 mb-2">
            Site <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            placeholder="Search sites..."
            value={siteSearch}
            onChange={(e) => updateState({ siteSearch: e.target.value })}
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-sky-500"
          />
          <select
            value={selectedSiteId}
            onChange={(e) => updateState({ selectedSiteId: e.target.value })}
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
          >
            <option value="">Select a site... ({filteredSites.length} available)</option>
            {filteredSites
              .sort((a, b) => a.site_id.localeCompare(b.site_id))
              .map((site) => (
                <option key={site.site_id} value={site.site_id}>
                  {site.site_id} – {site.name || "Unnamed"} ({site.area || "No area"})
                </option>
              ))}
          </select>
          {selectedSite && !hasValidLocation({ lat: selectedSite.latitude, lng: selectedSite.longitude }) && (
            <p className="text-xs text-orange-600 mt-1">⚠️ This site has missing coordinates</p>
          )}
        </div>

        {/* Warehouse selector (optional) */}
        <div className="bg-white rounded-xl shadow p-4">
          <label className="block text-sm font-medium text-slate-700 mb-2">
            Warehouse <span className="text-slate-400">(optional)</span>
          </label>
          <select
            value={selectedWarehouseId}
            onChange={(e) => updateState({ selectedWarehouseId: e.target.value })}
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
          >
            <option value="">None</option>
            {activeWarehouses
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((wh) => (
                <option key={wh.id} value={String(wh.id)}>
                  {wh.name} – {wh.region || "No region"}
                </option>
              ))}
          </select>
          {selectedWarehouse && !hasValidLocation({ lat: selectedWarehouse.latitude, lng: selectedWarehouse.longitude }) && (
            <p className="text-xs text-orange-600 mt-1">⚠️ This warehouse has missing coordinates</p>
          )}
        </div>

        {/* NFO selector */}
        <div className="bg-white rounded-xl shadow p-4">
          <label className="block text-sm font-medium text-slate-700 mb-2">
            NFO <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            placeholder="Search NFOs..."
            value={nfoSearch}
            onChange={(e) => updateState({ nfoSearch: e.target.value })}
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-sky-500"
          />
          <select
            value={selectedNfoUsername}
            onChange={(e) => updateState({ selectedNfoUsername: e.target.value })}
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
          >
            <option value="">Select an NFO... ({filteredNfos.length} available)</option>
            {filteredNfos
              .sort((a, b) => a.username.localeCompare(b.username))
              .map((nfo) => (
                <option key={nfo.username} value={nfo.username}>
                  {nfo.username} – {nfo.name || "Unnamed"} ({nfo.home_location || "No area"})
                </option>
              ))}
          </select>
          {selectedNfo && !hasValidLocation({ lat: selectedNfo.lat, lng: selectedNfo.lng }) && (
            <p className="text-xs text-orange-600 mt-1">⚠️ This NFO has no GPS location</p>
          )}
        </div>

        {/* Route buttons */}
        <div className="flex gap-2">
          <button
            onClick={fetchRoute}
            disabled={!canRoute || routeLoading}
            className={`flex-1 py-3 rounded-xl font-medium transition ${
              canRoute && !routeLoading
                ? "bg-sky-600 text-white hover:bg-sky-700"
                : "bg-slate-200 text-slate-400 cursor-not-allowed"
            }`}
          >
            {routeLoading ? "Calculating..." : "Route"}
          </button>
          <button
            onClick={handleClearRoute}
            disabled={routeLoading}
            className="px-4 py-3 rounded-xl font-medium transition border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:opacity-50"
          >
            Clear
          </button>
        </div>

        {/* Error message */}
        {routeError && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm">
            {routeError}
          </div>
        )}

        {/* Route info panel */}
        {routeResult && (
          <div className="bg-white rounded-xl shadow p-4 space-y-3">
            <h3 className="font-semibold text-slate-800 text-sm">Route Summary</h3>
            
            <div className="text-sm text-slate-600 space-y-1">
              {routeResult.isFallback ? (
                <>
                  <p className="font-medium text-slate-700">
                    Direct line: NFO → {routeResult.viaWarehouse ? "Warehouse → " : ""}Site
                  </p>
                  <p className="text-xs text-amber-600">
                    (No road match near site – showing straight line)
                  </p>
                </>
              ) : routeResult.viaWarehouse ? (
                <>
                  <p className="font-medium text-slate-700">
                    NFO → Warehouse → Site
                  </p>
                  <p className="text-xs text-slate-500">
                    via {routeResult.warehouseName}
                  </p>
                </>
              ) : (
                <p className="font-medium text-slate-700">NFO → Site (direct)</p>
              )}
            </div>

            <div className="border-t border-slate-100 pt-3 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-slate-600">
                  {routeResult.isFallback ? "Air distance:" : "Driving distance:"}
                </span>
                <span className="font-semibold text-slate-800">
                  {formatDistance(routeResult.distanceMeters)}
                </span>
              </div>
              {!routeResult.isFallback && (
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600">ETA:</span>
                  <span className="font-semibold text-slate-800">
                    {formatDuration(routeResult.durationSeconds)}
                  </span>
                </div>
              )}
            </div>

            {airDistances && (
              <div className="border-t border-slate-100 pt-3 space-y-2">
                <p className="text-xs text-slate-500 font-medium">Air distances:</p>
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500">NFO → Site:</span>
                  <span className="text-slate-600">
                    {formatDistanceLabel(airDistances.nfoToSite)}
                  </span>
                </div>
                {airDistances.nfoToWarehouse !== null && airDistances.warehouseToSite !== null && (
                  <>
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-500">NFO → Warehouse:</span>
                      <span className="text-slate-600">
                        {formatDistanceLabel(airDistances.nfoToWarehouse)}
                      </span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-slate-500">Warehouse → Site:</span>
                      <span className="text-slate-600">
                        {formatDistanceLabel(airDistances.warehouseToSite)}
                      </span>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* Show air distance even without route */}
        {!routeResult && airDistances && (
          <div className="bg-white rounded-xl shadow p-4">
            <h3 className="font-semibold text-slate-800 text-sm mb-2">Air Distances</h3>
            <div className="space-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-500">NFO → Site:</span>
                <span className="text-slate-600">{formatDistanceLabel(airDistances.nfoToSite)}</span>
              </div>
              {airDistances.nfoToWarehouse !== null && (
                <div className="flex justify-between">
                  <span className="text-slate-500">NFO → Warehouse:</span>
                  <span className="text-slate-600">{formatDistanceLabel(airDistances.nfoToWarehouse)}</span>
                </div>
              )}
              {airDistances.warehouseToSite !== null && (
                <div className="flex justify-between">
                  <span className="text-slate-500">Warehouse → Site:</span>
                  <span className="text-slate-600">{formatDistanceLabel(airDistances.warehouseToSite)}</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Right side: Map */}
      <div className="flex-1 bg-white rounded-xl shadow overflow-hidden">
        <RoutePlannerMap
          points={routePoints}
          routeCoordinates={routeResult?.coordinates ?? null}
        />
      </div>
    </div>
  );
}
