"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import dynamic from "next/dynamic";
import * as XLSX from "xlsx";
import { supabase } from "../../lib/supabaseClient";

const TABLE_NAME = "hajj_sites_planner";

const REQUIRED_COLUMNS = [
  "Site ID",
  "Name",
  "FE ID",
  "Technology",
  "Latitude",
  "Longitude",
  "Location",
  "Area",
  "ON/OFF_Season-26",
  "VIP_Category",
  "Site_Type_Category",
  "Project_Scope_2026",
  "Survey_Priority",
  "Access_Status",
  "Survey_Plan_Date",
  "Survey_date",
  "Survey_Status",
  "Survey_NFO",
  "PMR_NFO",
  "Plan_Date",
  "PMR_Status",
  "Done_By",
  "PMR_LAN_status ",
  "RF_Audit",
  "Blower_Status",
  "Blower_Date",
  "Blower_LAN_status ",
  "EM_Feedback",
  "NFO_Feeback",
  "Site_Operational_Status",
  "Main_root_cause",
  "Remarks",
  "MDB_Door_Status",
  "TRM_Type",
  "RBS_Type",
  "TRM_Enclosure",
  "Wi-Fi_Enclosure",
  "Design",
  "Installed",
  "Working",
  "Not_Working",
  "Missing",
  "Required",
  "Modules_Status",
  "Rectifier_Data",
  "Reftifier_Status",
] as const;

type HajjSiteRow = Record<string, string | number | null>;

type UploadResponse = {
  ok: boolean;
  inserted?: number;
  skipped?: number;
  batchSize?: number;
  batchSizes?: number[];
  error?: string;
  detail?: string;
};

type ClusterPoint = {
  siteId: string;
  lat: number;
  lng: number;
  row: HajjSiteRow;
};

type ClusteredSite = {
  point: ClusterPoint;
  clusterIndex: number;
};

type ClusterStats = {
  totalPasted: number;
  uniqueIds: number;
  matched: number;
  notFoundIds: string[];
  missingCoordsIds: string[];
  usedK: number;
};

type ClusterLegendItem = {
  index: number;
  count: number;
  color: string;
};

type KMeansResult = {
  assignments: number[];
  centroids: { lat: number; lng: number }[];
};

type ClusterDebugState = {
  points: ClusterPoint[];
  centroids: { lat: number; lng: number }[];
  assignments: number[];
  indexBySiteId: Map<string, number>;
};

const CLUSTER_COLOR_PALETTE = [
  "#2563eb",
  "#f97316",
  "#22c55e",
  "#e11d48",
  "#8b5cf6",
  "#14b8a6",
  "#f59e0b",
  "#10b981",
  "#ef4444",
  "#6366f1",
  "#06b6d4",
  "#84cc16",
  "#db2777",
  "#0ea5e9",
  "#f43f5e",
  "#0f766e",
];

const HajjSitesPlannerMap = dynamic(() => import("./HajjSitesPlannerMap"), {
  ssr: false,
  loading: () => (
    <div className="h-[600px] w-full rounded-xl border border-slate-200 flex items-center justify-center bg-slate-50">
      <p className="text-slate-500">Loading map...</p>
    </div>
  ),
});

function parseCoordinate(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeDateForPostgres(value: unknown): string | null {
  if (value == null) return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const date = new Date(Date.UTC(1899, 11, 30) + value * 86400 * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;

    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const serial = Number.parseFloat(trimmed);
      if (!Number.isFinite(serial)) return null;
      const date = new Date(Date.UTC(1899, 11, 30) + serial * 86400 * 1000);
      return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
    }

    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) return null;
    return new Date(parsed).toISOString().slice(0, 10);
  }

  return null;
}

function normalizeSiteId(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const match = raw.match(/^[Ww](\d+)$/);
  if (match) return match[1];
  return raw;
}

