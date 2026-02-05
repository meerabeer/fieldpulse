"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, Polyline, Tooltip, Pane, useMap } from "react-leaflet";
import L from "leaflet";

// Fix Leaflet default icon URLs
delete (L.Icon.Default.prototype as { _getIconUrl?: string })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

type HajjSiteRow = Record<string, string | number | null>;

type HajjSitesPlannerMapProps = {
  sites: HajjSiteRow[];
  mode?: "default" | "cluster";
  markerColorBySiteId?: Record<string, string>;
  markerOpacityBySiteId?: Record<string, number>;
  onClusterMarkerClick?: (siteId: string) => void;
  locationQuery?: string;
  locationFilterActive?: boolean;
  onLocationQueryChange?: (query: string) => void;
  onLocationFilterApply?: () => void;
  onLocationFilterClear?: () => void;
  locationMatchCount?: number;
};

type MapPoint = {
  key: string;
  lat: number;
  lng: number;
  row: HajjSiteRow;
  areaKey: string | null;
  areaLabel: string;
  locationHighlighted: boolean;
};

type FeConnection = {
  key: string;
  from: MapPoint;
  to: MapPoint;
  feIdNormalized: string | null;
};

const AREA_COLOR_PALETTE = [
  "#1f77b4",
  "#ff7f0e",
  "#2ca02c",
  "#d62728",
  "#9467bd",
  "#8c564b",
  "#e377c2",
  "#7f7f7f",
  "#bcbd22",
  "#17becf",
  "#0ea5e9",
  "#22c55e",
  "#f97316",
  "#e11d48",
  "#9333ea",
  "#14b8a6",
];

const DEFAULT_AREA_COLOR = "#64748b";
const EMPTY_AREA_LABEL = "No Area";
const FE_LINE_COLOR = "#111827";

const HUB_NEUTRAL_COLOR = "#cbd5f5";
const HUB_FE_ORDER = [
  "5210",
  "5234",
  "2074",
  "5039",
  "2377",
  "2392",
  "5101",
  "2393",
  "5230",
  "2488",
  "4683",
  "4391",
  "2375",
  "5226",
  "2069",
  "5229",
  "2095",
];
const HUB_FE_IDS = new Set(HUB_FE_ORDER);

const HUB_COLOR_PALETTE = [
  "#0ea5e9",
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
  "#3b82f6",
  "#f43f5e",
  "#0f766e",
  "#a855f7",
];

const HUB_COLOR_MAP: Record<string, string> = HUB_FE_ORDER.reduce((acc, id, index) => {
  acc[id] = HUB_COLOR_PALETTE[index % HUB_COLOR_PALETTE.length];
  return acc;
}, {} as Record<string, string>);

type FeConnectionMode = "OFF" | "ON_CLICK" | "SHOW_ALL";

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

function getAreaKey(areaValue: unknown): string | null {
  if (areaValue == null) return null;
  const area = String(areaValue).trim();
  return area ? area : null;
}

function getAreaLabel(areaKey: string | null): string {
  return areaKey ?? EMPTY_AREA_LABEL;
}

function getIdVariants(value: unknown): string[] {
  const raw = String(value ?? "").trim();
  if (!raw) return [];
  const stripped = raw.replace(/^[Ww]/, "");
  const variants = new Set<string>();
  variants.add(raw);
  if (stripped && stripped !== raw) {
    variants.add(stripped);
  }
  return Array.from(variants);
}

function normalizeSiteId(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const stripped = raw.replace(/^[Ww]/, "");
  return stripped || raw;
}

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function getAreaColor(areaValue: unknown): string {
  const areaKey = getAreaKey(areaValue);
  if (!areaKey) return DEFAULT_AREA_COLOR;
  const index = hashString(areaKey) % AREA_COLOR_PALETTE.length;
  return AREA_COLOR_PALETTE[index];
}

