"use client";

import { useState, useMemo, useCallback } from "react";
import dynamic from "next/dynamic";
import { supabase } from "../../lib/supabaseClient";

// Dynamic import for the map to avoid SSR issues
const ClusterPlannerMap = dynamic(() => import("./ClusterPlannerMap"), {
    ssr: false,
    loading: () => (
        <div className="h-[500px] w-full rounded-lg border border-slate-200 flex items-center justify-center bg-slate-50">
            <p className="text-slate-500">Loading map...</p>
        </div>
    ),
});

// Types
interface SiteWithOwner {
    site_id: string;
    site_name: string | null;
    latitude: number | null;
    longitude: number | null;
    area: string | null;
    cluster_owner: string | null;
}

interface ParseStats {
    totalPasted: number;
    found: number;
    notFound: number;
    missingCoords: number;
    invalidInputs: string[];
    notFoundIds: string[];
    missingCoordsIds: string[];
}

interface OwnerCount {
    owner: string;
    count: number;
    color: string;
}

// Normalize site IDs from raw input
function normalizeSiteIds(input: string): { normalized: string[]; invalid: string[] } {
    const normalized: string[] = [];
    const invalid: string[] = [];
    const seen = new Set<string>();

    // Split by whitespace, commas, tabs, newlines
    const tokens = input.split(/[\s,\t\n]+/).filter(Boolean);

    for (const token of tokens) {
        const trimmed = token.trim().toUpperCase();
        if (!trimmed) continue;

        // Pattern: W followed by digits, or just digits
        const wPattern = /^W(\d+)$/;
        const digitsPattern = /^(\d+)$/;

        let siteId: string | null = null;

        if (wPattern.test(trimmed)) {
            // Already has W prefix
            siteId = trimmed;
        } else if (digitsPattern.test(trimmed)) {
            // Just digits - add W prefix
            siteId = `W${trimmed}`;
        } else {
            // Invalid format
            invalid.push(token);
            continue;
        }

        // Deduplicate
        if (siteId && !seen.has(siteId)) {
            seen.add(siteId);
            normalized.push(siteId);
        }
    }

    return { normalized, invalid };
}

// Generate a deterministic hue (0-360) from a string using hash
function getOwnerHue(owner: string): number {
    let hash = 0;
    for (let i = 0; i < owner.length; i++) {
        hash = ((hash << 5) - hash + owner.charCodeAt(i)) | 0;
    }
    // Use golden angle approximation for better distribution
    return Math.abs(hash * 137.508) % 360;
}

// Generate unique HSL colors for all owners, avoiding collisions
function generateOwnerColors(owners: string[]): Map<string, string> {
    const colorMap = new Map<string, string>();
    const usedHues: number[] = [];
    const MIN_HUE_DISTANCE = 25; // Minimum degrees apart

    for (const owner of owners) {
        // Fixed color for Unassigned
        if (owner === "Unassigned") {
            colorMap.set(owner, "hsl(0, 0%, 50%)"); // Grey
            continue;
        }

        let hue = getOwnerHue(owner);

        // Adjust hue if too close to an already used hue
        let attempts = 0;
        while (attempts < 15) {
            const tooClose = usedHues.some(
                (usedHue) => Math.abs(hue - usedHue) < MIN_HUE_DISTANCE ||
                    Math.abs(hue - usedHue) > (360 - MIN_HUE_DISTANCE)
            );
            if (!tooClose) break;
            hue = (hue + MIN_HUE_DISTANCE) % 360;
            attempts++;
        }

        usedHues.push(hue);
        // Use 70% saturation, 45% lightness for vibrant but readable colors
        colorMap.set(owner, `hsl(${Math.round(hue)}, 70%, 45%)`);
    }

    return colorMap;
}

// Sanitize filename - remove special characters
function sanitizeFilename(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50);
}

