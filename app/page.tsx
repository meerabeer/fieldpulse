"use client";

import { useEffect, useState, useMemo } from "react";
import { supabase } from "../lib/supabaseClient";

type NfoStatusRow = {
  username: string;
  name: string | null;
  on_shift: boolean | null;
  status: string | null;
  activity: string | null;
  site_id: string | null;
  home_location: string | null;
  lat: number | null;
  lng: number | null;
  logged_in: boolean | null;
  last_active_at: string | null;
};

type Stats = {
  totalNFOs: number;
  online: number;
  offline: number;
  free: number;
  busy: number;
};

type StatusFilter =
  | "all"
  | "onshift"
  | "offshift"
  | "busy"
  | "free"
  | "online"
  | "offline";

export default function HomePage() {
  const [nfos, setNfos] = useState<NfoStatusRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [areaFilter, setAreaFilter] = useState<string>("all");
  const [onShiftOnly, setOnShiftOnly] = useState(false);

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

        for (const row of current) {
          const loggedIn = !!row.logged_in;
          const onShift = !!row.on_shift;

          if (loggedIn && onShift) {
            online += 1;
          } else {
            offline += 1;
          }

          const s = (row.status ?? "").toLowerCase();
          if (s === "busy") busy += 1;
          if (s === "free") free += 1;
        }

        setNfos(current);
        setStats({ totalNFOs, online, offline, free, busy });
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

  const filteredNfos = nfos.filter((row) => {
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
      default:
        matchesStatus = true;
    }

    const matchesArea = areaFilter === "all" || row.home_location === areaFilter;

    const matchesOnShiftToggle = !onShiftOnly || onShift;

    return (
      matchesSearch &&
      matchesStatus &&
      matchesArea &&
      matchesOnShiftToggle
    );
  });

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

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8">
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
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
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
            label="Free"
            value={stats?.free ?? 0}
            accent="bg-orange-400"
          />
          <StatCard
            label="Busy"
            value={stats?.busy ?? 0}
            accent="bg-blue-400"
          />
        </div>

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
            <label className="inline-flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={onShiftOnly}
                onChange={(e) => setOnShiftOnly(e.target.checked)}
              />
              <span>On shift only</span>
            </label>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b bg-slate-50">
                  <th className="text-left py-2 px-2">Username</th>
                  <th className="text-left py-2 px-2">Name</th>
                  <th className="text-left py-2 px-2">On shift</th>
                  <th className="text-left py-2 px-2">Status</th>
                  <th className="text-left py-2 px-2">Activity</th>
                  <th className="text-left py-2 px-2">Site ID</th>
                  <th className="text-left py-2 px-2">Last active</th>
                </tr>
              </thead>
              <tbody>
                {filteredNfos.map((nfo) => (
                  <tr key={nfo.username} className="border-b last:border-b-0">
                    <td className="py-2 px-2 font-mono text-xs">
                      {nfo.username}
                    </td>
                    <td className="py-2 px-2">{nfo.name}</td>
                    <td className="py-2 px-2">
                      {nfo.on_shift ? "Yes" : "No"}
                    </td>
                    <td className="py-2 px-2">{nfo.status}</td>
                    <td className="py-2 px-2">{nfo.activity}</td>
                    <td className="py-2 px-2 font-mono text-xs">
                      {nfo.site_id?.trim() ? nfo.site_id : "-"}
                    </td>
                    <td className="py-2 px-2 text-xs text-gray-500">
                      {nfo.last_active_at
                        ? new Date(nfo.last_active_at).toLocaleString()
                        : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
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