function tokenizeSiteIds(input: string): string[] {
  return input
    .split(/[\s,;]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function getClusterColor(index: number): string {
  if (index < CLUSTER_COLOR_PALETTE.length) {
    return CLUSTER_COLOR_PALETTE[index];
  }
  const hue = (index * 47) % 360;
  return `hsl(${hue}, 70%, 45%)`;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function initializeCentroids(points: ClusterPoint[], k: number): { lat: number; lng: number }[] {
  const centroids: { lat: number; lng: number }[] = [];
  const indices = new Set<number>();
  const max = Math.min(k, points.length);

  while (centroids.length < max && indices.size < points.length) {
    const idx = Math.floor(Math.random() * points.length);
    if (indices.has(idx)) continue;
    indices.add(idx);
    centroids.push({ lat: points[idx].lat, lng: points[idx].lng });
  }

  return centroids;
}

function runKMeans(points: ClusterPoint[], k: number, maxIterations = 12): KMeansResult {
  if (points.length === 0) return { assignments: [], centroids: [] };
  if (k <= 1) {
    return {
      assignments: new Array(points.length).fill(0),
      centroids: [{ lat: points[0].lat, lng: points[0].lng }],
    };
  }

  const centroids = initializeCentroids(points, k);
  const assignments = new Array(points.length).fill(0);

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let changed = false;

    for (let i = 0; i < points.length; i += 1) {
      const point = points[i];
      let bestIndex = 0;
      let bestDistance = Number.POSITIVE_INFINITY;

      for (let c = 0; c < centroids.length; c += 1) {
        const distance = haversineKm(point, centroids[c]);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = c;
        }
      }

      if (assignments[i] !== bestIndex) {
        assignments[i] = bestIndex;
        changed = true;
      }
    }

    const sums = Array.from({ length: k }, () => ({
      lat: 0,
      lng: 0,
      count: 0,
    }));

    for (let i = 0; i < points.length; i += 1) {
      const clusterIndex = assignments[i];
      sums[clusterIndex].lat += points[i].lat;
      sums[clusterIndex].lng += points[i].lng;
      sums[clusterIndex].count += 1;
    }

    for (let c = 0; c < k; c += 1) {
      if (sums[c].count > 0) {
        centroids[c] = {
          lat: sums[c].lat / sums[c].count,
          lng: sums[c].lng / sums[c].count,
        };
      } else {
        const fallbackIndex = c % points.length;
        centroids[c] = {
          lat: points[fallbackIndex].lat,
          lng: points[fallbackIndex].lng,
        };
      }
    }

    if (!changed) break;
  }

  return { assignments, centroids };
}

function buildCapacities(total: number, k: number): number[] {
  const targetSize = Math.floor(total / k);
  const remainder = total % k;
  return Array.from({ length: k }, (_, index) => targetSize + (index < remainder ? 1 : 0));
}

function recomputeCentroids(
  points: ClusterPoint[],
  assignments: number[],
  k: number,
  fallback: { lat: number; lng: number }[]
): { lat: number; lng: number }[] {
  const sums = Array.from({ length: k }, () => ({
    lat: 0,
    lng: 0,
    count: 0,
  }));

  for (let i = 0; i < points.length; i += 1) {
    const clusterIndex = assignments[i] ?? 0;
    sums[clusterIndex].lat += points[i].lat;
    sums[clusterIndex].lng += points[i].lng;
    sums[clusterIndex].count += 1;
  }

  return sums.map((sum, index) => {
    if (sum.count > 0) {
      return { lat: sum.lat / sum.count, lng: sum.lng / sum.count };
    }
    return fallback[index] ?? { lat: points[0].lat, lng: points[0].lng };
  });
}

function balanceAssignments(
  points: ClusterPoint[],
  centroids: { lat: number; lng: number }[],
  baseAssignments: number[],
  capacities: number[]
): number[] {
  if (points.length === 0) return [];

  const assignments = [...baseAssignments];
  const k = centroids.length;

  const pointPrefs = points.map((point, index) => {
    const prefs = centroids.map((centroid, cIndex) => ({
      id: cIndex,
      distance: haversineKm(point, centroid),
    }));
    prefs.sort((a, b) => a.distance - b.distance);
    const current = assignments[index] ?? 0;
    return { index, prefs, current };
  });

  const finalAssign = [...assignments];
  const currentCounts = new Array(k).fill(0);
  const overflow: Array<{
    index: number;
    prefs: Array<{ id: number; distance: number }>;
    current: number;
  }> = [];

  pointPrefs.forEach((point) => {
    if (currentCounts[point.current] < capacities[point.current]) {
      currentCounts[point.current] += 1;
    } else {
      overflow.push(point);
    }
  });

  overflow.forEach((point) => {
    let assigned = false;
    for (const pref of point.prefs) {
      if (currentCounts[pref.id] >= capacities[pref.id]) continue;
      finalAssign[point.index] = pref.id;
      currentCounts[pref.id] += 1;
      assigned = true;
      break;
    }
    if (!assigned) {
      finalAssign[point.index] = point.current;
      currentCounts[point.current] += 1;
    }
  });

  return finalAssign;
}

function refineSwaps(
  points: ClusterPoint[],
  assignments: number[],
  centroids: { lat: number; lng: number }[]
): number[] {
  if (points.length === 0) return [];
  const newAssign = [...assignments];
  let improved = true;
  let iter = 0;

  while (improved && iter < 50) {
    improved = false;
    iter += 1;

    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const u = newAssign[i];
        const v = newAssign[j];
        if (u === v) continue;

        const cU = centroids[u];
        const cV = centroids[v];
        if (!cU || !cV) continue;

        const distIU = haversineKm(points[i], cU);
        const distIV = haversineKm(points[i], cV);
        const distJU = haversineKm(points[j], cU);
        const distJV = haversineKm(points[j], cV);

        const currCost = distIU + distJV;
        const swapCost = distIV + distJU;

        if (swapCost < currCost) {
          newAssign[i] = v;
          newAssign[j] = u;
          improved = true;
        }
      }
    }
  }

  return newAssign;
}

