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
  distanceLabel: string;
  siteLabel: string;
  isNotActive: boolean;
  pingReason: string;
  // Assignment state flags (computed from computeAssignmentState)
  isBusy: boolean;
  isFree: boolean;
  isOnShift: boolean;
  isOffShift: boolean;
};

type Stats = {
  totalNFOs: number;
  online: number;
  offline: number;
  free: number;
  busy: number;
  onShift: number;
  offShift: number;
};

type AreaSummary = {
  area: string;
  total: number;
  online: number;
  onShift: number;
  busy: number;
};

type StatusFilter =
  | "all"
  | "onshift"
  | "offshift"
  | "busy"
  | "free"
  | "online"
  | "offline"
  | "notactive";

type View = "dashboard" | "map" | "routes" | "settings";

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
  
  // ============================================================
  // DATA STATE - Refreshed every 30 seconds from Supabase
  // ============================================================
  const [nfos, setNfos] = useState<NfoStatusRow[]>([]);
  const [sites, setSites] = useState<SiteRecord[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
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

      // 2) Keep only latest row per username
      const latestByUser = new Map<string, NfoStatusRow>();
      for (const row of rows) {
        if (!row.username) continue;
        if (!latestByUser.has(row.username)) {
          latestByUser.set(row.username, row);
        }
      }

      const current = Array.from(latestByUser.values());

      // 3) Compute stats
      let totalNFOs = current.length;
      let online = 0;
      let offline = 0;
      let free = 0;
      let busy = 0;
      let onShift = 0;
      let offShift = 0;

      for (const row of current) {
        const loggedIn = !!row.logged_in;
        const onShiftVal = !!row.on_shift;

        if (loggedIn && onShiftVal) {
          online += 1;
        } else {
          offline += 1;
        }

        if (onShiftVal) {
          onShift += 1;
        } else {
          offShift += 1;
        }

        // Use new assignment-based logic for Busy/Free
        const { isBusy, isFree } = computeAssignmentState(row);
        if (isBusy) busy += 1;
        if (isFree) free += 1;
      }

      setNfos(current);
      setStats({ totalNFOs, online, offline, free, busy, onShift, offShift });
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

  const areaSummary = useMemo(() => {
    const summaryMap = new Map<string, AreaSummary>();

    for (const area of areas) {
      summaryMap.set(area, {
        area,
        total: 0,
        online: 0,
        onShift: 0,
        busy: 0,
      });
    }

    for (const row of nfos) {
      const area = row.home_location?.trim();
      if (!area) continue;

      const summary = summaryMap.get(area);
      if (!summary) continue;

      summary.total += 1;

      const loggedIn = !!row.logged_in;
      const onShiftVal = !!row.on_shift;
      if (loggedIn && onShiftVal) {
        summary.online += 1;
      }

      if (onShiftVal) {
        summary.onShift += 1;
      }

      // Use new assignment-based logic for Busy count
      const { isBusy } = computeAssignmentState(row);
      if (isBusy) {
        summary.busy += 1;
      }
    }

    return Array.from(summaryMap.values());
  }, [nfos, areas]);

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
          case "online":
            matchesStatus = loggedIn;
            break;
          case "offline":
            matchesStatus = !loggedIn;
            break;
          case "onshift":
            matchesStatus = onShift;
            break;
          case "offshift":
            matchesStatus = !onShift;
            break;
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
    return nfos.map((nfo) => {
      // Calculate online status
      const online = isOnline(nfo.last_active_at);
      const minutesSinceActive = ageMinutes(nfo.last_active_at);

      // Determine which site to show
      let nearestSiteId: string | null = null;
      let nearestSiteName: string | null = null;
      let nearestSiteDistanceKm: number | null = null;
      let distanceLabel = "N/A";
      let siteLabel = "N/A";

      // Use new assignment-based busy/free and shift logic
      const { isBusy, isFree, isOnShift, isOffShift } = computeAssignmentState(nfo);

      // If NFO is busy and has an assigned site with valid coords, use that
      if (
        isBusy &&
        nfo.site_id &&
        hasValidLocation({ lat: nfo.lat, lng: nfo.lng })
      ) {
        const activeSite = getSiteById(sites, nfo.site_id);
        if (
          activeSite &&
          hasValidLocation({ lat: activeSite.latitude, lng: activeSite.longitude })
        ) {
          const dist = calculateDistanceKm(
            { lat: nfo.lat, lng: nfo.lng },
            { lat: activeSite.latitude, lng: activeSite.longitude }
          );
          nearestSiteId = activeSite.site_id;
          nearestSiteName = activeSite.name ?? null;
          nearestSiteDistanceKm = dist;
          distanceLabel = formatDistanceLabel(dist);
          siteLabel = `Busy at site ${nearestSiteId} - ${distanceLabel}`;
        } else {
          siteLabel = `Busy at site ${nfo.site_id} - N/A (missing coordinates)`;
        }
      } else {
        // Otherwise, find nearest site
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

          if (isFree && nfo.on_shift) {
            siteLabel = `Free near site ${nearestSiteId} - ${distanceLabel}`;
          } else {
            siteLabel = `Nearest site ${nearestSiteId} - ${distanceLabel}`;
          }
        } else if (!hasValidLocation({ lat: nfo.lat, lng: nfo.lng })) {
          siteLabel = "No GPS";
        }
      }

      if (nfo.username === "ZAMEBIR") {
        console.log("[Dashboard DISTANCE DEBUG]", {
          username: nfo.username,
          status: nfo.status,
          site_id: nfo.site_id,
          nfoLat: nfo.lat,
          nfoLng: nfo.lng,
          nearestSiteId: nearestSiteId ?? null,
          nearestSiteDistanceKm,
        });
      }

      // Compute ping status (not active if no ping > 30 min)
      const { isNotActive, pingReason } = computePingStatus(nfo.last_active_at);

      return {
        ...nfo,
        isOnline: online,
        minutesSinceActive,
        nearestSiteId,
        nearestSiteName,
        nearestSiteDistanceKm,
        distanceLabel,
        siteLabel,
        isNotActive,
        pingReason,
        // Assignment state flags
        isBusy,
        isFree,
        isOnShift,
        isOffShift,
      };
    });
  }, [nfos, sites]);

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
                NFO Manager Dashboard (Web v0)
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

            {/* KPI cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard
                label="Total NFOs"
                value={stats?.totalNFOs ?? 0}
                accent="bg-sky-500"
              />
              <StatCard
                label="Online"
                value={stats?.online ?? 0}
                accent="bg-green-500"
              />
              <StatCard
                label="Offline"
                value={stats?.offline ?? 0}
                accent="bg-red-500"
              />
              <StatCard
                label="On shift"
                value={stats?.onShift ?? 0}
                accent="bg-emerald-500"
              />
              <StatCard
                label="Off shift"
                value={stats?.offShift ?? 0}
                accent="bg-gray-400"
              />
              <StatCard
                label="Free"
                value={stats?.free ?? 0}
                accent="bg-orange-400"
              />
              <StatCard
                label="Busy"
                value={stats?.busy ?? 0}
                accent="bg-blue-400"
              />
              <StatCard
                label="Not Active (>30m)"
                value={enrichedNfos.filter((n) => n.isNotActive).length}
                accent="bg-yellow-500"
              />
            </div>

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
                        <th className="text-center px-3 py-2 font-semibold">Online</th>
                        <th className="text-center px-3 py-2 font-semibold">On shift</th>
                        <th className="text-center px-3 py-2 font-semibold">Busy</th>
                      </tr>
                    </thead>
                    <tbody>
                      {areaSummary.map((summary) => (
                        <tr key={summary.area} className="border-b hover:bg-slate-50">
                          <td className="text-left px-3 py-2">{summary.area}</td>
                          <td className="text-center px-3 py-2">{summary.total}</td>
                          <td className="text-center px-3 py-2">{summary.online}</td>
                          <td className="text-center px-3 py-2">{summary.onShift}</td>
                          <td className="text-center px-3 py-2">{summary.busy}</td>
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
                Field engineers (latest status per username)
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
                  <option value="online">Online</option>
                  <option value="offline">Offline</option>
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
                        <tr key={nfo.username} className="border-b last:border-b-0">
                          <td className="py-2 px-2 font-mono text-xs">
                            {nfo.username}
                          </td>
                          <td className="py-2 px-2">{nfo.name}</td>
                          <td className="py-2 px-2">
                            {nfo.on_shift ? "Yes" : "No"}
                          </td>
                          <td className="py-2 px-2">{nfo.status}</td>
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
                          <td className="py-2 px-2">{nfo.activity}</td>
                          <td className="py-2 px-2 font-mono text-xs">
                            {nfo.site_id?.trim() ? nfo.site_id : "-"}
                          </td>
                          <td className="py-2 px-2 text-xs">
                            {enriched.nearestSiteId ?? "-"}
                          </td>
                          <td className="py-2 px-2 text-xs">
                            {enriched.nearestSiteDistanceKm !== null
                              ? enriched.nearestSiteDistanceKm.toFixed(2)
                              : "-"}
                          </td>
                          <td className="py-2 px-2 text-xs text-gray-500">
                            {nfo.last_active_at
                              ? new Date(nfo.last_active_at).toLocaleString()
                              : "-"}
                          </td>
                        </tr>
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
};

function StatCard({ label, value, accent }: StatCardProps) {
  return (
    <div className="bg-white rounded-xl shadow p-4 flex flex-col gap-1">
      <span className="text-xs text-gray-500">{label}</span>
      <div className="flex items-end justify-between mt-1">
        <span className="text-2xl font-bold">{value}</span>
        <span className={`h-2 w-10 rounded-full ${accent}`} />
      </div>
    </div>
  );
}
