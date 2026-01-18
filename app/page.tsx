"use client";

import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { supabase } from "../lib/supabaseClient";
import {
  NfoStatusRow,
  SiteRecord,
  hasValidLocation,
  calculateDistanceKm,
  getSiteById,
  findNearestSite,
  isOnline,
  ageMinutes,
  formatDistanceLabel,
  computePingStatus,
  computeAssignmentState,
} from "./lib/nfoHelpers";
import LiveMap from "./components/LiveMap";
import NfoRoutesView from "./components/NfoRoutesView";
import RoutePlanner from "./components/RoutePlanner";
import ClusterPlanner from "./components/ClusterPlanner";
import type { WarehouseRecord, RoutePlannerState } from "./components/RoutePlanner";
import {
  calculateBestRoute,
  calculateRouteViaWarehouse,
  type RouteResult as SharedRouteResult,
  type RouteEngine,
  type EngineRouteData,
  ROUTE_SANITY_RATIO_THRESHOLD,
} from "./lib/routing";

const STUCK_MINUTES = 150; // 2.5 hours
const REFRESH_INTERVAL_MS = 30_000; // 30 seconds auto-refresh

/**
 * LocalStorage keys for persistence across hard refresh (F5).
 * 
 * PERSISTED STATE:
 * - Dashboard: selectedTab, statusFilter, areaFilter, searchTerm
 * - Live Map: mapAreaFilter (NFOs_ONLY / All Sites / specific area), mapNfoFilter (legend filter)
 * 
 * This ensures users don't lose their selections when:
 * 1. Switching between tabs (Dashboard ↔ Live Map)
 * 2. Data refreshes every 30 seconds
 * 3. Hard browser refresh (F5)
 */
const LS_KEYS = {
  // Dashboard state
  selectedTab: "nfoDashboard.selectedTab",
  statusFilter: "nfoDashboard.statusFilter",
  areaFilter: "nfoDashboard.areaFilter",
  searchTerm: "nfoDashboard.searchTerm",
  // Live Map state
  mapAreaFilter: "nfoDashboard.mapAreaFilter",   // "NFOs_ONLY", null (All Sites), or area name
  mapNfoFilter: "nfoDashboard.mapNfoFilter",     // null (all), "free", "busy", "on-shift", "off-shift"
};

type EnrichedNfo = NfoStatusRow & {
  isOnline: boolean;
  minutesSinceActive: number | null;
  nearestSiteId: string | null;
  nearestSiteName: string | null;
  nearestSiteDistanceKm: number | null;
  distanceToAssignedSiteKm: number | null; // Distance to site_id (assigned site)
  airDistanceKm: number | null; // Computed air distance (may include warehouse leg)
  distanceLabel: string;
  siteLabel: string;
  isNotActive: boolean;
  pingReason: string;
  // Assignment state flags (computed from computeAssignmentState)
  isBusy: boolean;
  isFree: boolean;
  isOnShift: boolean;
  isOffShift: boolean;
  isDeviceSilent: boolean; // status field from Kotlin app is "device-silent"
};

type Stats = {
  totalNFOs: number;
  onShift: number;
  busy: number;
  free: number;
  offShift: number;
  notActive: number;
};

type AreaSummary = {
  area: string;
  total: number;
  onShift: number;
  busy: number;
  free: number;
  offShift: number;
  notActive: number;
};

type StatusFilter =
  | "all"
  | "onshift"
  | "offshift"
  | "busy"
  | "free"
  | "devicesilent"
  | "notactive";

type KpiCategory = "total" | "onShift" | "busy" | "free" | "offShift" | "notActive";

type View = "dashboard" | "map" | "routes" | "routePlanner" | "clusterPlanner" | "settings";

// Helper to safely read from localStorage (client-side only)
function getStoredValue<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return fallback;
    return stored as unknown as T;
  } catch {
    return fallback;
  }
}

// Helper to safely write to localStorage
function setStoredValue(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore storage errors (e.g., quota exceeded)
  }
}

/**
 * FieldEngineerRow - Renders a single row in the Field Engineers table
 * with per-row Route/Clear functionality using ORS.
 */
interface FieldEngineerRowProps {
  enriched: EnrichedNfo;
  sites: SiteRecord[];
  warehouses: WarehouseRecord[];
}

interface RowRouteResult {
  distanceKm: number;
  durationMin: number | null; // null for fallback (straight-line)
  viaWarehouse: string | null; // warehouse name if routed via warehouse
  isFallback?: boolean; // true if routing engines couldn't find route
  engine?: RouteEngine; // "ors" or "osrm" - which engine produced the result
  warning?: string; // warning if route seems suspicious (> 2x air distance)
  airDistanceKm?: number; // air distance for alternative route ratio check
  // Alternative engine results for switching
  orsResult?: EngineRouteData;
  osrmResult?: EngineRouteData;
}

