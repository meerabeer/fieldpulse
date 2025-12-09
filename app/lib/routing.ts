/**
 * Shared routing logic for ORS vs OSRM comparison.
 * Used by both Route Planner and Dashboard NFO Route button.
 * 
 * This module:
 * 1. Computes air distance using haversine
 * 2. Calls ORS backend (/api/ors-route)
 * 3. Calls OSRM public API
 * 4. Compares both and picks the better engine
 * 5. Returns standardized result with warning if route seems suspicious
 */

// Sanity check threshold: if route distance > RATIO_THRESHOLD × air distance, warn user
export const ROUTE_SANITY_RATIO_THRESHOLD = 2.0;

// Engine type for route source tracking
export type RouteEngine = "ors" | "osrm";

// Individual engine result (raw data from each engine)
export interface EngineRouteData {
  distanceKm: number;
  durationMin: number;
  coordinates: [number, number][]; // [lng, lat] pairs
}

// Result from calculateBestRoute
export interface RouteResult {
  distanceKm: number;
  durationMin: number;
  engine: RouteEngine;
  coordinates: [number, number][]; // [lng, lat] pairs (ORS/OSRM format)
  airDistanceKm: number;
  warning?: string;
  isFallback?: boolean; // true if both engines failed and we're showing air distance
  // NEW: Raw results from both engines (for showing alternatives in UI)
  orsResult?: EngineRouteData;
  osrmResult?: EngineRouteData;
}

/**
 * Haversine formula for straight-line distance calculation.
 * Returns distance in kilometers.
 */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
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

/**
 * Call OSRM public API for routing.
 * Returns null if OSRM fails or can't find a route.
 */
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

    console.log("routing.ts OSRM URL:", osrmUrl);

    const response = await fetch(osrmUrl);
    const data = await response.json();

    console.log("routing.ts OSRM response:", data);

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
    console.error("routing.ts OSRM fetch error:", error);
    return null;
  }
}

/**
 * Call ORS backend API for routing.
 * Returns null if ORS fails or can't find a route.
 */
async function fetchOrsRoute(
  coords: [number, number][] // Array of [lng, lat] pairs
): Promise<{ distanceKm: number; durationMin: number; coordinates: [number, number][] } | null> {
  try {
    const response = await fetch("/api/ors-route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        coordinates: coords,
        profile: "driving-car",
      }),
    });

    const data = await response.json();
    console.log("routing.ts ORS response:", data);

    if (data.ok && data.route) {
      return {
        distanceKm: data.route.distanceMeters / 1000,
        durationMin: data.route.durationSeconds / 60,
        coordinates: data.route.coordinates,
      };
    }
    return null;
  } catch (error) {
    console.error("routing.ts ORS fetch error:", error);
    return null;
  }
}

/**
 * Calculate the best route between two points using ORS and OSRM comparison.
 * 
 * This is the main entry point used by both Route Planner and Dashboard.
 * For simple point-to-point routing (no waypoints).
 * 
 * @param startLat - Start latitude (NFO position)
 * @param startLon - Start longitude (NFO position)
 * @param endLat - End latitude (Site position)
 * @param endLon - End longitude (Site position)
 * @returns RouteResult with best route data and optional warning
 */