// Location categories that should be highlighted (yellow glow)
const HIGHLIGHT_LOCATION_CATEGORIES = new Set([
  "jamarat",
  "train station",
  "long ladder",
  "critical-hub",
  "palace",
  "mina tower",
  "kidana building",
  "hospital",
  "ministry",
  "crane",
  "military camp",
  "laal company",
]);

// Quick filter chips for Location_Category
const LOCATION_CATEGORY_CHIPS = [
  "Jamarat",
  "Train Station",
  "Long Ladder",
  "Critical-HUB",
  "Palace",
  "Mina Tower",
  "Kidana Building",
  "Hospital",
  "Ministry",
  "Crane",
  "Military camp",
  "Laal Company",
];

function isHighlightedLocationCategory(value?: string | number | null): boolean {
  if (value == null) return false;
  const normalized = String(value).trim().toLowerCase();
  return HIGHLIGHT_LOCATION_CATEGORIES.has(normalized);
}

function matchesLocationQuery(locationCategory: string | number | null | undefined, query: string): boolean {
  if (!query.trim()) return false;
  if (locationCategory == null) return false;

  const normalizedCategory = String(locationCategory).trim().toLowerCase();
  if (!normalizedCategory) return false;

  const normalizedQuery = query.trim().toLowerCase();
  // Partial match (case-insensitive)
  return normalizedCategory.includes(normalizedQuery);
}