function runBalancedClustering(
  points: ClusterPoint[],
  k: number,
  iterations = 2
): KMeansResult {
  if (points.length === 0) return { assignments: [], centroids: [] };
  if (k <= 1) {
    const lat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
    const lng = points.reduce((sum, point) => sum + point.lng, 0) / points.length;
    return {
      assignments: new Array(points.length).fill(0),
      centroids: [{ lat, lng }],
    };
  }

  const initial = runKMeans(points, k, 10);
  let assignments = [...initial.assignments];
  let centroids = [...initial.centroids];
  const capacities = buildCapacities(points.length, k);

  for (let iteration = 0; iteration < Math.max(1, iterations); iteration += 1) {
    assignments = balanceAssignments(points, centroids, assignments, capacities);
    centroids = recomputeCentroids(points, assignments, k, centroids);
    assignments = refineSwaps(points, assignments, centroids);
    centroids = recomputeCentroids(points, assignments, k, centroids);
  }

  return { assignments, centroids };
}

function logClusterDiagnostics(
  points: ClusterPoint[],
  assignments: number[],
  centroids: { lat: number; lng: number }[]
): void {
  if (process.env.NODE_ENV === "production") return;
  if (points.length === 0 || centroids.length === 0) return;

  const totals = Array.from({ length: centroids.length }, () => ({
    count: 0,
    sum: 0,
  }));

  for (let i = 0; i < points.length; i += 1) {
    const clusterIndex = assignments[i] ?? 0;
    const centroid = centroids[clusterIndex];
    if (!centroid) continue;
    totals[clusterIndex].count += 1;
    totals[clusterIndex].sum += haversineKm(points[i], centroid);
  }

  const summary = totals.map((total, index) => ({
    group: index + 1,
    size: total.count,
    avgKm: total.count > 0 ? Number((total.sum / total.count).toFixed(2)) : 0,
  }));

  console.log("[HajjSitesPlanner][Cluster] Groups", summary);
}

function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function buildClusterCsv(rows: ClusteredSite[]): string {
  const headers = [
    "Site ID",
    "NFO Name",
    "FE ID",
    "Technology",
    "Latitude",
    "Longitude",
    "Location",
    "Area",
    "ON/OFF_Season-26",
    "VIP_Category",
    "Site_Type_Category",
  ];
  const lines = rows.map(({ point, clusterIndex }) => {
    const groupNumber = clusterIndex + 1;
    const row: Record<string, string> = {
      "Site ID": point.siteId || "",
      "NFO Name": `NFO ${groupNumber}`,
      "FE ID": point.row["FE ID"] ? String(point.row["FE ID"]) : "",
      "Technology": point.row["Technology"] ? String(point.row["Technology"]) : "",
      "Latitude": Number.isFinite(point.lat) ? String(point.lat) : "",
      "Longitude": Number.isFinite(point.lng) ? String(point.lng) : "",
      "Location": point.row["Location"] ? String(point.row["Location"]) : "",
      "Area": point.row["Area"] ? String(point.row["Area"]) : "",
      "ON/OFF_Season-26": point.row["ON/OFF_Season-26"]
        ? String(point.row["ON/OFF_Season-26"])
        : "",
      "VIP_Category": point.row["VIP_Category"] ? String(point.row["VIP_Category"]) : "",
      "Site_Type_Category": point.row["Site_Type_Category"]
        ? String(point.row["Site_Type_Category"])
        : "",
    };
    return headers.map((header) => escapeCsvField(row[header])).join(",");
  });

  return [headers.join(","), ...lines].join("\n");
}