// Generate CSV content from site data
function generateCsvContent(sites: SiteWithOwner[]): string {
    const headers = ["site_id", "site_name", "area", "latitude", "longitude", "cluster_owner"];
    const rows = sites.map((row) => {
        const name = row.site_name || "";
        const area = row.area || "";
        const lat = row.latitude != null ? String(row.latitude) : "";
        const lng = row.longitude != null ? String(row.longitude) : "";
        const owner = row.cluster_owner || "Unassigned";

        const escapeField = (value: string) => {
            if (value.includes(",") || value.includes('"') || value.includes("\n")) {
                return `"${value.replace(/"/g, '""')}"`;
            }
            return value;
        };

        return [row.site_id, name, area, lat, lng, owner].map(escapeField).join(",");
    });

    return [headers.join(","), ...rows].join("\n");
}

// Trigger CSV download
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

export default function ClusterPlanner() {
    // State
    const [rawInput, setRawInput] = useState("");
    const [loading, setLoading] = useState(false);
    const [siteData, setSiteData] = useState<SiteWithOwner[]>([]);
    const [selectedOwner, setSelectedOwner] = useState<string | null>(null);
    const [parseStats, setParseStats] = useState<ParseStats | null>(null);
    const [error, setError] = useState<string | null>(null);

    // Planning Options State

    // Get unique owners from site data
    const uniqueOwners = useMemo(() => {
        const owners = new Set<string>();
        for (const site of siteData) {
            owners.add(site.cluster_owner || "Unassigned");
        }
        return Array.from(owners);
    }, [siteData]);

    // Generate unique colors for all owners
    const ownerColors = useMemo(() => {
        return generateOwnerColors(uniqueOwners);
    }, [uniqueOwners]);

    // Group sites by owner with counts (using dynamic colors)
    const ownerCounts = useMemo((): OwnerCount[] => {
        const counts = new Map<string, number>();

        for (const site of siteData) {
            const owner = site.cluster_owner || "Unassigned";
            counts.set(owner, (counts.get(owner) || 0) + 1);
        }

        // Convert to array and sort by count descending
        return Array.from(counts.entries())
            .map(([owner, count]) => ({
                owner,
                count,
                color: ownerColors.get(owner) || "hsl(0, 0%, 50%)",
            }))
            .sort((a, b) => b.count - a.count);
    }, [siteData, ownerColors]);

    // Handle Plot Sites button
    const handlePlotSites = useCallback(async () => {
        setLoading(true);
        setError(null);
        setSiteData([]);
        setParseStats(null);
        setSelectedOwner(null);

        try {
            // Normalize input
            const { normalized, invalid } = normalizeSiteIds(rawInput);

            if (normalized.length === 0) {
                setError("No valid site IDs found in input. Use formats like W2362, 2362, or w2362.");
                setLoading(false);
                return;
            }

            // Query Supabase
            const { data, error: queryError } = await supabase
                .from("Site_Coordinates")
                .select("site_id, site_name, latitude, longitude, area, cluster_owner")
                .in("site_id", normalized);

            if (queryError) {
                throw new Error(queryError.message);
            }

            const rows = (data ?? []) as SiteWithOwner[];

            // Parse latitude/longitude - handle string values and "#N/A"
            const parsedRows: SiteWithOwner[] = rows.map((row) => {
                let lat = row.latitude;
                let lng = row.longitude;

                // Handle string latitude
                if (typeof lat === "string") {
                    if (lat === "#N/A" || lat === "N/A" || lat === "") {
                        lat = null;
                    } else {
                        lat = parseFloat(lat);
                        if (!Number.isFinite(lat)) lat = null;
                    }
                }

                // Handle string longitude
                if (typeof lng === "string") {
                    if (lng === "#N/A" || lng === "N/A" || lng === "") {
                        lng = null;
                    } else {
                        lng = parseFloat(lng);
                        if (!Number.isFinite(lng)) lng = null;
                    }
                }

                return { ...row, latitude: lat, longitude: lng };
            });

            // Compute stats
            const foundIds = new Set(parsedRows.map((r) => r.site_id));
            const notFoundIds = normalized.filter((id) => !foundIds.has(id));
            const missingCoordsRows = parsedRows.filter(
                (r) => r.latitude == null || r.longitude == null
            );
            const missingCoordsIds = missingCoordsRows.map((r) => r.site_id);

            setParseStats({
                totalPasted: normalized.length,
                found: parsedRows.length,
                notFound: notFoundIds.length,
                missingCoords: missingCoordsIds.length,
                invalidInputs: invalid,
                notFoundIds,
                missingCoordsIds,
            });

            setSiteData(parsedRows);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Failed to fetch site data");
        } finally {
            setLoading(false);
        }
    }, [rawInput]);

    // Handle Clear button
    const handleClear = useCallback(() => {
        setRawInput("");
        setSiteData([]);
        setParseStats(null);
        setSelectedOwner(null);
        setError(null);
    }, []);

    // Handle owner row click
    const handleOwnerClick = useCallback((owner: string) => {
        setSelectedOwner((prev) => (prev === owner ? null : owner));
    }, []);

    // Handle Download CSV
    const handleDownloadCsv = useCallback(() => {
        if (siteData.length === 0) return;

        // Filter by selected owner if set
        const exportData = selectedOwner
            ? siteData.filter((s) => (s.cluster_owner || "Unassigned") === selectedOwner)
            : siteData;

        const csvContent = generateCsvContent(exportData);

        const filename = selectedOwner
            ? `cluster_owner_${sanitizeFilename(selectedOwner)}.csv`
            : "cluster_planner_all.csv";

        downloadCsv(csvContent, filename);
    }, [siteData, selectedOwner]);

    return (
        <div className="space-y-6">
            {/* Input Section */}
            <section className="bg-white rounded-xl shadow p-6">
                <h3 className="text-lg font-semibold mb-3">Paste Site IDs</h3>
                <p className="text-sm text-slate-500 mb-4">
                    Paste 20-25 sites (or more). Accepts formats: W2362, 2362, w2362.
                    Separated by spaces, commas, tabs, or newlines.
                </p>

                <textarea
                    value={rawInput}
                    onChange={(e) => setRawInput(e.target.value)}
                    placeholder="W2362 W2363 2364&#10;W2365, W2366&#10;2367"
                    className="w-full h-32 border border-slate-300 rounded-lg p-3 text-sm font-mono resize-y focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />

                <div className="flex items-center gap-3 mt-4">
                    <button
                        onClick={handlePlotSites}
                        disabled={loading || !rawInput.trim()}
                        className="px-4 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed transition"
                    >
                        {loading ? "Loading..." : "Plot Sites"}
                    </button>
                    <button
                        onClick={handleClear}
                        disabled={loading}
                        className="px-4 py-2 bg-slate-200 text-slate-700 rounded-lg font-medium hover:bg-slate-300 disabled:opacity-50 transition"
                    >
                        Clear
                    </button>
                    <button
                        onClick={handleDownloadCsv}
                        disabled={siteData.length === 0}
                        className="px-4 py-2 bg-emerald-600 text-white rounded-lg font-medium hover:bg-emerald-700 disabled:bg-emerald-300 disabled:cursor-not-allowed transition flex items-center gap-2"
                    >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                        Download CSV
                    </button>
                </div>


                {/* Error message */}
                {error && (
                    <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                        {error}
                    </div>
                )}

                {/* Stats badges */}
                {parseStats && (
                    <div className="flex flex-wrap gap-3 mt-4">
                        <span className="px-3 py-1 bg-slate-100 text-slate-700 rounded-full text-sm font-medium">
                            Total pasted: {parseStats.totalPasted}
                        </span>
                        <span className="px-3 py-1 bg-green-100 text-green-700 rounded-full text-sm font-medium">
                            Found: {parseStats.found}
                        </span>
                        {parseStats.notFound > 0 && (
                            <span className="px-3 py-1 bg-red-100 text-red-700 rounded-full text-sm font-medium">
                                Not found: {parseStats.notFound}
                            </span>
                        )}
                        {parseStats.missingCoords > 0 && (
                            <span className="px-3 py-1 bg-amber-100 text-amber-700 rounded-full text-sm font-medium">
                                Missing coordinates: {parseStats.missingCoords}
                            </span>
                        )}
                        {parseStats.invalidInputs.length > 0 && (
                            <span className="px-3 py-1 bg-orange-100 text-orange-700 rounded-full text-sm font-medium">
                                Invalid input: {parseStats.invalidInputs.length}
                            </span>
                        )}
                    </div>
                )}
            </section>

            {/* Dashboard + Map Layout */}
            {siteData.length > 0 && (
                <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
                    {/* Dashboard Panel */}
                    <section className="lg:col-span-1 bg-white rounded-xl shadow p-4">
                        <div className="flex items-center justify-between mb-4">
                            <h3 className="text-base font-semibold">Issues Count by Cluster Owner</h3>
                            {selectedOwner && (
                                <button
                                    onClick={() => setSelectedOwner(null)}
                                    className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                                >
                                    Show All
                                </button>
                            )}
                        </div>

                        <div className="space-y-2 max-h-[400px] overflow-y-auto">
                            {ownerCounts.map(({ owner, count, color }) => (
                                <button
                                    key={owner}
                                    onClick={() => handleOwnerClick(owner)}
                                    className={`w-full flex items-center justify-between p-3 rounded-lg text-left transition ${selectedOwner === owner
                                        ? "bg-blue-100 border border-blue-300"
                                        : "bg-slate-50 hover:bg-slate-100 border border-transparent"
                                        }`}
                                >
                                    <div className="flex items-center gap-3">
                                        <span
                                            className="w-4 h-4 rounded-full flex-shrink-0 border border-white shadow-sm"
                                            style={{ backgroundColor: color }}
                                        />
                                        <span className="text-sm font-medium text-slate-700 truncate max-w-[150px]">
                                            {owner}
                                        </span>
                                    </div>
                                    <span className="text-sm font-semibold text-slate-900 bg-white px-2 py-0.5 rounded">
                                        {count}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </section>

                    {/* Map Panel */}
                    <section className="lg:col-span-3 bg-white rounded-xl shadow p-4">
                        <h3 className="text-lg font-semibold mb-3">
                            Map View
                            {selectedOwner && (
                                <span className="text-sm font-normal text-slate-500 ml-2">
                                    — Showing: {selectedOwner}
                                </span>
                            )}
                        </h3>
                        <ClusterPlannerMap
                            sites={siteData}
                            selectedOwner={selectedOwner}
                            ownerColors={ownerColors}
                        />
                    </section>
                </div>
            )}

            {/* Missing/Invalid Panel */}
            {parseStats && (parseStats.notFoundIds.length > 0 || parseStats.missingCoordsIds.length > 0 || parseStats.invalidInputs.length > 0) && (
                <section className="bg-white rounded-xl shadow p-6">
                    <h3 className="text-lg font-semibold mb-4">Issues Found</h3>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        {/* Not Found */}
                        {parseStats.notFoundIds.length > 0 && (
                            <div>
                                <h4 className="text-sm font-semibold text-red-700 mb-2">
                                    Not Found in Database ({parseStats.notFoundIds.length})
                                </h4>
                                <div className="bg-red-50 rounded-lg p-3 max-h-40 overflow-y-auto">
                                    <div className="flex flex-wrap gap-1">
                                        {parseStats.notFoundIds.map((id) => (
                                            <span key={id} className="px-2 py-0.5 bg-red-100 text-red-800 rounded text-xs font-mono">
                                                {id}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Missing Coordinates */}
                        {parseStats.missingCoordsIds.length > 0 && (
                            <div>
                                <h4 className="text-sm font-semibold text-amber-700 mb-2">
                                    Missing Coordinates ({parseStats.missingCoordsIds.length})
                                </h4>
                                <div className="bg-amber-50 rounded-lg p-3 max-h-40 overflow-y-auto">
                                    <div className="flex flex-wrap gap-1">
                                        {parseStats.missingCoordsIds.map((id) => (
                                            <span key={id} className="px-2 py-0.5 bg-amber-100 text-amber-800 rounded text-xs font-mono">
                                                {id}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Invalid Inputs */}
                        {parseStats.invalidInputs.length > 0 && (
                            <div>
                                <h4 className="text-sm font-semibold text-orange-700 mb-2">
                                    Invalid Input ({parseStats.invalidInputs.length})
                                </h4>
                                <div className="bg-orange-50 rounded-lg p-3 max-h-40 overflow-y-auto">
                                    <div className="flex flex-wrap gap-1">
                                        {parseStats.invalidInputs.map((input, i) => (
                                            <span key={i} className="px-2 py-0.5 bg-orange-100 text-orange-800 rounded text-xs font-mono">
                                                {input}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </section>
            )}
        </div>
    );
}