function createColoredPinIcon(color: string, highlighted = false): L.DivIcon {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 36" width="28" height="42">
      <defs>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="1" dy="2" stdDeviation="1.5" flood-opacity="0.3"/>
        </filter>
      </defs>
      <path fill="${color}" stroke="#ffffff" stroke-width="1.5" filter="url(#shadow)"
        d="M12 0C5.4 0 0 5.4 0 12c0 7.2 10.8 22.4 11.4 23.2.3.4.9.4 1.2 0C13.2 34.4 24 19.2 24 12c0-6.6-5.4-12-12-12z"/>
      <circle cx="12" cy="12" r="5" fill="#ffffff" opacity="0.9"/>
    </svg>
  `;

  return L.divIcon({
    html: svg,
    className: highlighted ? "hajj-site-pin location-highlight" : "hajj-site-pin",
    iconSize: [28, 42],
    iconAnchor: [14, 42],
    popupAnchor: [0, -36],
  });
}

function MapAutoFit({ points }: { points: MapPoint[] }) {
  const map = useMap();

  useMemo(() => {
    if (points.length === 0) return;

    if (points.length === 1) {
      map.setView([points[0].lat, points[0].lng], 12);
      return;
    }

    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number]));
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14 });
  }, [points, map]);

  return null;
}

export default function HajjSitesPlannerMap({
  sites,
  mode = "default",
  markerColorBySiteId,
  markerOpacityBySiteId,
  onClusterMarkerClick,
  locationQuery: externalLocationQuery,
  locationFilterActive: externalLocationFilterActive,
  onLocationQueryChange,
  onLocationFilterApply,
  onLocationFilterClear,
  locationMatchCount: externalLocationMatchCount,
}: HajjSitesPlannerMapProps) {
  const isClusterMode = mode === "cluster";

  // Internal Location_Category search state (used when external props not provided)
  const [internalLocationQuery, setInternalLocationQuery] = useState("");
  const [internalLocationFilterActive, setInternalLocationFilterActive] = useState(false);

  // Use external or internal state
  const locationQuery = externalLocationQuery ?? internalLocationQuery;
  const locationFilterActive = externalLocationFilterActive ?? internalLocationFilterActive;

  const handleLocationQueryChange = useCallback(
    (query: string) => {
      if (onLocationQueryChange) {
        onLocationQueryChange(query);
      } else {
        setInternalLocationQuery(query);
      }
    },
    [onLocationQueryChange]
  );

  const handleLocationFilterApply = useCallback(() => {
    if (onLocationFilterApply) {
      onLocationFilterApply();
    } else {
      setInternalLocationFilterActive(true);
    }
  }, [onLocationFilterApply]);

  const handleLocationFilterClear = useCallback(() => {
    if (onLocationFilterClear) {
      onLocationFilterClear();
    } else {
      setInternalLocationFilterActive(false);
    }
  }, [onLocationFilterClear]);

  const [selectedArea, setSelectedArea] = useState<string | null>(null);
  const [selectedConnection, setSelectedConnection] = useState<{
    from: MapPoint;
    to: MapPoint;
    feIdNormalized: string | null;
  } | null>(null);
  const [feConnectionMode, setFeConnectionMode] = useState<FeConnectionMode>("ON_CLICK");
  const [selectedHubFeId, setSelectedHubFeId] = useState<string | null>(null);

  // Track when Location filter is first applied to trigger fit bounds
  const [shouldFitLocationBounds, setShouldFitLocationBounds] = useState(false);
  const prevLocationFilterActiveRef = useRef(locationFilterActive);

  const points = useMemo(() => {
    return sites
      .map((row, index) => {
        const lat = parseCoordinate(row["Latitude"]);
        const lng = parseCoordinate(row["Longitude"]);
        if (lat == null || lng == null) return null;

        const siteId = row["Site ID"];
        const key = siteId != null && String(siteId).trim()
          ? String(siteId)
          : `row-${index}`;
        const areaKey = getAreaKey(row["Area"]);
        const areaLabel = getAreaLabel(areaKey);
        const locationHighlighted = isHighlightedLocationCategory(row["Location_Category"]);

        return { key, lat, lng, row, areaKey, areaLabel, locationHighlighted } as MapPoint;
      })
      .filter((point): point is MapPoint => point != null);
  }, [sites]);

  const areaFilteredPoints = useMemo(() => {
    if (isClusterMode || !selectedArea) return points;
    return points.filter((point) => point.areaLabel === selectedArea);
  }, [points, selectedArea, isClusterMode]);

  const legendAreas = useMemo(() => {
    if (isClusterMode) return [];
    const unique = new Set<string>();
    for (const point of points) {
      unique.add(point.areaLabel);
    }
    return Array.from(unique).sort((a, b) => a.localeCompare(b));
  }, [points, isClusterMode]);

  const filteredPoints = useMemo(() => {
    if (isClusterMode) return points;
    if (!selectedHubFeId) return areaFilteredPoints;

    const normalizedHub = normalizeSiteId(selectedHubFeId);
    if (!normalizedHub) return areaFilteredPoints;

    const hubSites = areaFilteredPoints.filter((point) => {
      const feNormalized = normalizeSiteId(point.row["FE ID"]);
      return feNormalized === normalizedHub;
    });

    const hubPoint = points.find((point) => normalizeSiteId(point.row["Site ID"]) === normalizedHub);
    if (hubPoint && !hubSites.some((point) => point.key === hubPoint.key)) {
      return [hubPoint, ...hubSites];
    }

    return hubSites;
  }, [areaFilteredPoints, points, selectedHubFeId, isClusterMode]);

  // Precompute Location_Category matches for current query (before filter is applied)
  const locationMatchedSiteKeys = useMemo(() => {
    if (!locationQuery.trim()) return new Set<string>();
    const matched = new Set<string>();
    for (const point of points) {
      if (matchesLocationQuery(point.row["Location_Category"], locationQuery)) {
        matched.add(point.key);
      }
    }
    return matched;
  }, [locationQuery, points]);

  const locationMatchCount = externalLocationMatchCount ?? locationMatchedSiteKeys.size;

  // Apply Location_Category filter on top of existing filters
  const locationFilteredPoints = useMemo(() => {
    if (!locationFilterActive) return filteredPoints;
    return filteredPoints.filter((point) => locationMatchedSiteKeys.has(point.key));
  }, [filteredPoints, locationFilterActive, locationMatchedSiteKeys]);

  // Track Location filter activation for fit bounds
  useEffect(() => {
    if (locationFilterActive && !prevLocationFilterActiveRef.current) {
      setShouldFitLocationBounds(true);
    }
    prevLocationFilterActiveRef.current = locationFilterActive;
  }, [locationFilterActive]);

  // Reset fit bounds flag after it's been consumed
  useEffect(() => {
    if (shouldFitLocationBounds) {
      const timer = setTimeout(() => setShouldFitLocationBounds(false), 100);
      return () => clearTimeout(timer);
    }
  }, [shouldFitLocationBounds]);

  const siteLookup = useMemo(() => {
    const lookup = new Map<string, MapPoint>();
    for (const point of points) {
      const variants = getIdVariants(point.row["Site ID"]);
      for (const key of variants) {
        if (!lookup.has(key)) {
          lookup.set(key, point);
        }
      }
    }
    return lookup;
  }, [points]);

  const allFeConnections = useMemo(() => {
    const connections: FeConnection[] = [];
    const seen = new Set<string>();

    for (const point of points) {
      const feId = point.row["FE ID"];
      const feIdNormalized = normalizeSiteId(feId);
      const variants = getIdVariants(feId);
      let matched: MapPoint | null = null;

      for (const key of variants) {
        const found = siteLookup.get(key);
        if (found) {
          matched = found;
          break;
        }
      }

      if (!matched || matched.key === point.key) continue;

      const fromId = normalizeSiteId(point.row["Site ID"]);
      const toId = normalizeSiteId(matched.row["Site ID"]);
      if (!fromId || !toId) continue;

      const pairKey = [fromId, toId].sort().join("__");
      if (seen.has(pairKey)) continue;

      seen.add(pairKey);
      connections.push({ key: pairKey, from: point, to: matched, feIdNormalized });
    }

    return connections;
  }, [points, siteLookup]);

  const handleMarkerClick = useCallback((point: MapPoint) => {
    if (isClusterMode) {
      return;
    }
    const siteId = point.row["Site ID"];
    const feId = point.row["FE ID"];
    const variants = getIdVariants(feId);
    let matched: MapPoint | null = null;

    for (const key of variants) {
      const found = siteLookup.get(key);
      if (found) {
        matched = found;
        break;
      }
    }

    console.log("FE_LINK", {
      siteId,
      feId,
      feFound: !!matched,
      feSiteId: matched?.row["Site ID"],
    });

    if (matched && matched.key !== point.key) {
      const fromLat = Number(point.lat);
      const fromLng = Number(point.lng);
      const toLat = Number(matched.lat);
      const toLng = Number(matched.lng);

      if (!Number.isFinite(fromLat) || !Number.isFinite(fromLng) || !Number.isFinite(toLat) || !Number.isFinite(toLng)) {
        console.log("FE_LINK_INVALID", {
          from: [point.lat, point.lng],
          to: [matched.lat, matched.lng],
        });
        setSelectedConnection(null);
        return;
      }

      console.log("FE_LINK_POS", {
        from: [fromLat, fromLng],
        to: [toLat, toLng],
      });
      setSelectedConnection({
        from: point,
        to: matched,
        feIdNormalized: normalizeSiteId(feId),
      });
      return;
    }

    setSelectedConnection(null);
  }, [isClusterMode, siteLookup]);

  const visibleConnection = useMemo(() => {
    if (isClusterMode) return null;
    if (!selectedConnection) return null;
    const fromVisible = locationFilteredPoints.some((point) => point.key === selectedConnection.from.key);
    if (!fromVisible) return null;
    return selectedConnection;
  }, [locationFilteredPoints, selectedConnection, isClusterMode]);

  const visibleFeConnections = useMemo(() => {
    if (isClusterMode) return [];
    if (feConnectionMode !== "SHOW_ALL") return [];
    const visibleFromKeys = new Set(locationFilteredPoints.map((point) => point.key));
    return allFeConnections.filter((connection) => {
      if (!visibleFromKeys.has(connection.from.key)) return false;
      if (!selectedHubFeId) return true;
      return connection.feIdNormalized === normalizeSiteId(selectedHubFeId);
    });
  }, [allFeConnections, feConnectionMode, locationFilteredPoints, selectedHubFeId, isClusterMode]);

  const hubCounts = useMemo(() => {
    // Hub FE counts are computed dynamically from the current dataset.
    const counts: Record<string, number> = {};
    for (const id of HUB_FE_ORDER) {
      counts[id] = 0;
    }
    for (const point of points) {
      const feNormalized = normalizeSiteId(point.row["FE ID"]);
      if (feNormalized && counts[feNormalized] != null) {
        counts[feNormalized] += 1;
      }
    }
    console.log("HUB_COUNTS", counts);
    return counts;
  }, [points]);

  const totalHubDependents = useMemo(() => {
    return Object.values(hubCounts).reduce((sum, count) => sum + count, 0);
  }, [hubCounts]);

  const hubLegendItems = useMemo(() => {
    return HUB_FE_ORDER.map((id) => ({
      id,
      count: hubCounts[id] ?? 0,
      color: HUB_COLOR_MAP[id],
    })).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  }, [hubCounts]);

  const getFeLineStyle = useCallback((feIdNormalized: string | null, weight: number) => {
    const isHub = feIdNormalized != null && HUB_FE_IDS.has(feIdNormalized);
    return {
      color: isHub ? (HUB_COLOR_MAP[feIdNormalized!] || FE_LINE_COLOR) : HUB_NEUTRAL_COLOR,
      weight,
      opacity: isHub ? 0.65 : 0.45,
      lineCap: "round" as const,
      dashArray: isHub ? undefined : "6 10",
    };
  }, []);

  const iconCache = useMemo(() => new Map<string, L.DivIcon>(), []);

  const getIconForColor = useCallback((color: string, highlighted: boolean) => {
    const cacheKey = `${color}:${highlighted ? "vip" : "default"}`;
    const cached = iconCache.get(cacheKey);
    if (cached) return cached;
    const icon = createColoredPinIcon(color, highlighted);
    iconCache.set(cacheKey, icon);
    return icon;
  }, [iconCache]);

  const defaultCenter: [number, number] = [24.7136, 46.6753];
  const defaultZoom = 6;

  return (
    <div className="h-[600px] w-full rounded-xl overflow-hidden border border-slate-200">
      <style>{`
        .hajj-site-pin {
          background: transparent !important;
          border: none !important;
          position: relative;
          overflow: visible !important;
        }
        .hajj-site-pin svg {
          position: relative;
          z-index: 1;
          display: block;
        }
        .hajj-site-pin.location-highlight::before {
          content: "";
          position: absolute;
          inset: -6px;
          border-radius: 999px;
          box-shadow: 0 0 12px 6px rgba(255, 215, 0, 0.85);
          opacity: 0.9;
          animation: location-pulse 2s ease-in-out infinite;
          z-index: 0;
        }
        @keyframes location-pulse {
          0%, 100% {
            transform: scale(0.9);
            opacity: 0.6;
          }
          50% {
            transform: scale(1.15);
            opacity: 1;
          }
        }
        .hajj-site-label {
          font-size: 10px;
          font-weight: 600;
          padding: 1px 4px;
          color: #0f172a;
          background: rgba(255, 255, 255, 0.9);
          border: 1px solid #e2e8f0;
          border-radius: 4px;
          box-shadow: 0 1px 2px rgba(0,0,0,0.08);
        }
      `}</style>
      <div className="h-full w-full flex flex-col">
        <div className="flex-1 min-h-0">
          <MapContainer
            center={defaultCenter}
            zoom={defaultZoom}
            scrollWheelZoom={true}
            style={{ height: "100%", width: "100%" }}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />

            {locationFilteredPoints.length > 0 && <MapAutoFit points={locationFilteredPoints} key={shouldFitLocationBounds ? 'location-fit' : 'normal'} />}

            {feConnectionMode === "ON_CLICK" && visibleConnection && (
              <Pane name="fe-connections" style={{ zIndex: 2000 }}>
                <Polyline
                  pane="overlayPane"
                  positions={[
                    [visibleConnection.from.lat, visibleConnection.from.lng],
                    [visibleConnection.to.lat, visibleConnection.to.lng],
                  ]}
                  pathOptions={getFeLineStyle(visibleConnection.feIdNormalized, 3)}
                />
              </Pane>
            )}

            {feConnectionMode === "SHOW_ALL" && visibleFeConnections.length > 0 && (
              <Pane name="fe-connections" style={{ zIndex: 2000 }}>
                {visibleFeConnections.map((connection) => (
                  <Polyline
                    key={connection.key}
                    pane="overlayPane"
                    positions={[
                      [connection.from.lat, connection.from.lng],
                      [connection.to.lat, connection.to.lng],
                    ]}
                    pathOptions={getFeLineStyle(connection.feIdNormalized, 2)}
                  />
                ))}
              </Pane>
            )}

            {locationFilteredPoints.map((point) => {
              const siteIdRaw = point.row["Site ID"] ? String(point.row["Site ID"]).trim() : "";
              const normalizedSiteId = normalizeSiteId(siteIdRaw);
              const overrideColor =
                (siteIdRaw && markerColorBySiteId?.[siteIdRaw]) ||
                (normalizedSiteId && markerColorBySiteId?.[normalizedSiteId]) ||
                undefined;
              const overrideOpacity =
                (siteIdRaw && markerOpacityBySiteId?.[siteIdRaw]) ||
                (normalizedSiteId && markerOpacityBySiteId?.[normalizedSiteId]) ||
                undefined;
              const markerOpacity = typeof overrideOpacity === 'number' ? overrideOpacity : 1;
              const areaColor = getAreaColor(point.areaKey);
              const markerColor = overrideColor ?? areaColor;
              const icon = getIconForColor(markerColor, point.locationHighlighted);

              return (
                <Marker
                  key={point.key}
                  position={[point.lat, point.lng]}
                  icon={icon}
                  opacity={markerOpacity}
                  eventHandlers={{
                    click: () => {
                      if (isClusterMode) {
                        if (siteIdRaw && onClusterMarkerClick) {
                          onClusterMarkerClick(siteIdRaw);
                        }
                        return;
                      }
                      handleMarkerClick(point);
                    },
                  }}
                >
                  <Tooltip
                    permanent
                    direction="top"
                    offset={[0, -8]}
                    opacity={0.9}
                    className="hajj-site-label"
                  >
                    {siteIdRaw || "-"}
                  </Tooltip>
                  <Popup>
                    <div className="text-sm space-y-1 min-w-[220px]">
                      <div className="font-semibold text-base">
                        {point.row["Site ID"] ?? "-"}
                      </div>
                      <div className="text-slate-600">
                        {point.row["FE ID"] ?? "-"}
                      </div>
                      <div>
                        <span className="text-slate-500">Location:</span> {point.row["Location"] ?? "-"}
                      </div>
                      <div>
                        <span className="text-slate-500">Location_Category:</span> {point.row["Location_Category"] ?? "-"}
                      </div>
                      <div>
                        <span className="text-slate-500">Area:</span> {point.row["Area"] ?? "-"}
                      </div>
                      <div>
                        <span className="text-slate-500">Technology:</span> {point.row["Technology"] ?? "-"}
                      </div>
                      <div>
                        <span className="text-slate-500">VIP_Category:</span> {point.row["VIP_Category"] ?? "-"}
                      </div>
                      <div>
                        <span className="text-slate-500">Site_Type_Category:</span> {point.row["Site_Type_Category"] ?? "-"}
                      </div>
                      <div>
                        <span className="text-slate-500">Access_Status:</span> {point.row["Access_Status"] ?? "-"}
                      </div>
                    </div>
                  </Popup>
                </Marker>
              );
            })}
          </MapContainer>
        </div>

        {!isClusterMode && (
          <div className="border-t border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => setSelectedArea(null)}
                  className={`px-2 py-1 rounded-md border transition ${
                    selectedArea === null
                      ? "bg-slate-800 text-white border-slate-800"
                      : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                  }`}
                >
                  All
                </button>
                {legendAreas.map((area) => {
                  const color = getAreaColor(area === EMPTY_AREA_LABEL ? null : area);
                  const isActive = selectedArea === area;
                  return (
                    <button
                      key={area}
                      type="button"
                      onClick={() => setSelectedArea((prev) => (prev === area ? null : area))}
                      className={`flex items-center gap-2 px-2 py-1 rounded-md border transition ${
                        isActive
                          ? "bg-slate-800 text-white border-slate-800"
                          : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                      }`}
                    >
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: color }}
                      />
                      <span className="whitespace-nowrap">{area}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Location_Category Search Row */}
            <div className="flex flex-col gap-2 mt-2 pt-2 border-t border-slate-100">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-medium text-slate-600">Quick filters:</span>
                {LOCATION_CATEGORY_CHIPS.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    onClick={() => {
                      handleLocationQueryChange(chip);
                      handleLocationFilterApply();
                    }}
                    className="px-2 py-0.5 bg-amber-100 text-amber-800 rounded text-xs hover:bg-amber-200 transition"
                  >
                    {chip}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 flex-1 max-w-md">
                  <input
                    type="text"
                    value={locationQuery}
                    onChange={(e) => handleLocationQueryChange(e.target.value)}
                    placeholder="Search Location_Category… (e.g., jamarat, hospital, train)"
                    className="flex-1 px-2 py-1 border border-slate-300 rounded-md text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <span className="text-xs text-slate-500 whitespace-nowrap">
                    Matched:{" "}
                    {locationQuery.trim() && locationMatchCount > 0 ? (
                      <button
                        type="button"
                        onClick={handleLocationFilterApply}
                        className="font-semibold text-blue-600 hover:underline"
                      >
                        {locationMatchCount}
                      </button>
                    ) : (
                      <span>{locationMatchCount}</span>
                    )}
                  </span>
                  {locationQuery.trim() && locationMatchCount > 0 && !locationFilterActive && (
                    <button
                      type="button"
                      onClick={handleLocationFilterApply}
                      className="px-2 py-1 bg-blue-600 text-white rounded-md text-xs font-medium hover:bg-blue-700 transition"
                    >
                      Show on Map
                    </button>
                  )}
                  {locationFilterActive && (
                    <button
                      type="button"
                      onClick={handleLocationFilterClear}
                      className="px-2 py-1 bg-red-100 text-red-700 rounded-md text-xs font-medium hover:bg-red-200 transition flex items-center gap-1"
                    >
                      <span>✕</span>
                      <span>Clear filter</span>
                    </button>
                  )}
                </div>
                {locationFilterActive && (
                  <span className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded-md">
                    Location filter: "{locationQuery}" ({locationFilteredPoints.length} sites)
                  </span>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 mt-2 pt-2 border-t border-slate-100 flex-wrap">
              <div className="flex items-center gap-4 text-[11px] text-slate-500">
                <div className="flex items-center gap-2 text-xs text-slate-600">
                  <button
                    type="button"
                    onClick={() => setFeConnectionMode("OFF")}
                    className={`px-2 py-1 rounded-md border transition ${
                      feConnectionMode === "OFF"
                        ? "bg-slate-800 text-white border-slate-800"
                        : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                    }`}
                  >
                    Off
                  </button>
                  <button
                    type="button"
                    onClick={() => setFeConnectionMode("ON_CLICK")}
                    className={`px-2 py-1 rounded-md border transition ${
                      feConnectionMode === "ON_CLICK"
                        ? "bg-slate-800 text-white border-slate-800"
                        : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                    }`}
                  >
                    On Click
                  </button>
                  <button
                    type="button"
                    onClick={() => setFeConnectionMode("SHOW_ALL")}
                    className={`px-2 py-1 rounded-md border transition ${
                      feConnectionMode === "SHOW_ALL"
                        ? "bg-slate-800 text-white border-slate-800"
                        : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                    }`}
                  >
                    Show All
                  </button>
                </div>
                <div className="flex items-center gap-2 text-xs text-slate-600">
                  <span className="font-medium text-slate-500">
                    Hub FE Lines ({totalHubDependents})
                  </span>
                  <div className="flex items-center gap-2 flex-wrap max-h-16 overflow-y-auto">
                    <button
                      type="button"
                      onClick={() => setSelectedHubFeId(null)}
                      className={`flex items-center gap-1 rounded-md border px-2 py-1 transition ${
                        selectedHubFeId === null
                          ? "bg-slate-800 text-white border-slate-800"
                          : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                      }`}
                    >
                      All Hubs
                    </button>
                    {hubLegendItems.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() =>
                          setSelectedHubFeId((prev) => (prev === item.id ? null : item.id))
                        }
                        className={`flex items-center gap-1 rounded-md border px-2 py-1 transition ${
                          selectedHubFeId === item.id
                            ? "bg-slate-800 text-white border-slate-800"
                            : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                        }`}
                      >
                        <span
                          className="inline-block h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: item.color }}
                        />
                        <span className="text-[11px] text-slate-600">
                          {item.id} ({item.count})
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
                <span>
                  Showing {locationFilteredPoints.length} of {points.length} sites
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Cluster Mode Location_Category Controls */}
        {isClusterMode && (
          <div className="border-t border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-medium text-slate-600">Quick filters:</span>
                {LOCATION_CATEGORY_CHIPS.map((chip) => (
                  <button
                    key={chip}
                    type="button"
                    onClick={() => {
                      handleLocationQueryChange(chip);
                      handleLocationFilterApply();
                    }}
                    className="px-2 py-0.5 bg-amber-100 text-amber-800 rounded text-xs hover:bg-amber-200 transition"
                  >
                    {chip}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-2 flex-1 max-w-md">
                  <input
                    type="text"
                    value={locationQuery}
                    onChange={(e) => handleLocationQueryChange(e.target.value)}
                    placeholder="Search Location_Category… (e.g., jamarat, hospital, train)"
                    className="flex-1 px-2 py-1 border border-slate-300 rounded-md text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <span className="text-xs text-slate-500 whitespace-nowrap">
                    Matched:{" "}
                    {locationQuery.trim() && locationMatchCount > 0 ? (
                      <button
                        type="button"
                        onClick={handleLocationFilterApply}
                        className="font-semibold text-blue-600 hover:underline"
                      >
                        {locationMatchCount}
                      </button>
                    ) : (
                      <span>{locationMatchCount}</span>
                    )}
                  </span>
                  {locationQuery.trim() && locationMatchCount > 0 && !locationFilterActive && (
                    <button
                      type="button"
                      onClick={handleLocationFilterApply}
                      className="px-2 py-1 bg-blue-600 text-white rounded-md text-xs font-medium hover:bg-blue-700 transition"
                    >
                      Show on Map
                    </button>
                  )}
                  {locationFilterActive && (
                    <button
                      type="button"
                      onClick={handleLocationFilterClear}
                      className="px-2 py-1 bg-red-100 text-red-700 rounded-md text-xs font-medium hover:bg-red-200 transition flex items-center gap-1"
                    >
                      <span>✕</span>
                      <span>Clear filter</span>
                    </button>
                  )}
                </div>
                {locationFilterActive && (
                  <span className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded-md">
                    Location filter: "{locationQuery}" ({locationFilteredPoints.length} sites)
                  </span>
                )}
                <span className="text-xs text-slate-500 ml-auto">
                  Showing {locationFilteredPoints.length} of {points.length} sites
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