export async function calculateBestRoute(
  startLat: number,
  startLon: number,
  endLat: number,
  endLon: number
): Promise<RouteResult> {
  // Step 1: Compute air distance with haversine
  const airDistanceKm = haversineKm(startLat, startLon, endLat, endLon);
  
  console.log("routing.ts calculateBestRoute", {
    start: { lat: startLat, lon: startLon },
    end: { lat: endLat, lon: endLon },
    airDistanceKm,
  });

  // Build coordinates array for ORS: [[lng, lat], [lng, lat]]
  const coords: [number, number][] = [
    [startLon, startLat],
    [endLon, endLat],
  ];

  // Step 2: Call ORS
  const orsResult = await fetchOrsRoute(coords);
  
  // Step 3: Call OSRM
  const osrmResult = await fetchOsrmRoute(startLat, startLon, endLat, endLon);

  // Step 4: Extract values
  const orsKm = orsResult?.distanceKm ?? null;
  const orsMin = orsResult?.durationMin ?? null;
  const orsCoords = orsResult?.coordinates ?? null;

  const osrmKm = osrmResult?.distanceKm ?? null;
  const osrmMin = osrmResult?.durationMin ?? null;
  const osrmCoords = osrmResult?.coordinates ?? null;

  // Calculate ratios for sanity check
  const orsRatio = orsKm != null ? orsKm / Math.max(airDistanceKm, 0.001) : null;
  const osrmRatio = osrmKm != null ? osrmKm / Math.max(airDistanceKm, 0.001) : null;

  console.log("routing.ts engine comparison:", {
    orsKm,
    orsRatio,
    osrmKm,
    osrmRatio,
    airDistanceKm,
  });

  // Step 5: Choose the best engine
  let finalEngine: RouteEngine = "ors";
  let finalKm: number;
  let finalMin: number;
  let finalCoords: [number, number][];

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
        console.log("routing.ts: Switching to OSRM (shorter and not crazy)");
      }
    }
  } else if (osrmKm != null && osrmCoords != null && osrmMin != null) {
    // ORS failed but OSRM worked
    finalKm = osrmKm;
    finalMin = osrmMin;
    finalCoords = osrmCoords;
    finalEngine = "osrm";
    console.log("routing.ts: Using OSRM (ORS failed)");
  } else {
    // Both failed - return fallback with air distance
    console.log("routing.ts: Both engines failed - using air distance fallback");
    return {
      distanceKm: airDistanceKm,
      durationMin: 0,
      engine: "ors",
      coordinates: coords, // Just start and end points
      airDistanceKm,
      isFallback: true,
      warning: "Could not calculate driving route. Showing straight-line distance.",
    };
  }

  // Step 6: Warning logic - warn if chosen engine distance > 2× air distance
  const finalRatio = finalKm / Math.max(airDistanceKm, 0.001);
  let warning: string | undefined;

  if (finalRatio > ROUTE_SANITY_RATIO_THRESHOLD) {
    warning = `Driving distance is ${finalKm.toFixed(1)} km vs straight-line ${airDistanceKm.toFixed(1)} km. Map data may be inaccurate in this area.`;
  }

  console.log("routing.ts final decision:", {
    engine: finalEngine,
    finalKm,
    finalMin,
    finalRatio,
    hasWarning: !!warning,
  });

  return {
    distanceKm: finalKm,
    durationMin: finalMin,
    engine: finalEngine,
    coordinates: finalCoords,
    airDistanceKm,
    warning,
    // Include raw results from both engines (if available) for UI alternatives
    orsResult: orsResult ? {
      distanceKm: orsResult.distanceKm,
      durationMin: orsResult.durationMin,
      coordinates: orsResult.coordinates,
    } : undefined,
    osrmResult: osrmResult ? {
      distanceKm: osrmResult.distanceKm,
      durationMin: osrmResult.durationMin,
      coordinates: osrmResult.coordinates,
    } : undefined,
  };
}

/**
 * Result from calculateRouteViaWarehouse - includes individual leg details
 */
export interface MultiLegRouteResult extends RouteResult {
  legs: RouteResult[]; // [NFO→Warehouse, Warehouse→Site]
}

/**
 * Calculate route via warehouse using ORS+OSRM comparison for EACH leg.
 * 
 * This enables OSRM fallback for via-warehouse routes by:
 * 1. Computing best route (ORS vs OSRM) for NFO → Warehouse
 * 2. Computing best route (ORS vs OSRM) for Warehouse → Site
 * 3. Combining results into a single route
 * 
 * Engine selection:
 * - If both legs use ORS → Engine: ORS
 * - If either leg uses OSRM → Engine: OSRM (fallback)
 * 
 * @param nfoLat - NFO latitude
 * @param nfoLon - NFO longitude
 * @param warehouseLat - Warehouse latitude
 * @param warehouseLon - Warehouse longitude
 * @param siteLat - Site latitude
 * @param siteLon - Site longitude
 * @returns MultiLegRouteResult with combined route data
 */