function downloadCsv(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export default function HajjSitesPlanner() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [statusLines, setStatusLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isLoadingSites, setIsLoadingSites] = useState(false);
  const [sites, setSites] = useState<HajjSiteRow[]>([]);
  const [activeTab, setActiveTab] = useState<"planner" | "cluster">("planner");
  const [clusterInput, setClusterInput] = useState("");
  const [clusterK, setClusterK] = useState(6);
  const [clusteredSites, setClusteredSites] = useState<ClusteredSite[]>([]);
  const [selectedClusterIndex, setSelectedClusterIndex] = useState<number | null>(null);
  const [showOnlySelectedCluster, setShowOnlySelectedCluster] = useState(false);
  const [clusterStats, setClusterStats] = useState<ClusterStats | null>(null);
  const [clusterError, setClusterError] = useState<string | null>(null);
  const [clusterKUsed, setClusterKUsed] = useState<number | null>(null);
  const clusterDebugRef = useRef<ClusterDebugState | null>(null);

  const appendStatus = useCallback((line: string) => {
    setStatusLines((prev) => [...prev, line]);
  }, []);

  const loadSites = useCallback(async () => {
    setIsLoadingSites(true);
    setError(null);

    const { data, error: fetchError } = await supabase
      .from(TABLE_NAME)
      .select("*");

    if (fetchError) {
      setError(fetchError.message);
      setSites([]);
      setIsLoadingSites(false);
      return;
    }

    setSites((data ?? []) as HajjSiteRow[]);
    setIsLoadingSites(false);
  }, []);

  useEffect(() => {
    void loadSites();
  }, [loadSites]);

  const siteIndex = useMemo(() => {
    const lookup = new Map<string, HajjSiteRow[]>();
    for (const row of sites) {
      const rawId = row["Site ID"];
      const siteId = rawId != null ? String(rawId).trim() : "";
      if (!siteId) continue;
      const normalized = normalizeSiteId(siteId);
      const keys = new Set<string>();
      keys.add(siteId);
      if (normalized) keys.add(normalized);
      for (const key of keys) {
        const bucket = lookup.get(key);
        if (bucket) {
          bucket.push(row);
        } else {
          lookup.set(key, [row]);
        }
      }
    }
    return lookup;
  }, [sites]);

  const visibleClusteredSites = useMemo(() => {
    if (!showOnlySelectedCluster || selectedClusterIndex == null) {
      return clusteredSites;
    }
    return clusteredSites.filter((site) => site.clusterIndex === selectedClusterIndex);
  }, [clusteredSites, selectedClusterIndex, showOnlySelectedCluster]);

  const clusterRows = useMemo(
    () => visibleClusteredSites.map((site) => site.point.row),
    [visibleClusteredSites]
  );

  const clusterColorBySiteId = useMemo(() => {
    if (clusteredSites.length === 0) return null;
    const mapping: Record<string, string> = {};
    for (const { point, clusterIndex } of clusteredSites) {
      const color = getClusterColor(clusterIndex);
      if (point.siteId) {
        mapping[point.siteId] = color;
      }
      const normalized = normalizeSiteId(point.siteId);
      if (normalized) {
        mapping[normalized] = color;
      }
    }
    return mapping;
  }, [clusteredSites]);

  const clusterOpacityBySiteId = useMemo(() => {
    if (selectedClusterIndex == null || showOnlySelectedCluster) return null;
    const mapping: Record<string, number> = {};
    for (const { point, clusterIndex } of clusteredSites) {
      const opacity = clusterIndex === selectedClusterIndex ? 1 : 0.25;
      if (point.siteId) {
        mapping[point.siteId] = opacity;
      }
      const normalized = normalizeSiteId(point.siteId);
      if (normalized) {
        mapping[normalized] = opacity;
      }
    }
    return mapping;
  }, [clusteredSites, selectedClusterIndex, showOnlySelectedCluster]);

  const clusterLegendItems = useMemo((): ClusterLegendItem[] => {
    if (clusteredSites.length === 0) return [];
    const counts = new Map<number, number>();
    for (const { clusterIndex } of clusteredSites) {
      counts.set(clusterIndex, (counts.get(clusterIndex) ?? 0) + 1);
    }
    const totalGroups = clusterKUsed ?? counts.size;
    const items: ClusterLegendItem[] = [];
    for (let index = 0; index < totalGroups; index += 1) {
      items.push({
        index,
        count: counts.get(index) ?? 0,
        color: getClusterColor(index),
      });
    }
    return items;
  }, [clusteredSites, clusterKUsed]);

  const handleClusterMarkerDebug = useCallback((siteId: string) => {
    if (process.env.NODE_ENV === "production") return;
    const debug = clusterDebugRef.current;
    if (!debug) return;
    const normalized = normalizeSiteId(siteId);
    const pointIndex =
      debug.indexBySiteId.get(siteId) ??
      (normalized ? debug.indexBySiteId.get(normalized) : undefined);
    if (pointIndex == null) {
      console.log("[HajjSitesPlanner][Cluster] Site not found", siteId);
      return;
    }

    const point = debug.points[pointIndex];
    const distances = debug.centroids
      .map((centroid, index) => ({
        group: index + 1,
        km: Number(haversineKm(point, centroid).toFixed(2)),
      }))
      .sort((a, b) => a.km - b.km);
    const chosenGroup = (debug.assignments[pointIndex] ?? 0) + 1;

    console.log("[HajjSitesPlanner][Cluster] Site distances", {
      siteId: point.siteId,
      chosenGroup,
      distances,
    });
  }, []);

  const handleFileChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setSelectedFile(file);
    setError(null);
    setStatusLines([]);
  }, []);

  const handleUpload = useCallback(async () => {
    setError(null);
    setStatusLines([]);

    if (!selectedFile) {
      setError("Please select an .xlsx file first.");
      return;
    }

    if (!selectedFile.name.toLowerCase().endsWith(".xlsx")) {
      setError("Only .xlsx files are supported.");
      return;
    }

    setIsUploading(true);
    setStatusLines(["Parsing Excel file..."]);

    try {
      const arrayBuffer = await selectedFile.arrayBuffer();
      const workbook = XLSX.read(arrayBuffer, { type: "array" });
      const sheetName = workbook.SheetNames[0];

      if (!sheetName) {
        throw new Error("No sheets found in the Excel file.");
      }

      const sheet = workbook.Sheets[sheetName];
      if (!sheet) {
        throw new Error("Unable to read the first sheet.");
      }

      const headerRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
      const header = (headerRows[0] ?? []).map((value) => String(value ?? ""));
      const missingHeaders = REQUIRED_COLUMNS.filter((column) => !header.includes(column));

      if (missingHeaders.length > 0) {
        throw new Error(`Missing required columns: ${missingHeaders.join(", ")}`);
      }

      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });
      appendStatus(`Parsed ${rawRows.length} rows from sheet "${sheetName}".`);

      const normalizedRows: HajjSiteRow[] = [];
      let skipped = 0;

      for (const row of rawRows) {
        const normalized: HajjSiteRow = {};

        for (const column of REQUIRED_COLUMNS) {
          const value = row[column];
          normalized[column] = value == null ? null : (value as string | number);
        }

        const lat = parseCoordinate(normalized["Latitude"]);
        const lng = parseCoordinate(normalized["Longitude"]);

        if (lat == null || lng == null) {
          skipped += 1;
          continue;
        }

        normalized["Survey_Plan_Date"] = normalizeDateForPostgres(normalized["Survey_Plan_Date"]);
        normalized["Survey_date"] = normalizeDateForPostgres(normalized["Survey_date"]);
        normalized["Plan_Date"] = normalizeDateForPostgres(normalized["Plan_Date"]);
        normalized["Blower_Date"] = normalizeDateForPostgres(normalized["Blower_Date"]);

        normalized["Latitude"] = lat;
        normalized["Longitude"] = lng;
        normalizedRows.push(normalized);
      }

      if (normalizedRows.length === 0) {
        throw new Error("No valid rows found with latitude/longitude values.");
      }

      appendStatus(`Valid rows with coordinates: ${normalizedRows.length}. Skipped: ${skipped}.`);
      appendStatus("Truncating table and inserting rows...");

      const response = await fetch("/api/hajj-sites-planner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: normalizedRows }),
      });

      const payload = (await response.json()) as UploadResponse;

      if (!payload.ok) {
        const detail = payload.detail ? ` ${payload.detail}` : "";
        throw new Error(`${payload.error ?? "Upload failed."}${detail}`);
      }

      appendStatus("Table truncated.");

      if (payload.batchSizes && payload.batchSizes.length > 0) {
        payload.batchSizes.forEach((size, index) => {
          appendStatus(`Inserted batch ${index + 1}/${payload.batchSizes!.length} (${size} rows).`);
        });
      } else if (payload.inserted != null) {
        appendStatus(`Inserted ${payload.inserted} rows.`);
      }

      if (payload.skipped) {
        appendStatus(`Server skipped ${payload.skipped} rows due to invalid coordinates.`);
      }

      await loadSites();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setIsUploading(false);
    }
  }, [appendStatus, loadSites, selectedFile]);

  const handleCluster = useCallback(() => {
    setClusterError(null);
    setClusterStats(null);
    setClusteredSites([]);
    setClusterKUsed(null);
    setSelectedClusterIndex(null);
    setShowOnlySelectedCluster(false);

    const tokens = tokenizeSiteIds(clusterInput);
    if (tokens.length === 0) {
      setClusterError("Paste Site IDs to cluster.");
      return;
    }

    if (sites.length === 0) {
      setClusterError("No hajj sites loaded yet.");
      return;
    }

    const uniqueIds: string[] = [];
    const seen = new Set<string>();
    for (const token of tokens) {
      const normalized = normalizeSiteId(token);
      if (!normalized) continue;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      uniqueIds.push(normalized);
    }

    if (uniqueIds.length === 0) {
      setClusterError("No valid Site IDs found.");
      return;
    }

    const matched: ClusterPoint[] = [];
    const notFoundIds: string[] = [];
    const missingCoordsIds: string[] = [];
    const matchedSiteIds = new Set<string>();

    for (const id of uniqueIds) {
      const candidates = siteIndex.get(id);
      if (!candidates || candidates.length === 0) {
        notFoundIds.push(id);
        continue;
      }

      for (const row of candidates) {
        const siteIdRaw = row["Site ID"] != null ? String(row["Site ID"]).trim() : "";
        if (!siteIdRaw || matchedSiteIds.has(siteIdRaw)) continue;

        const lat = parseCoordinate(row["Latitude"]);
        const lng = parseCoordinate(row["Longitude"]);

        if (lat == null || lng == null) {
          missingCoordsIds.push(siteIdRaw || id);
          continue;
        }

        matchedSiteIds.add(siteIdRaw);
        matched.push({ siteId: siteIdRaw, lat, lng, row });
      }
    }

    const desiredK = Number.isFinite(clusterK) ? Math.max(1, Math.floor(clusterK)) : 1;
    const usedK = matched.length > 0 ? Math.min(desiredK, matched.length) : 0;
    setClusterKUsed(usedK || null);

    setClusterStats({
      totalPasted: tokens.length,
      uniqueIds: uniqueIds.length,
      matched: matched.length,
      notFoundIds,
      missingCoordsIds,
      usedK,
    });

    if (matched.length === 0) {
      setClusterError("No matching sites with coordinates.");
      return;
    }

    const resolvedResult = runBalancedClustering(matched, usedK, 2);
    const clustered = matched.map((point, index) => ({
      point,
      clusterIndex: resolvedResult.assignments[index] ?? 0,
    }));
    const indexBySiteId = new Map<string, number>();
    matched.forEach((point, index) => {
      indexBySiteId.set(point.siteId, index);
      const normalized = normalizeSiteId(point.siteId);
      if (normalized) {
        indexBySiteId.set(normalized, index);
      }
    });
    clusterDebugRef.current = {
      points: matched,
      centroids: resolvedResult.centroids,
      assignments: resolvedResult.assignments,
      indexBySiteId,
    };
    logClusterDiagnostics(matched, resolvedResult.assignments, resolvedResult.centroids);
    setClusteredSites(clustered);
  }, [clusterInput, clusterK, siteIndex, sites.length]);

  const handleClusterClear = useCallback(() => {
    setClusterInput("");
    setClusteredSites([]);
    setSelectedClusterIndex(null);
    setShowOnlySelectedCluster(false);
    setClusterStats(null);
    setClusterError(null);
    setClusterKUsed(null);
    clusterDebugRef.current = null;
  }, []);

  const handleClusterExport = useCallback(() => {
    if (clusteredSites.length === 0) return;
    const sorted = [...clusteredSites].sort((a, b) => {
      if (a.clusterIndex !== b.clusterIndex) {
        return a.clusterIndex - b.clusterIndex;
      }
      return a.point.siteId.localeCompare(b.point.siteId);
    });
    const csvContent = buildClusterCsv(sorted);
    const suffix = clusterKUsed ? `_K${clusterKUsed}` : "";
    downloadCsv(csvContent, `hajj_sites_planner_clusters${suffix}.csv`);
  }, [clusterKUsed, clusteredSites]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setActiveTab("planner")}
          className={`px-3 py-1.5 rounded-md text-sm font-medium border transition ${
            activeTab === "planner"
              ? "bg-slate-900 text-white border-slate-900"
              : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
          }`}
        >
          Upload & Map
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("cluster")}
          className={`px-3 py-1.5 rounded-md text-sm font-medium border transition ${
            activeTab === "cluster"
              ? "bg-slate-900 text-white border-slate-900"
              : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
          }`}
        >
          Cluster Planner
        </button>
      </div>

      {activeTab === "planner" && (
        <>
          <section className="bg-white rounded-xl shadow p-6">
            <h2 className="text-lg font-semibold mb-2">Upload Excel</h2>
            <p className="text-sm text-slate-500 mb-4">
              Upload a .xlsx file to overwrite the <span className="font-mono">hajj_sites_planner</span> table.
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <input
                type="file"
                accept=".xlsx"
                onChange={handleFileChange}
                className="text-sm"
              />
              <button
                onClick={handleUpload}
                disabled={!selectedFile || isUploading}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed transition"
              >
                {isUploading ? "Uploading..." : "Upload & Overwrite"}
              </button>
            </div>

            {selectedFile && (
              <div className="mt-3 text-xs text-slate-500">
                Selected file: <span className="font-medium text-slate-700">{selectedFile.name}</span>
              </div>
            )}

            {error && (
              <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                {error}
              </div>
            )}

            {statusLines.length > 0 && (
              <div className="mt-4 p-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700">
                <div className="font-medium mb-2">Status</div>
                <ul className="list-disc pl-5 space-y-1">
                  {statusLines.map((line, index) => (
                    <li key={index}>{line}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section className="bg-white rounded-xl shadow p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold">Hajj Sites Map</h3>
              <span className="text-xs text-slate-500">
                {isLoadingSites ? "Loading sites..." : `${sites.length} rows loaded`}
              </span>
            </div>

            {sites.length === 0 && !isLoadingSites && (
              <div className="mb-3 text-sm text-slate-500">
                No rows found in hajj_sites_planner.
              </div>
            )}
            <HajjSitesPlannerMap sites={sites} />
          </section>
        </>
      )}

      {activeTab === "cluster" && (
        <>
          <section className="bg-white rounded-xl shadow p-6">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <h2 className="text-lg font-semibold mb-2">Cluster Planner</h2>
                <p className="text-sm text-slate-500">
                  Paste Site IDs (500+ supported). IDs match with or without the W prefix.
                </p>
              </div>
              <div className="text-xs text-slate-500">
                {isLoadingSites ? "Loading sites..." : `${sites.length} rows loaded`}
              </div>
            </div>

            <textarea
              value={clusterInput}
              onChange={(event) => setClusterInput(event.target.value)}
              placeholder="W2362 W2363 2364&#10;W2365, W2366&#10;2367"
              className="w-full h-32 border border-slate-300 rounded-lg p-3 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />

            <div className="flex flex-wrap items-end gap-3 mt-4">
              <label className="text-sm">
                <span className="block text-xs text-slate-500">Number of NFO (K)</span>
                <input
                  type="number"
                  min={1}
                  value={clusterK}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    setClusterK(Number.isFinite(value) && value > 0 ? value : 1);
                  }}
                  className="mt-1 w-28 border border-slate-300 rounded-md px-2 py-1 text-sm"
                />
              </label>
              <button
                onClick={handleCluster}
                disabled={!clusterInput.trim() || isLoadingSites}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed transition"
              >
                Cluster & Plot
              </button>
              <button
                onClick={handleClusterClear}
                className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 transition"
              >
                Clear
              </button>
              <button
                onClick={handleClusterExport}
                disabled={clusteredSites.length === 0}
                className="px-4 py-2 bg-emerald-600 text-white rounded-lg font-medium hover:bg-emerald-700 disabled:bg-emerald-300 disabled:cursor-not-allowed transition"
              >
                Export CSV
              </button>
            </div>

            {clusterError && (
              <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                {clusterError}
              </div>
            )}

            {clusterStats && (
              <div className="flex flex-wrap gap-3 mt-4">
                <span className="px-3 py-1 bg-slate-100 text-slate-700 rounded-full text-sm font-medium">
                  Pasted: {clusterStats.totalPasted}
                </span>
                <span className="px-3 py-1 bg-slate-100 text-slate-700 rounded-full text-sm font-medium">
                  Unique IDs: {clusterStats.uniqueIds}
                </span>
                <span className="px-3 py-1 bg-green-100 text-green-700 rounded-full text-sm font-medium">
                  Matched: {clusterStats.matched}
                </span>
                <span className="px-3 py-1 bg-slate-100 text-slate-700 rounded-full text-sm font-medium">
                  NFO groups: {clusterStats.usedK}
                </span>
                {clusterStats.notFoundIds.length > 0 && (
                  <span className="px-3 py-1 bg-red-100 text-red-700 rounded-full text-sm font-medium">
                    Not found: {clusterStats.notFoundIds.length}
                  </span>
                )}
                {clusterStats.missingCoordsIds.length > 0 && (
                  <span className="px-3 py-1 bg-amber-100 text-amber-700 rounded-full text-sm font-medium">
                    Missing coords: {clusterStats.missingCoordsIds.length}
                  </span>
                )}
              </div>
            )}
          </section>

          {clusteredSites.length > 0 && (
            <section className="bg-white rounded-xl shadow p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-lg font-semibold">Cluster Map</h3>
                <span className="text-xs text-slate-500">
                  {clusteredSites.length} sites
                  {clusterKUsed ? ` - ${clusterKUsed} groups` : ""}
                </span>
              </div>

              {clusterLegendItems.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 mb-3">
                  {clusterLegendItems.map((item) => {
                    const isSelected = selectedClusterIndex === item.index;
                    return (
                      <button
                        key={item.index}
                        type="button"
                        onClick={() =>
                          setSelectedClusterIndex((prev) => (prev === item.index ? null : item.index))
                        }
                        className={`flex items-center gap-1 text-xs rounded-md border px-2 py-1 transition ${
                          isSelected
                            ? "bg-slate-900 text-white border-slate-900"
                            : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
                        }`}
                      >
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: item.color }}
                        />
                        <span>
                          NFO {item.index + 1} ({item.count})
                        </span>
                      </button>
                    );
                  })}
                  <label className="ml-auto flex items-center gap-2 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={showOnlySelectedCluster}
                      onChange={(event) => setShowOnlySelectedCluster(event.target.checked)}
                      className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                    />
                    Show only selected
                  </label>
                </div>
              )}

              <HajjSitesPlannerMap
                sites={clusterRows}
                mode="cluster"
                markerColorBySiteId={clusterColorBySiteId ?? undefined}
                markerOpacityBySiteId={clusterOpacityBySiteId ?? undefined}
                onClusterMarkerClick={handleClusterMarkerDebug}
              />
            </section>
          )}

          {clusterStats &&
            (clusterStats.notFoundIds.length > 0 ||
              clusterStats.missingCoordsIds.length > 0) && (
              <section className="bg-white rounded-xl shadow p-6">
                <h3 className="text-lg font-semibold mb-4">Issues Found</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {clusterStats.notFoundIds.length > 0 && (
                    <div>
                      <h4 className="text-sm font-semibold text-red-700 mb-2">
                        Not Found ({clusterStats.notFoundIds.length})
                      </h4>
                      <div className="bg-red-50 rounded-lg p-3 max-h-40 overflow-y-auto">
                        <div className="flex flex-wrap gap-1">
                          {clusterStats.notFoundIds.map((id) => (
                            <span
                              key={id}
                              className="px-2 py-0.5 bg-red-100 text-red-800 rounded text-xs font-mono"
                            >
                              {id}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {clusterStats.missingCoordsIds.length > 0 && (
                    <div>
                      <h4 className="text-sm font-semibold text-amber-700 mb-2">
                        Missing Coordinates ({clusterStats.missingCoordsIds.length})
                      </h4>
                      <div className="bg-amber-50 rounded-lg p-3 max-h-40 overflow-y-auto">
                        <div className="flex flex-wrap gap-1">
                          {clusterStats.missingCoordsIds.map((id) => (
                            <span
                              key={id}
                              className="px-2 py-0.5 bg-amber-100 text-amber-800 rounded text-xs font-mono"
                            >
                              {id}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </section>
            )}
        </>
      )}
    </div>
  );
}