function FieldEngineerRow({ enriched, sites, warehouses }: FieldEngineerRowProps) {
  const [routeResult, setRouteResult] = useState<RowRouteResult | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);

  // Helper for case-insensitive warehouse name matching
  const namesMatch = (a: string | null, b: string | null): boolean => {
    if (!a || !b) return false;
    return a.toLowerCase().trim() === b.toLowerCase().trim();
  };

  const handleRoute = async () => {
    setRouteLoading(true);
    setRouteError(null);
    setRouteResult(null);

    try {
      // Check NFO has valid coordinates
      if (!hasValidLocation({ lat: enriched.lat, lng: enriched.lng })) {
        throw new Error("NFO has no GPS");
      }

      const nfoPoint = { lat: enriched.lat!, lng: enriched.lng! };
      const assignedSiteId = (enriched.site_id ?? "").trim();

      // Determine target site (same logic as airDistanceKm)
      let targetSite: SiteRecord | null = null;
      if (assignedSiteId) {
        targetSite = getSiteById(sites, assignedSiteId) ?? null;
      }
      if (!targetSite && enriched.nearestSiteId) {
        targetSite = getSiteById(sites, enriched.nearestSiteId) ?? null;
      }

      if (!targetSite || !hasValidLocation({ lat: targetSite.latitude, lng: targetSite.longitude })) {
        throw new Error("No valid destination site");
      }

      const sitePoint = { lat: targetSite.latitude!, lng: targetSite.longitude! };

      // Check if we should route via warehouse
      const warehouseNameTrimmed = (enriched.warehouse_name ?? "").trim();
      const matchingWarehouse = enriched.via_warehouse && warehouseNameTrimmed
        ? warehouses.find(w =>
          namesMatch(w.name, warehouseNameTrimmed) &&
          hasValidLocation({ lat: w.latitude, lng: w.longitude })
        )
        : null;

      // Debug logging
      console.log("FieldEngineerRow route request", {
        username: enriched.username,
        nfo: nfoPoint,
        warehouse: matchingWarehouse ? { lat: matchingWarehouse.latitude, lng: matchingWarehouse.longitude, name: matchingWarehouse.name } : null,
        site: { ...sitePoint, id: targetSite.site_id },
      });

      let result: SharedRouteResult;

      if (matchingWarehouse) {
        // Route via warehouse - uses ORS+OSRM comparison per leg with combined alternatives
        result = await calculateRouteViaWarehouse(
          nfoPoint.lat,
          nfoPoint.lng,
          matchingWarehouse.latitude!,
          matchingWarehouse.longitude!,
          sitePoint.lat,
          sitePoint.lng
        );
      } else {
        // Direct route - use best route comparison (ORS vs OSRM)
        result = await calculateBestRoute(
          nfoPoint.lat,
          nfoPoint.lng,
          sitePoint.lat,
          sitePoint.lng
        );
      }

      // Store result with alternative engine data
      setRouteResult({
        distanceKm: result.distanceKm,
        durationMin: result.isFallback ? null : result.durationMin,
        viaWarehouse: matchingWarehouse ? matchingWarehouse.name : null,
        isFallback: result.isFallback,
        engine: result.engine,
        warning: result.warning,
        airDistanceKm: result.airDistanceKm,
        orsResult: result.orsResult,
        osrmResult: result.osrmResult,
      });
    } catch (err) {
      // Only show error for actual failures (like missing GPS)
      setRouteError(err instanceof Error ? err.message : "Route failed");
    } finally {
      setRouteLoading(false);
    }
  };

  const handleClear = () => {
    setRouteResult(null);
    setRouteError(null);
  };

  // Switch to alternative engine (ORS ↔ OSRM)
  const switchToAlternativeEngine = (targetEngine: RouteEngine) => {
    if (!routeResult) return;

    const alternativeData = targetEngine === "osrm" ? routeResult.osrmResult : routeResult.orsResult;
    if (!alternativeData) return;

    // Calculate new warning based on alternative route
    const airKm = routeResult.airDistanceKm ?? 0;
    const ratio = alternativeData.distanceKm / Math.max(airKm, 0.001);
    const newWarning = ratio > ROUTE_SANITY_RATIO_THRESHOLD
      ? `Driving distance is ${alternativeData.distanceKm.toFixed(1)} km vs straight-line ${airKm.toFixed(1)} km. Map data may be inaccurate in this area.`
      : undefined;

    // Update route result with alternative engine's data
    setRouteResult({
      ...routeResult,
      distanceKm: alternativeData.distanceKm,
      durationMin: alternativeData.durationMin,
      engine: targetEngine,
      warning: newWarning,
    });
  };

  // Compute alternative route info (if available)
  const alternativeRoute = useMemo(() => {
    if (!routeResult || routeResult.isFallback) return null;

    const currentEngine = routeResult.engine;
    const alternativeEngine = currentEngine === "ors" ? "osrm" : "ors";
    const alternativeData = alternativeEngine === "osrm" ? routeResult.osrmResult : routeResult.orsResult;

    if (!alternativeData) return null;

    // Calculate if alternative looks different enough to show
    const currentKm = routeResult.distanceKm;
    const altKm = alternativeData.distanceKm;
    const diffPercent = Math.abs(currentKm - altKm) / Math.max(currentKm, 0.001) * 100;

    // Check if alternative has warning
    const airKm = routeResult.airDistanceKm ?? 0;
    const altRatio = altKm / Math.max(airKm, 0.001);
    const altHasWarning = altRatio > ROUTE_SANITY_RATIO_THRESHOLD;
    const currentHasWarning = !!routeResult.warning;

    // Show alternative if: current has warning OR significant difference (> 10%)
    const shouldShow = currentHasWarning || diffPercent > 10;

    if (!shouldShow) return null;

    return {
      engine: alternativeEngine as RouteEngine,
      distanceKm: altKm,
      durationMin: alternativeData.durationMin,
      hasWarning: altHasWarning,
      isRecommended: currentHasWarning && !altHasWarning,
    };
  }, [routeResult]);

  // Format route summary
  const formatRouteSummary = (result: RowRouteResult): string => {
    const distStr = result.distanceKm.toFixed(2);

    if (result.isFallback) {
      // Fallback: show air distance only, no ETA
      if (result.viaWarehouse) {
        return `${distStr} km (air) via ${result.viaWarehouse}`;
      }
      return `${distStr} km (air)`;
    }

    // Normal route: show distance, ETA, and engine
    const durationStr = Math.round(result.durationMin ?? 0);
    const engineStr = result.engine ? ` (${result.engine.toUpperCase()})` : "";

    if (result.viaWarehouse) {
      return `${distStr} km, ${durationStr} min${engineStr} via ${result.viaWarehouse}`;
    }
    return `${distStr} km, ${durationStr} min${engineStr}`;
  };

  return (
    <tr className="border-b last:border-b-0">
      <td className="py-2 px-2 font-mono text-xs">{enriched.username}</td>
      <td className="py-2 px-2">{enriched.name}</td>
      <td className="py-2 px-2">{enriched.on_shift ? "Yes" : "No"}</td>
      <td className="py-2 px-2">{enriched.status}</td>
      <td className="py-2 px-2">
        {enriched.isNotActive ? (
          <div>
            <span className="text-red-600 font-semibold">Not Active</span>
            <br />
            <span className="text-xs text-gray-500">{enriched.pingReason}</span>
          </div>
        ) : (
          <span className="text-green-600">OK</span>
        )}
      </td>
      <td className="py-2 px-2">{enriched.activity}</td>
      <td className="py-2 px-2 font-mono text-xs">
        {enriched.site_id?.trim() ? enriched.site_id : "-"}
      </td>
      <td className="py-2 px-2 text-xs">{enriched.via_warehouse ? "Yes" : "-"}</td>
      <td className="py-2 px-2 text-xs">{enriched.warehouse_name || "-"}</td>
      <td className="py-2 px-2 text-xs">
        {/* Route column with Route/Clear buttons and result */}
        <div className="flex flex-col gap-1">
          <div className="flex gap-1">
            <button
              onClick={handleRoute}
              disabled={routeLoading}
              className="px-2 py-0.5 text-xs bg-blue-500 text-white rounded hover:bg-blue-600 disabled:bg-blue-300"
            >
              {routeLoading ? "..." : "Route"}
            </button>
            {(routeResult || routeError) && (
              <button
                onClick={handleClear}
                className="px-2 py-0.5 text-xs bg-gray-300 text-gray-700 rounded hover:bg-gray-400"
              >
                Clear
              </button>
            )}
          </div>
          {routeResult && (
            <div className="flex flex-col gap-0.5">
              <span className={`text-xs ${routeResult.isFallback ? "text-amber-600" : "text-green-700"}`}>
                {formatRouteSummary(routeResult)}
              </span>
              {routeResult.warning && (
                <span className="text-[10px] text-orange-600 leading-tight">
                  ⚠️ {routeResult.warning}
                </span>
              )}
              {/* Alternative route option */}
              {alternativeRoute && (
                <div className={`mt-1 p-1.5 rounded text-[10px] ${alternativeRoute.isRecommended
                  ? "bg-purple-50 border border-purple-200"
                  : "bg-gray-50 border border-gray-200"
                  }`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className={alternativeRoute.isRecommended ? "text-purple-700" : "text-gray-600"}>
                      {alternativeRoute.isRecommended ? "💡" : "Alt:"} {alternativeRoute.engine.toUpperCase()}: {alternativeRoute.distanceKm.toFixed(1)} km, {Math.round(alternativeRoute.durationMin)} min
                      {alternativeRoute.hasWarning && <span className="text-orange-500 ml-1">⚠️</span>}
                    </span>
                    <button
                      onClick={() => switchToAlternativeEngine(alternativeRoute.engine)}
                      className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${alternativeRoute.isRecommended
                        ? "bg-purple-600 text-white hover:bg-purple-700"
                        : "bg-gray-200 text-gray-700 hover:bg-gray-300"
                        }`}
                    >
                      Use
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {routeError && (
            <span className="text-red-600 text-xs">{routeError}</span>
          )}
        </div>
      </td>
      <td className="py-2 px-2 text-xs">{enriched.nearestSiteId ?? "-"}</td>
      <td className="py-2 px-2 text-xs">
        {enriched.airDistanceKm != null ? enriched.airDistanceKm.toFixed(2) : "-"}
      </td>
      <td className="py-2 px-2 text-xs text-gray-500">
        {enriched.last_active_at ? new Date(enriched.last_active_at).toLocaleString() : "-"}
      </td>
    </tr>
  );
}

export default function HomePage() {
  // ============================================================
  // UI STATE - Persisted across hard refresh via localStorage
  // ============================================================

  // Dashboard state
  const [activeView, setActiveView] = useState<View>("dashboard");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [areaFilter, setAreaFilter] = useState<string>("all");

  // Live Map state (persisted so it survives tab switching and F5)
  // mapAreaFilter: "NFOs_ONLY" (default), null (All Sites), or specific area name
  const [mapAreaFilter, setMapAreaFilter] = useState<string | null>("NFOs_ONLY");
  // mapNfoFilter: null (show all NFOs), "free", "busy", "on-shift", or "off-shift"
  const [mapNfoFilter, setMapNfoFilter] = useState<string | null>(null);

  // Active KPI category for the NFO list panel
  const [activeKpi, setActiveKpi] = useState<KpiCategory | null>("total");

  // Route Planner state - persists across tab switches (not F5)
  const [routePlannerState, setRoutePlannerState] = useState<RoutePlannerState>({
    selectedSiteId: "",
    selectedWarehouseId: "",
    selectedNfoUsername: "",
    routeResult: null,
    siteSearch: "",
    nfoSearch: "",
  });

  // ============================================================
  // DATA STATE - Refreshed every 30 seconds from Supabase
  // ============================================================
  const [nfos, setNfos] = useState<NfoStatusRow[]>([]);
  const [sites, setSites] = useState<SiteRecord[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Track last successful refresh time
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  // Ref to track if initial load is complete (for showing loading state only on first load)
  const initialLoadComplete = useRef(false);

  // Restore persisted UI state from localStorage on mount (client-side only)
  useEffect(() => {
    // Dashboard state
    const storedTab = getStoredValue(LS_KEYS.selectedTab, "dashboard") as View;
    const storedStatus = getStoredValue(LS_KEYS.statusFilter, "all") as StatusFilter;
    const storedArea = getStoredValue(LS_KEYS.areaFilter, "all");
    const storedSearch = getStoredValue(LS_KEYS.searchTerm, "");

    setActiveView(storedTab);
    setStatusFilter(storedStatus);
    setAreaFilter(storedArea);
    setSearch(storedSearch);

    // Live Map state - read as string, then parse
    const storedMapArea = getStoredValue<string>(LS_KEYS.mapAreaFilter, "NFOs_ONLY");
    const storedMapNfo = getStoredValue<string>(LS_KEYS.mapNfoFilter, "");

    // Handle "null" string for "All Sites", otherwise use stored value
    if (storedMapArea === "null") {
      setMapAreaFilter(null);
    } else if (storedMapArea) {
      setMapAreaFilter(storedMapArea);
    }

    // Handle "null" string for "all NFOs", otherwise use stored value
    if (storedMapNfo === "null" || storedMapNfo === "") {
      setMapNfoFilter(null);
    } else {
      setMapNfoFilter(storedMapNfo);
    }
  }, []);

  // Persist UI state changes to localStorage
  const handleSetActiveView = useCallback((view: View) => {
    setActiveView(view);
    setStoredValue(LS_KEYS.selectedTab, view);
  }, []);

  const handleSetStatusFilter = useCallback((filter: StatusFilter) => {
    setStatusFilter(filter);
    setStoredValue(LS_KEYS.statusFilter, filter);
  }, []);

  const handleSetAreaFilter = useCallback((area: string) => {
    setAreaFilter(area);
    setStoredValue(LS_KEYS.areaFilter, area);
  }, []);

  const handleSetSearch = useCallback((term: string) => {
    setSearch(term);
    setStoredValue(LS_KEYS.searchTerm, term);
  }, []);

  // Live Map state handlers - persist to localStorage
  const handleSetMapAreaFilter = useCallback((area: string | null) => {
    setMapAreaFilter(area);
    // Store null as string "null" so we can distinguish from empty
    setStoredValue(LS_KEYS.mapAreaFilter, area === null ? "null" : area);
  }, []);

  const handleSetMapNfoFilter = useCallback((filter: string | null) => {
    setMapNfoFilter(filter);
    setStoredValue(LS_KEYS.mapNfoFilter, filter === null ? "null" : filter);
  }, []);

  // Main data fetching function - called on mount and every 30 seconds
  const fetchDashboardData = useCallback(async (isInitialLoad: boolean = false) => {
    try {
      // Only show loading spinner on initial load, not on refresh
      if (isInitialLoad) {
        setLoading(true);
      }
      setRefreshError(null);

      // 1) Load all heartbeat/status rows, newest first
      const { data, error: nfoError } = await supabase
        .from("nfo_status")
        .select(
          "username, name, on_shift, status, activity, site_id, lat, lng, logged_in, last_active_at, home_location, via_warehouse, warehouse_name"
        )
        .order("last_active_at", { ascending: false });

      if (nfoError) throw nfoError;

      const rows = (data ?? []) as NfoStatusRow[];

      // 1b) Load Site_Coordinates - fetch ALL sites using pagination
      let allSiteRows: any[] = [];
      let pageNumber = 0;
      const PAGE_SIZE = 1000;
      let hasMoreRows = true;

      while (hasMoreRows) {
        const start = pageNumber * PAGE_SIZE;
        const end = start + PAGE_SIZE - 1;

        const { data: siteRowsPage, error: siteError } = await supabase
          .from("Site_Coordinates")
          .select("site_id, site_name, latitude, longitude, area")
          .range(start, end);

        if (siteError) throw siteError;

        if (!siteRowsPage || siteRowsPage.length === 0) {
          hasMoreRows = false;
          break;
        }

        allSiteRows = allSiteRows.concat(siteRowsPage);

        if (siteRowsPage.length < PAGE_SIZE) {
          hasMoreRows = false;
        }

        pageNumber++;
      }

      if (isInitialLoad) {
        console.log("Site rows from Supabase:", allSiteRows.length, "rows (fetched across", pageNumber, "pages)");
      }

      const siteRecords: SiteRecord[] =
        (allSiteRows ?? []).map((row: any) => {
          const lat = typeof row.latitude === "string" ? parseFloat(row.latitude) : row.latitude;
          const lng = typeof row.longitude === "string" ? parseFloat(row.longitude) : row.longitude;
          return {
            site_id: row.site_id,
            name: row.site_name ?? null,
            latitude: Number.isFinite(lat) ? lat : null,
            longitude: Number.isFinite(lng) ? lng : null,
            area: row.area ?? null,
          };
        }) ?? [];

      setSites(siteRecords);

      // 1c) Load warehouses
      const { data: warehouseRows, error: warehouseError } = await supabase
        .from("warehouses")
        .select("id, name, region, latitude, longitude, is_active");

      if (warehouseError) {
        console.warn("Failed to load warehouses:", warehouseError);
        // Don't throw - warehouses are optional for the app to function
      } else {
        const warehouseRecords: WarehouseRecord[] = (warehouseRows ?? []).map((row: any) => {
          const lat = typeof row.latitude === "string" ? parseFloat(row.latitude) : row.latitude;
          const lng = typeof row.longitude === "string" ? parseFloat(row.longitude) : row.longitude;
          return {
            id: row.id,
            name: row.name ?? "",
            region: row.region ?? null,
            latitude: Number.isFinite(lat) ? lat : null,
            longitude: Number.isFinite(lng) ? lng : null,
            is_active: row.is_active ?? false,
          };
        });
        setWarehouses(warehouseRecords);

        if (isInitialLoad) {
          console.log("Warehouse rows from Supabase:", warehouseRecords.length, "rows");
        }
      }

      // 2) Keep only latest row per username
      const latestByUser = new Map<string, NfoStatusRow>();
      for (const row of rows) {
        if (!row.username) continue;
        if (!latestByUser.has(row.username)) {
          latestByUser.set(row.username, row);
        }
      }

      const current = Array.from(latestByUser.values());

      // 3) Compute stats - these are basic counts from raw data
      //    Full stats with enriched flags will be computed after enrichedNfos
      const totalNFOs = current.length;

      setNfos(current);
      setLastRefresh(new Date());
      setError(null);
      initialLoadComplete.current = true;
    } catch (err: any) {
      // Extract error message safely
      const errorMsg = err instanceof Error ? err.message : String(err ?? "Unknown error");

      /*
       * ERROR HANDLING STRATEGY:
       * - Initial load: Show full error screen (user needs to know something is wrong)
       * - Subsequent refreshes: Keep existing data visible, show small warning
       * - Use console.warn instead of console.error to avoid Next.js red overlay
       */
      if (isInitialLoad || !initialLoadComplete.current) {
        // Initial load failed - show error screen
        setError(errorMsg);
        console.warn("[Dashboard] Initial load failed:", errorMsg);
      } else {
        // Refresh failed - KEEP existing data, just show warning
        // Do NOT clear nfos, sites, stats - they stay as-is from last successful fetch
        setRefreshError(errorMsg);
        console.warn("[Dashboard] Auto-refresh failed (keeping last good data):", errorMsg);
      }
    } finally {
      if (isInitialLoad) {
        setLoading(false);
      }
    }
  }, []);

  // Initial load and auto-refresh interval
  useEffect(() => {
    // Initial fetch
    fetchDashboardData(true);

    // Set up 30-second polling interval
    const intervalId = setInterval(() => {
      fetchDashboardData(false);
    }, REFRESH_INTERVAL_MS);

    // Cleanup on unmount
    return () => {
      clearInterval(intervalId);
    };
  }, [fetchDashboardData]);

  const areas = useMemo(
    () =>
      Array.from(
        new Set(
          nfos
            .map((row) => row.home_location)
            .filter((x): x is string => !!x && x.trim() !== "")
        )
      ),
    [nfos]
  );

  const filteredNfos = useMemo(
    () =>
      nfos.filter((row) => {
        const term = search.trim().toLowerCase();

        const matchesSearch =
          term === "" ||
          row.username.toLowerCase().includes(term) ||
          (row.name ?? "").toLowerCase().includes(term);

        let matchesStatus = true;
        const loggedIn = !!row.logged_in;
        const onShift = !!row.on_shift;
        const { isBusy, isFree } = computeAssignmentState(row);

        switch (statusFilter) {
          case "busy":
            matchesStatus = isBusy;
            break;
          case "free":
            matchesStatus = isFree;
            break;
          case "onshift":
            matchesStatus = onShift;
            break;
          case "offshift":
            matchesStatus = !onShift;
            break;
          case "devicesilent": {
            // Check if NFO status is device-silent (from Kotlin app)
            const statusLower = (row.status ?? "").toLowerCase().trim();
            matchesStatus = statusLower === "device-silent";
            break;
          }
          case "notactive": {
            // Check if NFO is not active (no ping > 30 min)
            const { isNotActive } = computePingStatus(row.last_active_at);
            matchesStatus = isNotActive;
            break;
          }
          default:
            matchesStatus = true;
        }

        const matchesArea = areaFilter === "all" || row.home_location === areaFilter;

        return (
          matchesSearch &&
          matchesStatus &&
          matchesArea
        );
      }),
    [nfos, search, statusFilter, areaFilter]
  );

  const stuckNfos = useMemo(
    () =>
      nfos
        .filter((row) => {
          if (!row.last_active_at) return false;

          const loggedIn = !!row.logged_in;
          const onShift = !!row.on_shift;
          const s = (row.status ?? "").toLowerCase();

          if (!loggedIn || !onShift || s !== "busy") return false;

          const last = new Date(row.last_active_at).getTime();
          const now = Date.now();
          const diffMinutes = (now - last) / 1000 / 60;

          return diffMinutes >= STUCK_MINUTES;
        })
        .map((row) => {
          const last = row.last_active_at
            ? new Date(row.last_active_at).getTime()
            : Date.now();
          const now = Date.now();
          const diffMinutes = Math.max(0, (now - last) / 1000 / 60);

          return {
            ...row,
            minutesSinceActive: Math.round(diffMinutes),
          };
        })
        // sort longest stuck first
        .sort((a, b) => b.minutesSinceActive - a.minutesSinceActive),
    [nfos]
  );

  const enrichedNfos = useMemo(() => {
    // Helper for case-insensitive warehouse name matching
    const namesMatch = (a: string | null | undefined, b: string | null | undefined): boolean => {
      if (!a || !b) return false;
      return a.trim().toLowerCase() === b.trim().toLowerCase();
    };

    return nfos.map((nfo) => {
      // Calculate online status
      const online = isOnline(nfo.last_active_at);
      const minutesSinceActive = ageMinutes(nfo.last_active_at);

      // Determine which site to show
      let nearestSiteId: string | null = null;
      let nearestSiteName: string | null = null;
      let nearestSiteDistanceKm: number | null = null;
      let distanceToAssignedSiteKm: number | null = null;
      let airDistanceKm: number | null = null;
      let distanceLabel = "N/A";
      let siteLabel = "N/A";

      // Use new assignment-based busy/free and shift logic
      const { isBusy, isFree, isOnShift, isOffShift } = computeAssignmentState(nfo);

      const hasValidNfoCoords = hasValidLocation({ lat: nfo.lat, lng: nfo.lng });
      const assignedSiteId = (nfo.site_id ?? "").trim();

      // Compute distance to assigned site (site_id) if available
      if (assignedSiteId && hasValidNfoCoords) {
        const assignedSite = getSiteById(sites, assignedSiteId);
        if (
          assignedSite &&
          hasValidLocation({ lat: assignedSite.latitude, lng: assignedSite.longitude })
        ) {
          distanceToAssignedSiteKm = calculateDistanceKm(
            { lat: nfo.lat, lng: nfo.lng },
            { lat: assignedSite.latitude, lng: assignedSite.longitude }
          );
        }
      }

      // Always find the nearest site (for the "Nearest site" column)
      const nearest = findNearestSite(
        { lat: nfo.lat, lng: nfo.lng },
        sites
      );

      if (nearest) {
        const siteRec = nearest.site as SiteRecord;
        nearestSiteId = siteRec.site_id;
        nearestSiteName = siteRec.name ?? null;
        nearestSiteDistanceKm = nearest.distanceKm;
        distanceLabel = formatDistanceLabel(nearest.distanceKm);

        if (isBusy && assignedSiteId) {
          siteLabel = `Busy at site ${assignedSiteId} - ${distanceToAssignedSiteKm !== null ? formatDistanceLabel(distanceToAssignedSiteKm) : "N/A"}`;
        } else if (isFree && nfo.on_shift) {
          siteLabel = `Free near site ${nearestSiteId} - ${distanceLabel}`;
        } else {
          siteLabel = `Nearest site ${nearestSiteId} - ${distanceLabel}`;
        }
      } else if (!hasValidLocation({ lat: nfo.lat, lng: nfo.lng })) {
        siteLabel = "No GPS";
      } else if (isBusy && assignedSiteId) {
        siteLabel = `Busy at site ${assignedSiteId} - N/A (missing coordinates)`;
      }

      // Compute airDistanceKm with via_warehouse logic
      // Priority: 
      // 1. If site_id + via_warehouse + valid warehouse -> NFO->Warehouse + Warehouse->Site
      // 2. If site_id but no warehouse -> NFO->Site direct
      // 3. No site_id -> NFO->Nearest site
      if (hasValidNfoCoords) {
        let targetSite: SiteRecord | null = null;

        // Try to get assigned site first
        if (assignedSiteId) {
          targetSite = getSiteById(sites, assignedSiteId) ?? null;
        }

        // Fall back to nearest site if no assigned site
        if (!targetSite && nearest) {
          targetSite = nearest.site as SiteRecord;
        }

        if (targetSite && hasValidLocation({ lat: targetSite.latitude, lng: targetSite.longitude })) {
          const nfoPoint = { lat: nfo.lat!, lng: nfo.lng! };
          const sitePoint = { lat: targetSite.latitude!, lng: targetSite.longitude! };

          // Check if we should route via warehouse
          const warehouseNameTrimmed = (nfo.warehouse_name ?? "").trim();
          const matchingWarehouse = nfo.via_warehouse && warehouseNameTrimmed
            ? warehouses.find(w =>
              namesMatch(w.name, warehouseNameTrimmed) &&
              hasValidLocation({ lat: w.latitude, lng: w.longitude })
            )
            : null;

          if (matchingWarehouse) {
            // Route via warehouse: NFO -> Warehouse + Warehouse -> Site
            const whPoint = { lat: matchingWarehouse.latitude!, lng: matchingWarehouse.longitude! };
            const leg1 = calculateDistanceKm(nfoPoint, whPoint);
            const leg2 = calculateDistanceKm(whPoint, sitePoint);
            airDistanceKm = leg1 + leg2;
          } else {
            // Direct route: NFO -> Site
            airDistanceKm = calculateDistanceKm(nfoPoint, sitePoint);
          }
        }
      }

      // Compute ping status (not active if no ping > 30 min)
      const { isNotActive, pingReason } = computePingStatus(nfo.last_active_at);

      // Compute device-silent flag (status from Kotlin app)
      const statusLower = (nfo.status ?? "").toLowerCase().trim();
      const isDeviceSilent = statusLower === "device-silent";

      return {
        ...nfo,
        isOnline: online,
        minutesSinceActive,
        nearestSiteId,
        nearestSiteName,
        nearestSiteDistanceKm,
        distanceToAssignedSiteKm,
        airDistanceKm,
        distanceLabel,
        siteLabel,
        isNotActive,
        pingReason,
        // Assignment state flags
        isBusy,
        isFree,
        isOnShift,
        isOffShift,
        isDeviceSilent,
      };
    });
  }, [nfos, sites, warehouses]);

  // Compute stats from enrichedNfos using the computed flags
  const stats = useMemo((): Stats => {
    return {
      totalNFOs: enrichedNfos.length,
      onShift: enrichedNfos.filter(n => n.isOnShift).length,
      busy: enrichedNfos.filter(n => n.isBusy).length,
      free: enrichedNfos.filter(n => n.isFree).length,
      offShift: enrichedNfos.filter(n => n.isOffShift).length,
      notActive: enrichedNfos.filter(n => n.isNotActive).length,
    };
  }, [enrichedNfos]);

  // Compute area summary from enrichedNfos
  const areaSummary = useMemo(() => {
    const summaryMap = new Map<string, AreaSummary>();

    for (const area of areas) {
      summaryMap.set(area, {
        area,
        total: 0,
        onShift: 0,
        busy: 0,
        free: 0,
        offShift: 0,
        notActive: 0,
      });
    }

    // Use enrichedNfos to get the computed flags
    for (const nfo of enrichedNfos) {
      const area = nfo.home_location?.trim();
      if (!area) continue;

      const summary = summaryMap.get(area);
      if (!summary) continue;

      summary.total += 1;
      if (nfo.isOnShift) summary.onShift += 1;
      if (nfo.isBusy) summary.busy += 1;
      if (nfo.isFree) summary.free += 1;
      if (nfo.isOffShift) summary.offShift += 1;
      if (nfo.isNotActive) summary.notActive += 1;
    }

    return Array.from(summaryMap.values());
  }, [enrichedNfos, areas]);

  // Generate NFO lists for KPI panel (replaces old tooltip strings)
  const kpiLists = useMemo((): Record<KpiCategory, { label: string; items: string[] }> => {
    const formatName = (n: EnrichedNfo) => n.name ? `${n.username} – ${n.name}` : n.username;

    return {
      total: {
        label: "Total NFOs",
        items: enrichedNfos.map(formatName),
      },
      onShift: {
        label: "On-shift NFOs",
        items: enrichedNfos.filter(n => n.isOnShift).map(formatName),
      },
      busy: {
        label: "Busy NFOs",
        items: enrichedNfos.filter(n => n.isBusy).map(formatName),
      },
      free: {
        label: "Free NFOs",
        items: enrichedNfos.filter(n => n.isFree).map(formatName),
      },
      offShift: {
        label: "Off-shift NFOs",
        items: enrichedNfos.filter(n => n.isOffShift).map(formatName),
      },
      notActive: {
        label: "Not Active (>30m) NFOs",
        items: enrichedNfos.filter(n => n.isNotActive).map(formatName),
      },
    };
  }, [enrichedNfos]);

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p>Loading manager dashboard…</p>
      </main>
    );
  }

  if (error) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <div className="max-w-md bg-white shadow rounded-xl p-6">
          <p className="font-semibold mb-2">Error</p>
          <p className="text-sm text-red-600 break-all">{error}</p>
        </div>
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Sidebar */}
      <aside className="w-64 bg-slate-900 text-slate-100 flex flex-col">
        <div className="px-4 py-4 border-b border-slate-800">
          <h1 className="text-lg font-semibold">NFO Manager</h1>
          <p className="text-xs text-slate-400">Web console</p>
        </div>
        <nav className="flex-1 px-2 py-4 space-y-1 text-sm">
          {[
            { id: "dashboard", label: "Dashboard" },
            { id: "map", label: "Live map" },
            { id: "routePlanner", label: "Route Planner" },
            { id: "clusterPlanner", label: "Cluster Planner" },
            // { id: "routes", label: "NFO routes" },  // Hidden from sidebar
            // { id: "settings", label: "Settings" }, // Hidden from sidebar
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => handleSetActiveView(item.id as View)}
              className={[
                "w-full text-left px-3 py-2 rounded-md transition",
                activeView === item.id
                  ? "bg-slate-700 text-white"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white",
              ].join(" ")}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="px-4 py-3 border-t border-slate-800 text-xs text-slate-500">
          <div>Data source: Supabase · nfo_status</div>
          {lastRefresh && (
            <div className={`mt-1 ${refreshError ? "text-orange-400" : "text-slate-400"}`}>
              Last refresh: {lastRefresh.toLocaleTimeString()}
              {refreshError && " ⚠️"}
            </div>
          )}
          <div className="mt-1 text-slate-400">
            Auto-refresh: every 30s
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 px-4 py-8 overflow-auto">
        {/* Global refresh error banner - shows on all tabs when auto-refresh fails */}
        {refreshError && (
          <div className="max-w-6xl mx-auto mb-4">
            <div className="bg-orange-50 border border-orange-200 rounded-lg px-4 py-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-orange-500">⚠️</span>
                <span className="text-sm text-orange-700">
                  Auto-refresh failed: {refreshError}. Showing last successful data.
                </span>
              </div>
              <span className="text-xs text-orange-500">
                Retrying in {Math.round(REFRESH_INTERVAL_MS / 1000)}s...
              </span>
            </div>
          </div>
        )}

        {activeView === "dashboard" && (
          <div className="max-w-5xl mx-auto space-y-6">
            <header className="flex items-center justify-between">
              <h1 className="text-2xl font-bold">
                Dashboard
              </h1>
              <div className="text-right">
                <span className="text-xs text-gray-500 block">
                  Data source: Supabase · table nfo_status
                </span>
                {refreshError && (
                  <span className="text-xs text-orange-600 block">
                    ⚠️ Refresh failed: {refreshError}
                  </span>
                )}
              </div>
            </header>

            {/* KPI cards - Order: Total, On shift, Busy, Free, Off shift, Not Active */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
              <StatCard
                label="Total NFOs"
                value={stats.totalNFOs}
                accent="bg-sky-500"
                isActive={activeKpi === "total"}
                onMouseEnter={() => setActiveKpi("total")}
              />
              <StatCard
                label="On shift"
                value={stats.onShift}
                accent="bg-emerald-500"
                isActive={activeKpi === "onShift"}
                onMouseEnter={() => setActiveKpi("onShift")}
              />
              <StatCard
                label="Busy"
                value={stats.busy}
                accent="bg-red-500"
                isActive={activeKpi === "busy"}
                onMouseEnter={() => setActiveKpi("busy")}
              />
              <StatCard
                label="Free"
                value={stats.free}
                accent="bg-green-500"
                isActive={activeKpi === "free"}
                onMouseEnter={() => setActiveKpi("free")}
              />
              <StatCard
                label="Off shift"
                value={stats.offShift}
                accent="bg-gray-400"
                isActive={activeKpi === "offShift"}
                onMouseEnter={() => setActiveKpi("offShift")}
              />
              <StatCard
                label="Not Active (>30m)"
                value={stats.notActive}
                accent="bg-yellow-500"
                isActive={activeKpi === "notActive"}
                onMouseEnter={() => setActiveKpi("notActive")}
              />
            </div>

            {/* NFO List Panel - shows NFOs for the active KPI category */}
            {activeKpi && (
              <div className="rounded-xl border border-slate-200 bg-white p-4 max-h-48 overflow-y-auto shadow-sm">
                <div className="flex items-baseline justify-between mb-2">
                  <h3 className="font-semibold text-sm text-slate-700">
                    {kpiLists[activeKpi].label}
                  </h3>
                  <span className="text-xs text-slate-500">
                    {kpiLists[activeKpi].items.length} NFOs
                  </span>
                </div>
                {kpiLists[activeKpi].items.length === 0 ? (
                  <div className="text-xs text-slate-400">No NFOs in this category.</div>
                ) : (
                  <ul className="text-xs text-slate-700 space-y-1">
                    {kpiLists[activeKpi].items.map((item, idx) => (
                      <li key={idx} className="truncate">
                        {item}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* Stuck at site > 2.5 hours panel */}
            {stuckNfos.length > 0 && (
              <section className="bg-white rounded-xl shadow p-4 border-l-4 border-red-500">
                <h2 className="text-lg font-semibold mb-3 text-red-700">
                  NFOs busy at site for &gt; 2.5 hours
                </h2>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="border-b bg-slate-50">
                        <th className="text-left py-2 px-2">Username</th>
                        <th className="text-left py-2 px-2">Name</th>
                        <th className="text-left py-2 px-2">Area</th>
                        <th className="text-left py-2 px-2">Site ID</th>
                        <th className="text-left py-2 px-2">Activity</th>
                        <th className="text-left py-2 px-2">Last active</th>
                        <th className="text-left py-2 px-2">Minutes stuck</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stuckNfos.map((nfo) => (
                        <tr key={nfo.username} className="border-b last:border-b-0 bg-red-50">
                          <td className="py-2 px-2 font-mono text-xs">{nfo.username}</td>
                          <td className="py-2 px-2">{nfo.name}</td>
                          <td className="py-2 px-2">{nfo.home_location ?? "-"}</td>
                          <td className="py-2 px-2 font-mono text-xs">
                            {nfo.site_id?.trim() ? nfo.site_id : "-"}
                          </td>
                          <td className="py-2 px-2">{nfo.activity ?? "-"}</td>
                          <td className="py-2 px-2 text-xs text-gray-500">
                            {nfo.last_active_at
                              ? new Date(nfo.last_active_at).toLocaleString()
                              : "-"}
                          </td>
                          <td className="py-2 px-2 font-semibold text-red-600">
                            {nfo.minutesSinceActive}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {/* Area summary section */}
            {areaSummary.length > 0 && (
              <section className="bg-white rounded-xl shadow p-4">
                <h2 className="text-lg font-semibold mb-3">Area summary</h2>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm border-collapse">
                    <thead>
                      <tr className="bg-slate-50 border-b">
                        <th className="text-left px-3 py-2 font-semibold">Area</th>
                        <th className="text-center px-3 py-2 font-semibold">Total</th>
                        <th className="text-center px-3 py-2 font-semibold">On shift</th>
                        <th className="text-center px-3 py-2 font-semibold">Busy</th>
                        <th className="text-center px-3 py-2 font-semibold">Free</th>
                        <th className="text-center px-3 py-2 font-semibold">Off shift</th>
                        <th className="text-center px-3 py-2 font-semibold">Not Active</th>
                      </tr>
                    </thead>
                    <tbody>
                      {areaSummary.map((summary) => (
                        <tr key={summary.area} className="border-b hover:bg-slate-50">
                          <td className="text-left px-3 py-2">{summary.area}</td>
                          <td className="text-center px-3 py-2">{summary.total}</td>
                          <td className="text-center px-3 py-2">{summary.onShift}</td>
                          <td className="text-center px-3 py-2">{summary.busy}</td>
                          <td className="text-center px-3 py-2">{summary.free}</td>
                          <td className="text-center px-3 py-2">{summary.offShift}</td>
                          <td className="text-center px-3 py-2">{summary.notActive}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {/* Simple list of current NFO statuses */}
            <section className="bg-white rounded-xl shadow p-4">
              <h2 className="text-lg font-semibold mb-3">
                Field Engineers ( Status )
              </h2>
              <div className="flex flex-wrap items-center gap-3 mb-4 text-sm">
                <input
                  type="text"
                  value={search}
                  onChange={(e) => handleSetSearch(e.target.value)}
                  placeholder="Search by username or name"
                  className="border rounded-md px-3 py-1 text-sm"
                />
                <select
                  value={statusFilter}
                  onChange={(e) =>
                    handleSetStatusFilter(e.target.value as StatusFilter)
                  }
                  className="border rounded-md px-2 py-1 text-sm"
                >
                  <option value="all">All statuses</option>
                  <option value="onshift">On shift</option>
                  <option value="offshift">Off shift</option>
                  <option value="busy">Busy</option>
                  <option value="free">Free</option>
                  <option value="devicesilent">Device-silent</option>
                  <option value="notactive">Not Active (&gt;30m)</option>
                </select>
                <select
                  value={areaFilter}
                  onChange={(e) => handleSetAreaFilter(e.target.value)}
                  className="border rounded-md px-2 py-1 text-sm"
                >
                  <option value="all">All areas</option>
                  {areas.map((area) => (
                    <option key={area} value={area}>
                      {area}
                    </option>
                  ))}
                </select>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b bg-slate-50">
                      <th className="text-left py-2 px-2">Username</th>
                      <th className="text-left py-2 px-2">Name</th>
                      <th className="text-left py-2 px-2">On shift</th>
                      <th className="text-left py-2 px-2">Status</th>
                      <th className="text-left py-2 px-2">Ping Status</th>
                      <th className="text-left py-2 px-2">Activity</th>
                      <th className="text-left py-2 px-2">Site ID</th>
                      <th className="text-left py-2 px-2">Via warehouse</th>
                      <th className="text-left py-2 px-2">Warehouse</th>
                      <th className="text-left py-2 px-2">Route</th>
                      <th className="text-left py-2 px-2">Nearest site</th>
                      <th className="text-left py-2 px-2">Air distance (km)</th>
                      <th className="text-left py-2 px-2">Last active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredNfos.map((nfo) => {
                      const enriched = enrichedNfos.find((e) => e.username === nfo.username);
                      if (!enriched) return null;
                      return (
                        <FieldEngineerRow
                          key={nfo.username}
                          enriched={enriched}
                          sites={sites}
                          warehouses={warehouses}
                        />
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        )}

        {/* 
          IMPORTANT: LiveMap uses display:none instead of conditional rendering
          This keeps the component MOUNTED when switching tabs, preserving:
          - Selected site from search
          - Selected NFO 
          - Active route
          - Map zoom/center position
          
          The filters (mapAreaFilter, mapNfoFilter) are also persisted to localStorage
          so they survive F5 refresh as well.
        */}
        <div
          className="max-w-6xl mx-auto space-y-4"
          style={{ display: activeView === "map" ? "block" : "none" }}
        >
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold">Live map</h2>
            <p className="text-xs text-slate-500">
              Showing NFO positions from the latest heartbeat (nfo_status).
            </p>
          </div>
          {/* LiveMap stays mounted - internal state survives tab switches */}
          <LiveMap
            nfos={nfos}
            sites={sites}
            warehouses={warehouses}
            mapAreaFilter={mapAreaFilter}
            mapNfoFilter={mapNfoFilter}
            onMapAreaFilterChange={handleSetMapAreaFilter}
            onMapNfoFilterChange={handleSetMapNfoFilter}
            isActive={activeView === "map"}
          />
        </div>

        {activeView === "routes" && (
          <div className="max-w-6xl mx-auto space-y-4">
            <h2 className="text-xl font-semibold mb-2">NFO routes</h2>
            <p className="text-xs text-slate-500">
              Select a field engineer and site to view the route using the ORS backend.
            </p>
            <NfoRoutesView nfos={nfos} />
          </div>
        )}

        {activeView === "routePlanner" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">Route Planner</h2>
              <p className="text-xs text-slate-500">
                Plan routes between NFOs, warehouses, and sites.
              </p>
            </div>
            <RoutePlanner
              nfos={enrichedNfos}
              sites={sites}
              warehouses={warehouses}
              state={routePlannerState}
              onStateChange={setRoutePlannerState}
            />
          </div>
        )}

        {activeView === "clusterPlanner" && (
          <div className="max-w-7xl mx-auto space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">Cluster Planner</h2>
              <p className="text-xs text-slate-500">
                Paste site IDs to view cluster ownership on the map.
              </p>
            </div>
            <ClusterPlanner />
          </div>
        )}

        {activeView === "settings" && (
          <div className="max-w-5xl mx-auto space-y-4">
            <h2 className="text-xl font-semibold">Settings (coming soon)</h2>
            <p className="text-sm text-slate-600">
              Here we will later configure ORS backend URLs, map options, and notification thresholds.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

type StatCardProps = {
  label: string;
  value: number;
  accent: string; // Tailwind class
  isActive?: boolean; // Whether this card is currently selected
  onMouseEnter?: () => void; // Handler for hover
};

function StatCard({ label, value, accent, isActive, onMouseEnter }: StatCardProps) {
  return (
    <div
      className={`bg-white rounded-xl shadow p-4 flex flex-col gap-1 cursor-pointer transition-all ${isActive ? "ring-2 ring-sky-500 ring-offset-1" : "hover:bg-slate-50"
        }`}
      onMouseEnter={onMouseEnter}
    >
      <span className="text-xs text-gray-500">{label}</span>
      <div className="flex items-end justify-between mt-1">
        <span className="text-2xl font-bold">{value}</span>
        <span className={`h-2 w-10 rounded-full ${accent}`} />
      </div>
    </div>
  );
}