export async function calculateRouteViaWarehouse(
  nfoLat: number,
  nfoLon: number,
  warehouseLat: number,
  warehouseLon: number,
  siteLat: number,
  siteLon: number
): Promise<MultiLegRouteResult> {
  // Step 1: Compute direct NFO→Site air distance for the warning comparison
  // (not the sum of legs - we want to compare against the "as the crow flies" distance)
  const directNfoSiteKm = haversineKm(nfoLat, nfoLon, siteLat, siteLon);

  console.log("routing.ts calculateRouteViaWarehouse", {
    nfo: { lat: nfoLat, lon: nfoLon },
    warehouse: { lat: warehouseLat, lon: warehouseLon },
    site: { lat: siteLat, lon: siteLon },
    directNfoSiteKm,
  });

  // Step 2: Calculate best route for leg 1 (NFO → Warehouse)
  const leg1 = await calculateBestRoute(nfoLat, nfoLon, warehouseLat, warehouseLon);
  console.log("routing.ts leg1 (NFO→Warehouse):", {
    engine: leg1.engine,
    distanceKm: leg1.distanceKm,
    durationMin: leg1.durationMin,
    isFallback: leg1.isFallback,
  });

  // Step 3: Calculate best route for leg 2 (Warehouse → Site)
  const leg2 = await calculateBestRoute(warehouseLat, warehouseLon, siteLat, siteLon);
  console.log("routing.ts leg2 (Warehouse→Site):", {
    engine: leg2.engine,
    distanceKm: leg2.distanceKm,
    durationMin: leg2.durationMin,
    isFallback: leg2.isFallback,
  });

  // Step 4: Check if both legs failed completely
  if (leg1.isFallback && leg2.isFallback) {
    console.log("routing.ts: Both legs failed - returning combined fallback");
    // Both legs failed - return fallback with combined air distance
    const combinedAirKm = leg1.airDistanceKm + leg2.airDistanceKm;
    return {
      distanceKm: combinedAirKm,
      durationMin: 0,
      engine: "ors",
      coordinates: [
        [nfoLon, nfoLat],
        [warehouseLon, warehouseLat],
        [siteLon, siteLat],
      ],
      airDistanceKm: directNfoSiteKm,
      isFallback: true,
      warning: "Could not calculate driving route. Showing straight-line distance.",
      legs: [leg1, leg2],
    };
  }

  // Step 5: Combine legs
  const totalKm = leg1.distanceKm + leg2.distanceKm;
  const totalMin = leg1.durationMin + leg2.durationMin;

  // Combine coordinates - avoid duplicating the warehouse point
  // leg1.coordinates ends at warehouse, leg2.coordinates starts at warehouse
  const combinedCoordinates: [number, number][] = [...leg1.coordinates];
  
  // Skip the first point of leg2 if it's the same as the last point of leg1 (warehouse)
  if (leg2.coordinates.length > 0) {
    const leg2Start = leg2.coordinates[0];
    const leg1End = leg1.coordinates[leg1.coordinates.length - 1];
    
    // Check if they're approximately the same point (within ~10m)
    const isSamePoint = leg1End && leg2Start &&
      Math.abs(leg1End[0] - leg2Start[0]) < 0.0001 &&
      Math.abs(leg1End[1] - leg2Start[1]) < 0.0001;
    
    if (isSamePoint) {
      // Skip first point of leg2 (it's the warehouse, already in leg1)
      combinedCoordinates.push(...leg2.coordinates.slice(1));
    } else {
      combinedCoordinates.push(...leg2.coordinates);
    }
  }

  // Step 6: Determine overall engine
  // If both legs used ORS → ORS; if any leg used OSRM → OSRM (fallback)
  const engine: RouteEngine = (leg1.engine === "ors" && leg2.engine === "ors") ? "ors" : "osrm";

  // Step 7: Warning - compare total driving distance to SUM of leg air distances
  // For via-warehouse routes, fair comparison is: driving vs (NFO→WH air + WH→Site air)
  // NOT: driving vs direct NFO→Site (which ignores the warehouse detour)
  const sumOfLegAirKm = leg1.airDistanceKm + leg2.airDistanceKm;
  const viaWarehouseRatio = totalKm / Math.max(sumOfLegAirKm, 0.001);
  let warning: string | undefined;

  if (viaWarehouseRatio > ROUTE_SANITY_RATIO_THRESHOLD) {
    warning = `Driving distance is ${totalKm.toFixed(1)} km vs straight-line ${sumOfLegAirKm.toFixed(1)} km (NFO→WH + WH→Site). Map data may be inaccurate in this area.`;
  }

  // Also inherit warnings from individual legs if they had issues
  const legWarnings = [leg1.warning, leg2.warning].filter(Boolean);
  if (legWarnings.length > 0 && !warning) {
    // If no overall warning but legs had warnings, note that
    warning = legWarnings.join(" ");
  }

  console.log("routing.ts via-warehouse final result:", {
    engine,
    totalKm,
    totalMin,
    sumOfLegAirKm,
    viaWarehouseRatio,
    hasWarning: !!warning,
    leg1Engine: leg1.engine,
    leg2Engine: leg2.engine,
  });

  // Step 8: Build combined ORS and OSRM results for alternative switching
  // Combine ORS results from both legs (if both have ORS data)
  let combinedOrsResult: EngineRouteData | undefined;
  if (leg1.orsResult && leg2.orsResult) {
    // Combine coordinates, avoiding duplicate warehouse point
    const orsCoords = [...leg1.orsResult.coordinates];
    if (leg2.orsResult.coordinates.length > 0) {
      const leg2Start = leg2.orsResult.coordinates[0];
      const leg1End = leg1.orsResult.coordinates[leg1.orsResult.coordinates.length - 1];
      const isSamePoint = leg1End && leg2Start &&
        Math.abs(leg1End[0] - leg2Start[0]) < 0.0001 &&
        Math.abs(leg1End[1] - leg2Start[1]) < 0.0001;
      if (isSamePoint) {
        orsCoords.push(...leg2.orsResult.coordinates.slice(1));
      } else {
        orsCoords.push(...leg2.orsResult.coordinates);
      }
    }
    combinedOrsResult = {
      distanceKm: leg1.orsResult.distanceKm + leg2.orsResult.distanceKm,
      durationMin: leg1.orsResult.durationMin + leg2.orsResult.durationMin,
      coordinates: orsCoords,
    };
  }

  // Combine OSRM results from both legs (if both have OSRM data)
  let combinedOsrmResult: EngineRouteData | undefined;
  if (leg1.osrmResult && leg2.osrmResult) {
    // Combine coordinates, avoiding duplicate warehouse point
    const osrmCoords = [...leg1.osrmResult.coordinates];
    if (leg2.osrmResult.coordinates.length > 0) {
      const leg2Start = leg2.osrmResult.coordinates[0];
      const leg1End = leg1.osrmResult.coordinates[leg1.osrmResult.coordinates.length - 1];
      const isSamePoint = leg1End && leg2Start &&
        Math.abs(leg1End[0] - leg2Start[0]) < 0.0001 &&
        Math.abs(leg1End[1] - leg2Start[1]) < 0.0001;
      if (isSamePoint) {
        osrmCoords.push(...leg2.osrmResult.coordinates.slice(1));
      } else {
        osrmCoords.push(...leg2.osrmResult.coordinates);
      }
    }
    combinedOsrmResult = {
      distanceKm: leg1.osrmResult.distanceKm + leg2.osrmResult.distanceKm,
      durationMin: leg1.osrmResult.durationMin + leg2.osrmResult.durationMin,
      coordinates: osrmCoords,
    };
  }

  console.log("routing.ts via-warehouse alternatives:", {
    hasOrsResult: !!combinedOrsResult,
    hasOsrmResult: !!combinedOsrmResult,
    orsKm: combinedOrsResult?.distanceKm,
    osrmKm: combinedOsrmResult?.distanceKm,
  });

  return {
    distanceKm: totalKm,
    durationMin: totalMin,
    engine,
    coordinates: combinedCoordinates,
    // Use sum of leg air distances for fair comparison (not direct NFO→Site)
    airDistanceKm: sumOfLegAirKm,
    warning,
    isFallback: false,
    legs: [leg1, leg2],
    // Include combined alternatives for UI switching
    orsResult: combinedOrsResult,
    osrmResult: combinedOsrmResult,
  };
}

