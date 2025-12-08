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

// ============================================================================
// Haversine helper for straight-line distance calculation (Route Planner only)
// ============================================================================
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's radius in km
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ============================================================================
// OSRM public API helper (fallback when ORS returns crazy routes)
// ============================================================================
async function fetchOsrmRoute(
  startLat: number,
  startLon: number,
  endLat: number,
  endLon: number
): Promise<{ distanceKm: number; durationMin: number; coordinates: [number, number][] } | null> {
  try {
    // OSRM public endpoint (uses lon,lat order in URL)
    const osrmUrl =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${startLon},${startLat};${endLon},${endLat}` +
      `?overview=full&geometries=geojson`;

    console.log("RoutePlanner OSRM fallback URL:", osrmUrl);

    const response = await fetch(osrmUrl);
    const data = await response.json();

    console.log("RoutePlanner OSRM response:", data);

    if (data.code === "Ok" && data.routes && data.routes[0]) {
      const route = data.routes[0];
      // OSRM returns GeoJSON coordinates as [lng, lat] which is what we need
      const coordinates: [number, number][] = route.geometry.coordinates;
      return {
        distanceKm: route.distance / 1000,
        durationMin: route.duration / 60,
        coordinates,
      };
    }
    return null;
  } catch (error) {
    console.error("RoutePlanner OSRM fetch error:", error);
    return null;
  }
}

// Sanity check threshold: if ORS route distance > RATIO_THRESHOLD × direct distance, consider OSRM
const ROUTE_SANITY_RATIO_THRESHOLD = 2.0;

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

// Engine type for route source tracking
export type RouteEngineType = "ors" | "osrm";

export type RouteResult = {
  coordinates: [number, number][]; // [lng, lat] pairs
  distanceMeters: number;
  durationSeconds: number;
  viaWarehouse: boolean;
  warehouseName?: string;
  isFallback?: boolean; // True if ORS couldn't route and we're showing straight-line
  engine?: RouteEngineType; // Which routing engine produced this result
  directDistanceKm?: number; // Straight-line distance for comparison
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
  const [routeWarning, setRouteWarning] = useState<string | null>(null);

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

  // Fetch route - ALWAYS compare ORS vs OSRM and pick the better one (Route Planner only)
  // This ensures we don't show unnecessarily long routes when one engine has better data
  const fetchRoute = useCallback(async () => {
    if (!canRoute || !selectedNfo || !selectedSite) return;

    // Clear previous route data before starting new fetch
    setRouteLoading(true);
    setRouteError(null);
    setRouteWarning(null);
    updateState({ routeResult: null });

    try {
      // Build coordinates array: NFO -> (optional Warehouse) -> Site
      // Format: [lng, lat] pairs as ORS expects
      const coords: [number, number][] = [];
      
      coords.push([selectedNfo.lng!, selectedNfo.lat!]);
      
      const hasWarehouse = selectedWarehouse && hasValidLocation({ lat: selectedWarehouse.latitude, lng: selectedWarehouse.longitude });
      if (hasWarehouse) {
        coords.push([selectedWarehouse.longitude!, selectedWarehouse.latitude!]);
      }
      
      coords.push([selectedSite.longitude!, selectedSite.latitude!]);

      // Calculate direct (straight-line) distance for sanity check
      // For multi-leg routes (via warehouse), sum the direct distances
      let directKm: number;
      if (hasWarehouse) {
        const leg1 = haversineKm(selectedNfo.lat!, selectedNfo.lng!, selectedWarehouse.latitude!, selectedWarehouse.longitude!);
        const leg2 = haversineKm(selectedWarehouse.latitude!, selectedWarehouse.longitude!, selectedSite.latitude!, selectedSite.longitude!);
        directKm = leg1 + leg2;
      } else {
        directKm = haversineKm(selectedNfo.lat!, selectedNfo.lng!, selectedSite.latitude!, selectedSite.longitude!);
      }

      console.log("RoutePlanner fetchRoute", {
        nfo: { lat: selectedNfo.lat, lng: selectedNfo.lng },
        warehouse: hasWarehouse ? { lat: selectedWarehouse.latitude, lng: selectedWarehouse.longitude } : null,
        site: { lat: selectedSite.latitude, lng: selectedSite.longitude, id: selectedSite.site_id },
        directDistanceKm: directKm,
      });

      // Step 1: Call our ORS API route
      const orsResponse = await fetch("/api/ors-route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          coordinates: coords,
          profile: "driving-car",
        }),
      });

      const orsData = await orsResponse.json();
      console.log("RoutePlanner ORS response:", orsData);

      // Extract ORS data (may be null if ORS failed)
      let orsKm: number | null = null;
      let orsMin: number | null = null;
      let orsCoords: [number, number][] | null = null;

      if (orsData.ok && orsData.route) {
        orsKm = orsData.route.distanceMeters / 1000;
        orsMin = orsData.route.durationSeconds / 60;
        orsCoords = orsData.route.coordinates;
        console.log("RoutePlanner ORS extracted:", { orsKm, orsMin });
      } else {
        console.log("RoutePlanner ORS failed or no route");
      }

      // Step 2: ALWAYS call OSRM for comparison (for direct routes without warehouse)
      // OSRM public API doesn't support waypoints, so only for direct NFO→Site routes
      let osrmKm: number | null = null;
      let osrmMin: number | null = null;
      let osrmCoords: [number, number][] | null = null;

      if (!hasWarehouse) {
        console.log("RoutePlanner: Calling OSRM for comparison...");
        const osrmResult = await fetchOsrmRoute(
          selectedNfo.lat!,
          selectedNfo.lng!,
          selectedSite.latitude!,
          selectedSite.longitude!
        );

        if (osrmResult) {
          osrmKm = osrmResult.distanceKm;
          osrmMin = osrmResult.durationMin;
          osrmCoords = osrmResult.coordinates;
          console.log("RoutePlanner OSRM extracted:", { osrmKm, osrmMin });
        } else {
          console.log("RoutePlanner OSRM failed or no route");
        }
      }

      // Step 3: Choose the best engine
      // Default to ORS, but switch to OSRM if it's shorter AND not crazy vs air distance
      let finalEngine: RouteEngineType = "ors";
      let finalKm: number;
      let finalMin: number;
      let finalCoords: [number, number][];

      const orsRatio = orsKm != null ? orsKm / Math.max(directKm, 0.001) : null;
      const osrmRatio = osrmKm != null ? osrmKm / Math.max(directKm, 0.001) : null;

      console.log("RoutePlanner engine comparison:", {
        orsKm,
        orsRatio,
        osrmKm,
        osrmRatio,
        directKm,
      });

      // If ORS has valid data, start with that
      if (orsKm != null && orsCoords != null && orsMin != null) {
        finalKm = orsKm;
        finalMin = orsMin;
        finalCoords = orsCoords;
        finalEngine = "ors";

        // Check if OSRM is better: shorter AND not crazy (ratio <= 2.0)
        if (osrmKm != null && osrmCoords != null && osrmMin != null && osrmRatio != null) {
          if (osrmKm < orsKm && osrmRatio <= ROUTE_SANITY_RATIO_THRESHOLD) {
            finalKm = osrmKm;
            finalMin = osrmMin;
            finalCoords = osrmCoords;
            finalEngine = "osrm";
            console.log("RoutePlanner: Switching to OSRM (shorter and not crazy)");
          }
        }
      } else if (osrmKm != null && osrmCoords != null && osrmMin != null) {
        // ORS failed but OSRM worked
        finalKm = osrmKm;
        finalMin = osrmMin;
        finalCoords = osrmCoords;
        finalEngine = "osrm";
        console.log("RoutePlanner: Using OSRM (ORS failed)");
      } else {
        // Both failed - show straight-line fallback
        console.log("RoutePlanner: Both engines failed - using straight line fallback");
        updateState({
          routeResult: {
            coordinates: coords,
            distanceMeters: directKm * 1000,
            durationSeconds: 0,
            viaWarehouse: !!hasWarehouse,
            warehouseName: selectedWarehouse?.name,
            isFallback: true,
            engine: "ors",
            directDistanceKm: directKm,
          },
        });
        setRouteLoading(false);
        return;
      }

      // Step 4: Warning logic - warn if chosen engine distance > 2× air distance
      const finalRatio = finalKm / Math.max(directKm, 0.001);
      let warning: string | null = null;

      if (finalRatio > ROUTE_SANITY_RATIO_THRESHOLD) {
        warning = `Warning: driving distance is ${finalKm.toFixed(1)} km vs straight-line ${directKm.toFixed(1)} km. Map data may be inaccurate in this area.`;
      }

      console.log("RoutePlanner final decision:", {
        engine: finalEngine,
        finalKm,
        finalMin,
        finalRatio,
        hasWarning: !!warning,
      });

      // Set the final result
      setRouteWarning(warning);
      updateState({
        routeResult: {
          coordinates: finalCoords,
          distanceMeters: finalKm * 1000,
          durationSeconds: finalMin * 60,
          viaWarehouse: !!hasWarehouse,
          warehouseName: selectedWarehouse?.name,
          isFallback: false,
          engine: finalEngine,
          directDistanceKm: directKm,
        },
      });
    } catch (error) {
      console.error("RoutePlanner fetch error:", error);
      updateState({ routeResult: null });
      setRouteError("Failed to calculate route. Please try again.");
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
    setRouteWarning(null);
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
              {/* Engine indicator */}
              {!routeResult.isFallback && routeResult.engine && (
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600">Engine:</span>
                  <span className={`font-medium ${routeResult.engine === "osrm" ? "text-purple-600" : "text-green-600"}`}>
                    {routeResult.engine === "osrm" ? "OSRM (fallback)" : "ORS"}
                  </span>
                </div>
              )}
            </div>

            {/* Route warning */}
            {routeWarning && (
              <div className="bg-orange-50 border border-orange-200 rounded-lg p-2 text-xs text-orange-700">
                ⚠️ {routeWarning}
              </div>
            )}

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
