"use client";

import { useEffect, useState, useMemo } from "react";
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
} from "./lib/nfoHelpers";
import LiveMap from "./components/LiveMap";
import NfoRoutesView from "./components/NfoRoutesView";

const STUCK_MINUTES = 150; // 2.5 hours

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

export default function HomePage() {
  const [activeView, setActiveView] = useState<View>("dashboard");
  const [nfos, setNfos] = useState<NfoStatusRow[]>([]);
  const [sites, setSites] = useState<SiteRecord[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [areaFilter, setAreaFilter] = useState<string>("all");

  useEffect(() => {
    const loadData = async () => {
      try {
        // 1) Load all heartbeat/status rows, newest first
        const { data, error } = await supabase
          .from("nfo_status")
          .select(
            "username, name, on_shift, status, activity, site_id, lat, lng, logged_in, last_active_at, home_location"
          )
          .order("last_active_at", { ascending: false });

        if (error) throw error;

        const rows = (data ?? []) as NfoStatusRow[];

        // 1b) Load Site_Coordinates - fetch ALL sites using pagination
        // Supabase default limit is 1000 rows, so we need to paginate to get all ~3516 sites
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
          
          // If we got less than PAGE_SIZE rows, we've reached the end
          if (siteRowsPage.length < PAGE_SIZE) {
            hasMoreRows = false;
          }

          pageNumber++;
        }

        console.log("Site rows from Supabase:", allSiteRows.length, "rows (fetched across", pageNumber, "pages)");
        if (allSiteRows && allSiteRows.length > 0) {
          console.log("First site row:", allSiteRows[0]);
        }

        const siteRecords: SiteRecord[] =
          (allSiteRows ?? []).map((row: any) => {
            // Parse latitude and longitude from strings to numbers
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
        
        console.log("Parsed site records:", siteRecords.length, "records");
        if (siteRecords.length > 0) {
          console.log("First parsed site:", siteRecords[0]);
        }
        
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

          const s = (row.status ?? "").toLowerCase();
          if (s === "busy") busy += 1;
          if (s === "free") free += 1;
        }

        setNfos(current);
        setStats({ totalNFOs, online, offline, free, busy, onShift, offShift });
      } catch (err: any) {
        setError(err.message ?? "Error loading data");
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, []);

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

      const status = (row.status ?? "").toLowerCase();
      if (status === "busy") {
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
        const s = (row.status ?? "").toLowerCase();
        const loggedIn = !!row.logged_in;
        const onShift = !!row.on_shift;

        switch (statusFilter) {
          case "busy":
            matchesStatus = s === "busy";
            break;
          case "free":
            matchesStatus = s === "free";
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

      // If NFO is busy and has an assigned site with valid coords, use that
      if (
        nfo.status === "busy" &&
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

          if (nfo.status === "free" && nfo.on_shift) {
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
              onClick={() => setActiveView(item.id as View)}
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
          Data source: Supabase · nfo_status
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 px-4 py-8 overflow-auto">
        {activeView === "dashboard" && (
          <div className="max-w-5xl mx-auto space-y-6">
            <header className="flex items-center justify-between">
              <h1 className="text-2xl font-bold">
                NFO Manager Dashboard (Web v0)
              </h1>
              <span className="text-xs text-gray-500">
                Data source: Supabase · table nfo_status
              </span>
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
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by username or name"
                  className="border rounded-md px-3 py-1 text-sm"
                />
                <select
                  value={statusFilter}
                  onChange={(e) =>
                    setStatusFilter(e.target.value as StatusFilter)
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
                  onChange={(e) => setAreaFilter(e.target.value)}
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

        {activeView === "map" && (
          <div className="max-w-6xl mx-auto space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">Live map</h2>
              <p className="text-xs text-slate-500">
                Showing NFO positions from the latest heartbeat (nfo_status).
              </p>
            </div>
            <LiveMap nfos={nfos} sites={sites} />
          </div>
        )}

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