/**
 * @deprecated Use calculateRouteViaWarehouse for via-warehouse routes.
 * This function is kept for backwards compatibility but now just calls
 * the new function for 3-point routes.
 * 
 * Calculate route with optional waypoint (e.g., NFO -> Warehouse -> Site).
 * For routes with waypoints, we now use ORS+OSRM comparison per leg.
 * 
 * @param coords - Array of [lng, lat] coordinate pairs (at least 2)
 * @returns RouteResult with route data and optional warning
 */
export async function calculateRouteWithWaypoints(
  coords: [number, number][] // Array of [lng, lat] pairs: NFO, [Warehouse,] Site
): Promise<RouteResult> {
  if (coords.length < 2) {
    throw new Error("At least 2 coordinates required for routing");
  }

  // For 3-point routes (NFO → Warehouse → Site), use the new per-leg comparison
  if (coords.length === 3) {
    const [nfoCoord, warehouseCoord, siteCoord] = coords;
    const [nfoLon, nfoLat] = nfoCoord;
    const [warehouseLon, warehouseLat] = warehouseCoord;
    const [siteLon, siteLat] = siteCoord;
    
    return calculateRouteViaWarehouse(
      nfoLat, nfoLon,
      warehouseLat, warehouseLon,
      siteLat, siteLon
    );
  }

  // For 2-point routes, just use calculateBestRoute
  if (coords.length === 2) {
    const [startCoord, endCoord] = coords;
    const [startLon, startLat] = startCoord;
    const [endLon, endLat] = endCoord;
    return calculateBestRoute(startLat, startLon, endLat, endLon);
  }

  // For routes with more than 3 points, fall back to ORS-only (rare case)
  // Calculate total air distance (sum of legs)
  let airDistanceKm = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const [lon1, lat1] = coords[i];
    const [lon2, lat2] = coords[i + 1];
    airDistanceKm += haversineKm(lat1, lon1, lat2, lon2);
  }

  console.log("routing.ts calculateRouteWithWaypoints (>3 points, ORS only)", {
    coords,
    airDistanceKm,
  });

  // Call ORS (supports waypoints)
  const orsResult = await fetchOrsRoute(coords);

  if (!orsResult) {
    // ORS failed - return fallback with air distance
    console.log("routing.ts: ORS failed for waypoint route - using air distance fallback");
    return {
      distanceKm: airDistanceKm,
      durationMin: 0,
      engine: "ors",
      coordinates: coords,
      airDistanceKm,
      isFallback: true,
      warning: "Could not calculate driving route. Showing straight-line distance.",
    };
  }

  const finalKm = orsResult.distanceKm;
  const finalMin = orsResult.durationMin;
  const finalCoords = orsResult.coordinates;

  // Warning logic - warn if route distance > 2× air distance
  const finalRatio = finalKm / Math.max(airDistanceKm, 0.001);
  let warning: string | undefined;

  if (finalRatio > ROUTE_SANITY_RATIO_THRESHOLD) {
    warning = `Driving distance is ${finalKm.toFixed(1)} km vs straight-line ${airDistanceKm.toFixed(1)} km. Map data may be inaccurate in this area.`;
  }

  console.log("routing.ts waypoint route result:", {
    engine: "ors",
    finalKm,
    finalMin,
    finalRatio,
    hasWarning: !!warning,
  });

  return {
    distanceKm: finalKm,
    durationMin: finalMin,
    engine: "ors",
    coordinates: finalCoords,
    airDistanceKm,
    warning,
  };
}
