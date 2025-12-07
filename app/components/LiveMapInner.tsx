"use client";

import { useMemo, useCallback, useState, useEffect } from "react";
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap, Circle } from "react-leaflet";
import L from "leaflet";
import {
  type NfoStatusRow,
  type SiteRecord,
  hasValidLocation,
  getSiteById,
  findNearestSite,
  calculateDistanceKm,
  formatDistanceLabel,
  isOnline,
  ageMinutes,
  computeAssignmentState,
  computePingStatus,
} from "../lib/nfoHelpers";
import type { WarehouseRecord } from "./RoutePlanner";

const PAGE_SIZE = 1000;

/**
 * Props for LiveMapInner component.
 * 
 * MAP STATE PERSISTENCE:
 * - `mapAreaFilter` and `mapNfoFilter` are controlled by parent (page.tsx)
 * - These are persisted to localStorage by the parent
 * - When user interacts with area pills or legend filter, we call the onChange callbacks
 * - This ensures state survives: tab switches, 30s data refresh, and hard F5 reload
 */
type LiveMapInnerProps = {
  nfos: NfoStatusRow[];
  sites: SiteRecord[];
  warehouses: WarehouseRecord[];
  // Persisted state - controlled by parent
  mapAreaFilter: string | null;        // "NFOs_ONLY", null (All Sites), or specific area name
  mapNfoFilter: string | null;         // null (all), "free", "busy", "on-shift", "off-shift"
  onMapAreaFilterChange: (area: string | null) => void;
  onMapNfoFilterChange: (filter: string | null) => void;
  // For Leaflet invalidateSize() - true when Live Map tab is active
  isActive: boolean;
};

// Site marker (blue)
const siteIcon = L.icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
});

// NFO marker - Free (green)
const nfoFreeIcon = L.icon({
  iconUrl:
    "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-green.png",
  iconRetinaUrl:
    "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-green.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
});

// NFO marker - Busy (red)
const nfoBusyIcon = L.icon({
  iconUrl:
    "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png",
  iconRetinaUrl:
    "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
});

// NFO marker - Off-shift/Logged out (grey)
const nfoOffIcon = L.icon({
  iconUrl:
    "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-grey.png",
  iconRetinaUrl:
    "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-grey.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
});

// Warehouse marker - Orange (distinct from NFOs and sites)
const warehouseIcon = L.icon({
  iconUrl:
    "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-orange.png",
  iconRetinaUrl:
    "https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-orange.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
});

function getNfoIcon(nfo: NfoStatusRow): L.Icon {
  // Use new assignment-based logic for Busy/Free icons
  const { isBusy, isFree } = computeAssignmentState(nfo);
  if (isBusy) {
    return nfoBusyIcon;
  }
  if (isFree) {
    return nfoFreeIcon;
  }
  // off-shift, logged out, or unknown
  return nfoOffIcon;
}

/**
 * Site Search component - search and zoom to specific sites
 */
function SiteSearch({ sitesWithCoords, onSiteSelect }: { sitesWithCoords: SiteRecord[]; onSiteSelect: (site: SiteRecord | null) => void }) {
  const [searchTerm, setSearchTerm] = useState("");
  const [isOpen, setIsOpen] = useState(false);

  const filteredSites = useMemo(() => {
    if (!searchTerm.trim()) return [];
    const term = searchTerm.toLowerCase().trim();
    return sitesWithCoords.filter(
      (site) =>
        site.site_id.toLowerCase().includes(term) ||
        (site.name && site.name.toLowerCase().includes(term)) ||
        (site.area && site.area.toLowerCase().includes(term))
    );
  }, [searchTerm, sitesWithCoords]);

  const handleSelectSite = useCallback(
    (site: SiteRecord) => {
      onSiteSelect(site);
      setSearchTerm("");
      setIsOpen(false);
      // When selecting a site, also switch to its area so the blue marker is visible
      if (hasValidLocation({ lat: site.latitude, lng: site.longitude })) {
        // First switch to the site's area filter so marker is visible
        window.dispatchEvent(
          new CustomEvent("setAreaFilter", {
            detail: { area: site.area || "All" },
          })
        );
        // Then zoom to the site at max zoom
        setTimeout(() => {
          window.dispatchEvent(
            new CustomEvent("zoomToSite", {
              detail: { lat: site.latitude, lng: site.longitude, zoom: 18 },
            })
          );
        }, 100);
      }
    },
    [onSiteSelect]
  );

  return (
    <div className="relative text-xs">
      <input
        type="text"
        placeholder="Search by ID, name, or area..."
        value={searchTerm}
        onChange={(e) => {
          setSearchTerm(e.target.value);
          setIsOpen(true);
        }}
        onFocus={() => setIsOpen(true)}
        className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs focus:outline-none focus:border-blue-500"
      />

      {isOpen && searchTerm.trim() && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-300 rounded shadow-lg max-h-48 overflow-y-auto z-50">
          {filteredSites.length > 0 ? (
            filteredSites.map((site, index) => (
              <button
                key={`${site.site_id}-${index}`}
                onClick={() => handleSelectSite(site)}
                className="w-full text-left px-3 py-2 hover:bg-blue-50 border-b border-gray-100 last:border-b-0 transition-colors"
              >
                <div className="font-semibold text-blue-600">{site.site_id}</div>
                {site.name && <div className="text-gray-600">{site.name}</div>}
                {site.area && <div className="text-gray-500 text-xs">{site.area}</div>}
              </button>
            ))
          ) : (
            <div className="px-3 py-2 text-gray-500">No sites found</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * NFO Search component - search and zoom to specific NFOs
 * Now also sets selectedNfoForTile for the bottom panel
 */
function NfoSearch({ 
  nfosWithCoords, 
  onNfoSelect,
  selectedNfoUsername,
  onClear,
}: { 
  nfosWithCoords: NfoStatusRow[];
  onNfoSelect: (nfo: NfoStatusRow) => void;
  selectedNfoUsername: string | null;
  onClear: () => void;
}) {
  const [searchTerm, setSearchTerm] = useState("");
  const [isOpen, setIsOpen] = useState(false);

  const filteredNfos = useMemo(() => {
    if (!searchTerm.trim()) return [];
    const term = searchTerm.toLowerCase().trim();
    return nfosWithCoords.filter(
      (nfo) =>
        nfo.username.toLowerCase().includes(term) ||
        (nfo.name && nfo.name.toLowerCase().includes(term))
    ).slice(0, 10); // Limit to 10 results
  }, [searchTerm, nfosWithCoords]);

  const handleSelectNfo = useCallback(
    (nfo: NfoStatusRow) => {
      setSearchTerm("");
      setIsOpen(false);
      // Set the selected NFO for the tile
      onNfoSelect(nfo);
      // Zoom to NFO and open popup
      if (hasValidLocation({ lat: nfo.lat, lng: nfo.lng })) {
        window.dispatchEvent(
          new CustomEvent("zoomToNfo", {
            detail: { lat: nfo.lat, lng: nfo.lng, zoom: 16, username: nfo.username },
          })
        );
      }
    },
    [onNfoSelect]
  );

  const handleClear = () => {
    setSearchTerm("");
    setIsOpen(false);
    onClear();
  };

  // Find selected NFO name for display
  const selectedNfo = selectedNfoUsername 
    ? nfosWithCoords.find(n => n.username === selectedNfoUsername)
    : null;

  return (
    <div className="relative text-xs">
      <div className="flex gap-1">
        <div className="flex-1 relative">
          <input
            type="text"
            placeholder={selectedNfo ? `Selected: ${selectedNfo.name || selectedNfo.username}` : "Search by NFO name or username..."}
            value={searchTerm}
            onChange={(e) => {
              setSearchTerm(e.target.value);
              setIsOpen(true);
            }}
            onFocus={() => setIsOpen(true)}
            onBlur={() => {
              // Delay closing to allow click on dropdown
              setTimeout(() => setIsOpen(false), 200);
            }}
            className={`w-full px-2 py-1.5 border rounded text-xs focus:outline-none focus:border-blue-500 ${
              selectedNfo ? "border-green-500 bg-green-50" : "border-gray-300"
            }`}
          />
        </div>
        {selectedNfoUsername && (
          <button
            onClick={handleClear}
            className="px-2 py-1 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded text-xs font-medium"
            title="Clear NFO selection and route"
          >
            ✕ Clear
          </button>
        )}
      </div>

      {isOpen && searchTerm.trim() && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-300 rounded shadow-lg max-h-48 overflow-y-auto z-50">
          {filteredNfos.length > 0 ? (
            filteredNfos.map((nfo) => {
              // Use new assignment-based logic for status colors
              const { isBusy, isFree } = computeAssignmentState(nfo);
              const statusColor = isFree ? "text-green-600" : isBusy ? "text-red-600" : "text-gray-500";
              const statusLabel = isFree ? "Free" : isBusy ? "Busy" : (nfo.status || "Off-Shift");
              return (
                <button
                  key={nfo.username}
                  onClick={() => handleSelectNfo(nfo)}
                  className="w-full text-left px-3 py-2 hover:bg-green-50 border-b border-gray-100 last:border-b-0 transition-colors"
                >
                  <div className="font-semibold text-green-700">
                    {nfo.name || nfo.username}
                  </div>
                  <div className="text-gray-500 text-xs flex items-center gap-2">
                    <span>{nfo.username}</span>
                    <span>·</span>
                    <span className={statusColor}>
                      {statusLabel}
                    </span>
                  </div>
                </button>
              );
            })
          ) : (
            <div className="px-3 py-2 text-gray-500">No NFOs found</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Area Filter component - filter sites by area with NFOs Only option
 */
function AreaFilter({
  sitesWithCoords,
  selectedArea,
  onAreaChange,
}: {
  sitesWithCoords: SiteRecord[];
  selectedArea: string | null;
  onAreaChange: (area: string | null) => void;
}) {
  // Get unique areas from sites
  const areas = useMemo(() => {
    const uniqueAreas = new Set<string>();
    for (const site of sitesWithCoords) {
      if (site.area) {
        uniqueAreas.add(site.area);
      }
    }
    return Array.from(uniqueAreas).sort();
  }, [sitesWithCoords]);

  return (
    <div className="flex flex-wrap gap-1.5">
      {/* "NFOs Only" pill - default, no site markers for performance */}
      <button
        onClick={() => onAreaChange("NFOs_ONLY")}
        className={`px-2.5 py-1 rounded-full text-xs font-medium transition-all ${
          selectedArea === "NFOs_ONLY"
            ? "bg-green-600 text-white"
            : "bg-gray-200 text-gray-800 hover:bg-gray-300"
        }`}
      >
        NFOs Only
      </button>

      {/* "All Sites" pill */}
      <button
        onClick={() => onAreaChange(null)}
        className={`px-2.5 py-1 rounded-full text-xs font-medium transition-all ${
          selectedArea === null
            ? "bg-blue-600 text-white"
            : "bg-gray-200 text-gray-800 hover:bg-gray-300"
        }`}
      >
        All Sites
      </button>

      {/* Area pills */}
      {areas.map((area) => (
        <button
          key={area}
          onClick={() => onAreaChange(area)}
          className={`px-2.5 py-1 rounded-full text-xs font-medium transition-all ${
            selectedArea === area
              ? "bg-blue-600 text-white"
              : "bg-gray-200 text-gray-800 hover:bg-gray-300"
          }`}
        >
          {area}
        </button>
      ))}
    </div>
  );
}

/**
 * MapSizeFixer component - fixes Leaflet "container size changed while hidden" issue.
 * 
 * When the Live Map tab becomes active (or window is resized), we call map.invalidateSize()
 * so Leaflet recalculates the container dimensions and renders tiles correctly.
 */
function MapSizeFixer({ active }: { active: boolean }) {
  const map = useMap();

  // Call invalidateSize when tab becomes active
  useEffect(() => {
    if (!map) return;
    if (!active) return;
    // Small timeout so layout has settled after tab switch
    const id = setTimeout(() => {
      map.invalidateSize();
    }, 100);
    return () => clearTimeout(id);
  }, [map, active]);

  // Also handle window resize events
  useEffect(() => {
    if (!map) return;
    const handler = () => map.invalidateSize();
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, [map]);

  return null;
}

/**
 * Map Center Control component - handles zoom to NFO or Site on click
 */
function MapCenterControl() {
  const map = useMap();

  useEffect(() => {
    const handleZoomToNfo = (e: any) => {
      const { lat, lng, zoom } = e.detail;
      if (map && lat != null && lng != null) {
        map.setView([lat, lng], zoom || 12);
      }
    };

    const handleZoomToSite = (e: any) => {
      const { lat, lng, zoom } = e.detail;
      if (map && lat != null && lng != null) {
        map.setView([lat, lng], zoom || 18);
      }
    };

    window.addEventListener("zoomToNfo", handleZoomToNfo);
    window.addEventListener("zoomToSite", handleZoomToSite);
    return () => {
      window.removeEventListener("zoomToNfo", handleZoomToNfo);
      window.removeEventListener("zoomToSite", handleZoomToSite);
    };
  }, [map]);

  return null;
}

/**
 * Inner legend component that uses useMap hook
 */
function MapLegend({
  sitesWithCoords,
  nfosWithCoords,
  warehouseCount,
  showWarehouses,
  onToggleWarehouses,
  selectedNfoFilter,
  onFilterChange,
}: {
  sitesWithCoords: SiteRecord[];
  nfosWithCoords: NfoStatusRow[];
  warehouseCount: number;
  showWarehouses: boolean;
  onToggleWarehouses: () => void;
  selectedNfoFilter: string | null;
  onFilterChange: (filter: string | null) => void;
}) {
  // Count NFOs by status using assignment-based logic
  const counts = useMemo(() => {
    let free = 0;
    let busy = 0;
    let onShift = 0;
    let offShift = 0;
    for (const n of nfosWithCoords) {
      const { isBusy, isFree, isOnShift, isOffShift } = computeAssignmentState(n);
      if (isFree) free += 1;
      if (isBusy) busy += 1;
      if (isOnShift) onShift += 1;
      if (isOffShift) offShift += 1;
    }
    return { free, busy, onShift, offShift, sites: sitesWithCoords.length };
  }, [nfosWithCoords, sitesWithCoords]);

  const legendItems = [
    { id: null, label: "All NFOs", color: "#6366f1", count: nfosWithCoords.length },
    { id: "free", label: "NFO (Free)", color: "#52c41a", count: counts.free },
    { id: "busy", label: "NFO (Busy)", color: "#f5222d", count: counts.busy },
    { id: "on-shift", label: "NFO (On-shift)", color: "#3b82f6", count: counts.onShift },
    { id: "off-shift", label: "NFO (Off-shift)", color: "#999", count: counts.offShift },
  ];

  return (
    <div className="bg-white rounded-lg shadow-md p-3 text-xs">
      <div className="font-semibold mb-2">Legend (Click to filter)</div>
      <div className="space-y-1">
        {legendItems.map((item) => (
          <button
            key={item.id ?? "all"}
            onClick={() => onFilterChange(selectedNfoFilter === item.id ? null : item.id)}
            className={`w-full flex items-center gap-2 p-1.5 rounded transition-all cursor-pointer ${
              selectedNfoFilter === item.id
                ? "bg-blue-100 ring-2 ring-blue-500"
                : "hover:bg-gray-100"
            }`}
          >
            <div
              className="w-5 h-5 rounded-full flex-shrink-0"
              style={{ backgroundColor: item.color }}
            />
            <span className="flex-1 text-left">{item.label}</span>
            <span className="text-gray-500 font-medium">({item.count})</span>
          </button>
        ))}

        {/* Sites count (non-clickable info) */}
        <div className="flex items-center gap-2 p-1.5 border-t border-gray-200 mt-2 pt-2">
          <div
            className="w-5 h-5 rounded-full flex-shrink-0"
            style={{ backgroundColor: "#3388ff" }}
          />
          <span className="flex-1 text-left">Sites</span>
          <span className="text-gray-500 font-medium">({counts.sites})</span>
        </div>

        {/* Warehouses toggle */}
        <button
          onClick={onToggleWarehouses}
          className={`w-full flex items-center gap-2 p-1.5 rounded transition-all cursor-pointer ${
            showWarehouses
              ? "bg-orange-100 ring-2 ring-orange-500"
              : "hover:bg-gray-100"
          }`}
        >
          <div
            className="w-5 h-5 rounded-full flex-shrink-0"
            style={{ backgroundColor: "#f97316" }}
          />
          <span className="flex-1 text-left">Warehouses</span>
          <span className="text-gray-500 font-medium">({warehouseCount})</span>
        </button>

        {/* Connection line info */}
        <div className="flex items-center gap-2 p-1.5">
          <div
            className="w-5 h-1 flex-shrink-0"
            style={{ backgroundColor: "#FFD700" }}
          />
          <span className="text-yellow-600">Connection line</span>
        </div>
      </div>
    </div>
  );
}

// ORS Route API response type
type RouteInfo = {
  nfoUsername: string;
  coordinates: [number, number][]; // [lng, lat] pairs from ORS
  distanceMeters: number;
  durationSeconds: number;
};

// Route result for NFO tile (similar to dashboard)
type NfoTileRouteResult = {
  distanceKm: number;
  durationMin: number | null; // null for fallback (straight-line)
  coordinates: [number, number][]; // [lng, lat] pairs for polyline
  viaWarehouse: string | null;
  isFallback?: boolean;
};

// Helper for case-insensitive warehouse name matching (same as dashboard)
const namesMatch = (a: string | null, b: string | null): boolean => {
  if (!a || !b) return false;
  return a.toLowerCase().trim() === b.toLowerCase().trim();
};

// Format route summary - SAME FORMAT AS DASHBOARD: "107.41 km, 77 min via Jeddah MC"
const formatRouteSummary = (result: NfoTileRouteResult): string => {
  const distStr = result.distanceKm.toFixed(2);
  
  if (result.isFallback) {
    // Fallback: show air distance only, no ETA
    if (result.viaWarehouse) {
      return `📏 ${distStr} km (air) via ${result.viaWarehouse}`;
    }
    return `📏 ${distStr} km (air)`;
  }
  
  // Normal ORS route: show distance and ETA
  const durationStr = Math.round(result.durationMin ?? 0);
  if (result.viaWarehouse) {
    return `🚗 ${distStr} km, ${durationStr} min via ${result.viaWarehouse}`;
  }
  return `🚗 ${distStr} km, ${durationStr} min`;
};

export default function LiveMapInner({ 
  nfos, 
  sites,
  warehouses,
  mapAreaFilter,
  mapNfoFilter,
  onMapAreaFilterChange,
  onMapNfoFilterChange,
  isActive,
}: LiveMapInnerProps) {
  // PERSISTED STATE (controlled by parent, survives tab switch and F5):
  // - mapAreaFilter: Area/site filter ("NFOs_ONLY", null for All Sites, or specific area)
  // - mapNfoFilter: NFO status filter (null for all, "free", "busy", "off-shift")
  // Use the props directly instead of local state, call onChange callbacks on user interaction

  // LOCAL STATE (ephemeral, resets on tab switch - this is intentional):
  const [selectedSiteFromSearch, setSelectedSiteFromSearch] = useState<SiteRecord | null>(null);
  // Highlight animation state for selected site
  const [showHighlight, setShowHighlight] = useState(false);
  const [highlightRadius, setHighlightRadius] = useState(20);
  // Track which NFO should have its popup opened (from NFO search)
  const [selectedNfoUsername, setSelectedNfoUsername] = useState<string | null>(null);
  
  // ORS Route state for "Top 5 Closest NFOs" panel (ephemeral - route clears on tab switch)
  const [activeRoute, setActiveRoute] = useState<RouteInfo | null>(null);
  const [routeLoading, setRouteLoading] = useState<string | null>(null); // username of NFO being loaded
  const [routeError, setRouteError] = useState<string | null>(null);

  // Selected NFO for bottom tile (persistent across map interactions until cleared)
  const [selectedNfoForTile, setSelectedNfoForTile] = useState<NfoStatusRow | null>(null);
  // Route state for the NFO tile
  const [nfoTileRoute, setNfoTileRoute] = useState<NfoTileRouteResult | null>(null);
  const [nfoTileRouteLoading, setNfoTileRouteLoading] = useState(false);
  const [nfoTileRouteError, setNfoTileRouteError] = useState<string | null>(null);

  // Warehouse visibility toggle (default: show warehouses)
  const [showWarehouses, setShowWarehouses] = useState(true);

  // Filter warehouses to only those with valid coordinates
  const warehousesWithCoords = useMemo(() => {
    return warehouses.filter(w => 
      hasValidLocation({ lat: w.latitude, lng: w.longitude }) && w.is_active
    );
  }, [warehouses]);

  // Listen for NFO selection event from search
  useEffect(() => {
    const handleNfoSelected = (e: CustomEvent<{ username: string }>) => {
      setSelectedNfoUsername(e.detail.username);
      // Auto-clear after 5 seconds
      setTimeout(() => setSelectedNfoUsername(null), 5000);
    };
    window.addEventListener("zoomToNfo", handleNfoSelected as EventListener);
    return () => {
      window.removeEventListener("zoomToNfo", handleNfoSelected as EventListener);
    };
  }, []);

  // Trigger highlight animation when a site is selected from search
  useEffect(() => {
    if (selectedSiteFromSearch) {
      setShowHighlight(true);
      setHighlightRadius(20);
      
      // Animate the radius pulsing
      let frame = 0;
      const animationInterval = setInterval(() => {
        frame++;
        // Pulsing effect: radius oscillates between 20 and 80
        const newRadius = 30 + Math.sin(frame * 0.3) * 25;
        setHighlightRadius(newRadius);
      }, 50);
      
      // Stop animation after 4 seconds
      const timeout = setTimeout(() => {
        clearInterval(animationInterval);
        setShowHighlight(false);
      }, 4000);
      
      return () => {
        clearInterval(animationInterval);
        clearTimeout(timeout);
      };
    } else {
      setShowHighlight(false);
    }
  }, [selectedSiteFromSearch]);

  // Listen for area filter change events (from SiteSearch when user selects a site)
  useEffect(() => {
    const handleSetAreaFilter = (e: any) => {
      const { area } = e.detail;
      if (area === "All") {
        onMapAreaFilterChange(null); // null means "All Sites"
      } else if (area) {
        onMapAreaFilterChange(area);
      }
    };

    window.addEventListener("setAreaFilter", handleSetAreaFilter);
    return () => {
      window.removeEventListener("setAreaFilter", handleSetAreaFilter);
    };
  }, [onMapAreaFilterChange]);

  // Filter NFOs and sites with valid coordinates
  const nfosWithCoords = useMemo(() => {
    return nfos.filter((row) =>
      hasValidLocation({ lat: row.lat, lng: row.lng })
    );
  }, [nfos]);

  // ALL sites with valid coordinates - used for search (not filtered by area)
  const allSitesWithCoords = useMemo(() => {
    return sites.filter((site) =>
      hasValidLocation({ lat: site.latitude, lng: site.longitude })
    );
  }, [sites]);

  // Sites filtered by area - used for displaying site markers
  const sitesWithCoords = useMemo(() => {
    // If NFOs_ONLY is selected, return empty array (don't show any sites)
    if (mapAreaFilter === "NFOs_ONLY") {
      return [];
    }
    
    // Apply area filter if a specific area is selected
    if (mapAreaFilter) {
      return allSitesWithCoords.filter((site) => site.area === mapAreaFilter);
    }
    
    // Return all sites (All Sites selected)
    return allSitesWithCoords;
  }, [allSitesWithCoords, mapAreaFilter]);

  // Build a map of site_id -> SiteRecord for quick lookups (use ALL sites)
  const siteById = useMemo(() => {
    return new Map(allSitesWithCoords.map((s) => [s.site_id, s]));
  }, [allSitesWithCoords]);

  // Enrich each NFO with site and distance information
  // This uses the SAME logic as the Dashboard to ensure consistency
  // Fields: nearestSiteId, airDistanceKm (with via_warehouse leg), pingStatus, etc.
  // MUST be defined BEFORE closestNfosToSelectedSite
  const enrichedNfos = useMemo(() => {
    return nfosWithCoords.map((nfo) => {
      let selectedSiteId: string | null = null;
      let selectedSiteName: string | null = null;
      let selectedSiteArea: string | null = null;
      let selectedSiteDistanceKm: number | null = null;
      
      // NEW: Match dashboard fields exactly
      let nearestSiteId: string | null = null;
      let nearestSiteDistanceKm: number | null = null;
      let airDistanceKm: number | null = null;

      // Use new assignment-based busy logic
      const { isBusy, isFree, isOnShift, isOffShift } = computeAssignmentState(nfo);
      
      // Compute ping status (same as dashboard)
      const { isNotActive, pingReason } = computePingStatus(nfo.last_active_at);

      const hasValidNfoCoords = hasValidLocation({ lat: nfo.lat, lng: nfo.lng });
      const assignedSiteId = (nfo.site_id ?? "").trim();

      // Always find the nearest site first (for the "Nearest site" field)
      const nearest = findNearestSite(
        { lat: nfo.lat, lng: nfo.lng },
        sites
      );
      if (nearest) {
        const siteRec = nearest.site as SiteRecord;
        nearestSiteId = siteRec.site_id;
        nearestSiteDistanceKm = nearest.distanceKm;
      }

      // 1a. If NFO is busy and has an assigned site with valid coords, use that for display
      if (
        isBusy &&
        assignedSiteId &&
        hasValidNfoCoords
      ) {
        const activeSite = getSiteById(sites, assignedSiteId);
        if (
          activeSite &&
          hasValidLocation({ lat: activeSite.latitude, lng: activeSite.longitude })
        ) {
          const dist = calculateDistanceKm(
            { lat: nfo.lat, lng: nfo.lng },
            { lat: activeSite.latitude, lng: activeSite.longitude }
          );
          selectedSiteId = activeSite.site_id;
          selectedSiteName = activeSite.name ?? null;
          selectedSiteArea = activeSite.area ?? null;
          selectedSiteDistanceKm = dist;
        } else if (activeSite) {
          // Site exists but doesn't have valid coords
          selectedSiteId = activeSite.site_id;
          selectedSiteName = activeSite.name ?? null;
          selectedSiteArea = activeSite.area ?? null;
          selectedSiteDistanceKm = null;
        }
      } else if (nearest) {
        // 1b. Otherwise, use nearest site
        const siteRec = nearest.site as SiteRecord;
        selectedSiteId = siteRec.site_id;
        selectedSiteName = siteRec.name ?? null;
        selectedSiteArea = siteRec.area ?? null;
        selectedSiteDistanceKm = nearest.distanceKm;
      }

      // Compute airDistanceKm with via_warehouse logic (SAME as dashboard)
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

      if (nfo.username === "ZAMEBIR") {
        console.log("[LiveMap DISTANCE DEBUG]", {
          username: nfo.username,
          status: nfo.status,
          site_id: nfo.site_id,
          via_warehouse: nfo.via_warehouse,
          warehouse_name: nfo.warehouse_name,
          nfoLat: nfo.lat,
          nfoLng: nfo.lng,
          selectedSiteId,
          selectedSiteDistanceKm,
          nearestSiteId,
          airDistanceKm,
        });
      }

      return {
        ...nfo,
        selectedSiteId,
        selectedSiteName,
        selectedSiteArea,
        selectedSiteDistanceKm,
        // NEW: Dashboard-matching fields
        nearestSiteId,
        nearestSiteDistanceKm,
        airDistanceKm,
        isNotActive,
        pingReason,
        isBusy,
        isFree,
        isOnShift,
        isOffShift,
      };
    });
  }, [nfosWithCoords, sites, warehouses]);

  // Filter enrichedNfos based on selected status filter (mapNfoFilter from props)
  const filteredEnrichedNfos = useMemo(() => {
    if (!mapNfoFilter) {
      return enrichedNfos; // Show all
    }
    return enrichedNfos.filter((nfo) => {
      // Use assignment-based logic for filtering
      const { isBusy, isFree, isOnShift, isOffShift } = computeAssignmentState(nfo);
      if (mapNfoFilter === "free") return isFree;
      if (mapNfoFilter === "busy") return isBusy;
      if (mapNfoFilter === "on-shift") return isOnShift;
      if (mapNfoFilter === "off-shift") return isOffShift;
      return true;
    });
  }, [enrichedNfos, mapNfoFilter]);

  // Calculate closest NFOs to the selected site
  // This MUST come after enrichedNfos definition
  const closestNfosToSelectedSite = useMemo(() => {
    if (!selectedSiteFromSearch || !hasValidLocation({ lat: selectedSiteFromSearch.latitude, lng: selectedSiteFromSearch.longitude })) {
      return [];
    }

    const distances = enrichedNfos.map((nfo) => ({
      nfo,
      distance: calculateDistanceKm(
        { lat: nfo.lat, lng: nfo.lng },
        { lat: selectedSiteFromSearch.latitude as number, lng: selectedSiteFromSearch.longitude as number }
      ),
    }));

    return distances
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 5)
      .map((item) => item);
  }, [selectedSiteFromSearch, enrichedNfos]);

  // Fetch driving route from ORS backend
  const fetchRoute = useCallback(async (nfo: typeof enrichedNfos[0]) => {
    if (!selectedSiteFromSearch || !hasValidLocation({ lat: selectedSiteFromSearch.latitude, lng: selectedSiteFromSearch.longitude })) {
      return;
    }
    if (!hasValidLocation({ lat: nfo.lat, lng: nfo.lng })) {
      return;
    }

    const baseUrl = process.env.NEXT_PUBLIC_ORS_BACKEND_URL || "https://meerabeer1990-nfo-ors-backend.hf.space";

    // Clear previous route and set loading state
    setActiveRoute(null);
    setRouteError(null);
    setRouteLoading(nfo.username);

    try {
      const startLng = nfo.lng as number;
      const startLat = nfo.lat as number;
      const endLng = selectedSiteFromSearch.longitude as number;
      const endLat = selectedSiteFromSearch.latitude as number;

      // Use the correct ORS backend endpoint with query parameters
      // Include maximum_search_radius to handle off-road sites (5 km)
      const params = new URLSearchParams({
        start_lon: String(startLng),
        start_lat: String(startLat),
        end_lon: String(endLng),
        end_lat: String(endLat),
        profile: "driving-car",
        maximum_search_radius: "5000", // 5 km - handle off-road sites
      });

      const url = `${baseUrl}/route?${params}`;
      
      const response = await fetch(url, {
        headers: {
          "Content-Type": "application/json",
        },
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      
      // Extract route geometry and summary from ORS response
      const feature = data.features?.[0];
      if (!feature) {
        throw new Error("No route found");
      }

      const coordinates = feature.geometry?.coordinates as [number, number][] || [];
      const summary = feature.properties?.summary;
      const distanceMeters = summary?.distance ?? 0;
      const durationSeconds = summary?.duration ?? 0;

      setActiveRoute({
        nfoUsername: nfo.username,
        coordinates,
        distanceMeters,
        durationSeconds,
      });
    } catch (error) {
      console.error("Route fetch error:", error);
      setRouteError("Route failed, try again");
    } finally {
      setRouteLoading(null);
    }
  }, [selectedSiteFromSearch]);

  // Clear route when selected site changes
  useEffect(() => {
    setActiveRoute(null);
    setRouteError(null);
  }, [selectedSiteFromSearch]);

  // Handle NFO selection for the tile (from search or marker click)
  const handleNfoSelectForTile = useCallback((nfo: NfoStatusRow) => {
    setSelectedNfoForTile(nfo);
    setSelectedNfoUsername(nfo.username);
    // Clear any previous route
    setNfoTileRoute(null);
    setNfoTileRouteError(null);
  }, []);

  // Clear NFO selection and route
  const handleClearNfoTile = useCallback(() => {
    setSelectedNfoForTile(null);
    setSelectedNfoUsername(null);
    setNfoTileRoute(null);
    setNfoTileRouteError(null);
  }, []);

  // Fetch route for the selected NFO tile (uses /api/ors-route like dashboard)
  // SAME LOGIC AS DASHBOARD: NFO -> (optional Warehouse) -> Site
  const fetchRouteForNfoTile = useCallback(async () => {
    if (!selectedNfoForTile) return;
    
    // Check NFO has valid coordinates
    if (!hasValidLocation({ lat: selectedNfoForTile.lat, lng: selectedNfoForTile.lng })) {
      setNfoTileRouteError("NFO has no GPS coordinates");
      return;
    }

    // Find target site (assigned site_id or nearest site) - SAME as dashboard
    const assignedSiteId = (selectedNfoForTile.site_id ?? "").trim();
    let targetSite: SiteRecord | null = null;
    
    if (assignedSiteId) {
      targetSite = getSiteById(sites, assignedSiteId) ?? null;
    }
    
    // If no assigned site, find nearest site
    if (!targetSite) {
      const nearest = findNearestSite(
        { lat: selectedNfoForTile.lat, lng: selectedNfoForTile.lng },
        sites
      );
      if (nearest) {
        targetSite = nearest.site as SiteRecord;
      }
    }
    
    if (!targetSite || !hasValidLocation({ lat: targetSite.latitude, lng: targetSite.longitude })) {
      setNfoTileRouteError("No valid destination site");
      return;
    }

    setNfoTileRouteLoading(true);
    setNfoTileRouteError(null);
    setNfoTileRoute(null);

    try {
      const nfoPoint = { lat: selectedNfoForTile.lat!, lng: selectedNfoForTile.lng! };
      const sitePoint = { lat: targetSite.latitude!, lng: targetSite.longitude! };

      // Check if we should route via warehouse (SAME as dashboard)
      const warehouseNameTrimmed = (selectedNfoForTile.warehouse_name ?? "").trim();
      const matchingWarehouse = selectedNfoForTile.via_warehouse && warehouseNameTrimmed
        ? warehouses.find(w =>
            namesMatch(w.name, warehouseNameTrimmed) &&
            hasValidLocation({ lat: w.latitude, lng: w.longitude })
          )
        : null;

      // Build coordinates array: NFO -> (optional Warehouse) -> Site
      // Format: [lng, lat] pairs as ORS expects
      const coords: [number, number][] = [[nfoPoint.lng, nfoPoint.lat]];
      if (matchingWarehouse) {
        coords.push([matchingWarehouse.longitude!, matchingWarehouse.latitude!]);
      }
      coords.push([sitePoint.lng, sitePoint.lat]);

      console.log("NFO Tile route request:", {
        username: selectedNfoForTile.username,
        nfo: nfoPoint,
        warehouse: matchingWarehouse ? { lat: matchingWarehouse.latitude, lng: matchingWarehouse.longitude, name: matchingWarehouse.name } : null,
        site: { ...sitePoint, id: targetSite.site_id },
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
      console.log("NFO Tile route response:", data);

      // Check if ORS could build a route
      if (!data.ok) {
        // Fallback: use air distance (with warehouse if applicable)
        // Get the enriched NFO which has pre-computed airDistanceKm
        const enriched = enrichedNfos.find(n => n.username === selectedNfoForTile.username);
        const fallbackDistance = enriched?.airDistanceKm ?? calculateDistanceKm(nfoPoint, sitePoint);
        
        setNfoTileRoute({
          distanceKm: fallbackDistance,
          durationMin: null,
          coordinates: coords,
          viaWarehouse: matchingWarehouse ? matchingWarehouse.name : null,
          isFallback: true,
        });
        return;
      }

      // Success - use the route from ORS
      setNfoTileRoute({
        distanceKm: data.route.distanceMeters / 1000,
        durationMin: data.route.durationSeconds / 60,
        coordinates: data.route.coordinates,
        viaWarehouse: matchingWarehouse ? matchingWarehouse.name : null,
        isFallback: false,
      });
    } catch (err) {
      setNfoTileRouteError(err instanceof Error ? err.message : "Route failed");
    } finally {
      setNfoTileRouteLoading(false);
    }
  }, [selectedNfoForTile, sites, warehouses, enrichedNfos]);

  // Get enriched data for the selected NFO tile
  const enrichedSelectedNfo = useMemo(() => {
    if (!selectedNfoForTile) return null;
    return enrichedNfos.find(n => n.username === selectedNfoForTile.username) ?? null;
  }, [selectedNfoForTile, enrichedNfos]);

  // Build connection lines: NFO to selected site
  const connectionLines = useMemo(() => {
    const lines: Array<{
      from: [number, number];
      to: [number, number];
      nfoUsername: string;
      siteId: string;
      lineColor: string;
    }> = [];

    for (const enriched of enrichedNfos) {
      if (!enriched.selectedSiteId) continue; // Skip if no selected site
      if (!hasValidLocation({ lat: enriched.lat, lng: enriched.lng }))
        continue;

      const targetSite = siteById.get(enriched.selectedSiteId);
      if (
        !targetSite ||
        !hasValidLocation({
          lat: targetSite.latitude,
          lng: targetSite.longitude,
        })
      ) {
        continue;
      }

      // Use bold yellow line for connections
      const lineColor = "#FFD700"; // gold/yellow

      lines.push({
        from: [enriched.lat as number, enriched.lng as number],
        to: [targetSite.latitude as number, targetSite.longitude as number],
        nfoUsername: enriched.username,
        siteId: enriched.selectedSiteId,
        lineColor,
      });
    }

    return lines;
  }, [enrichedNfos, siteById]);

  // If no points, still render a map centered on Western Region (Saudi)
  const center: [number, number] =
    nfosWithCoords.length > 0
      ? ([nfosWithCoords[0].lat as number, nfosWithCoords[0].lng as number])
      : [21.5, 39.2]; // somewhere between Jeddah/Makkah

  return (
    <div style={{ display: "flex", height: "100%", width: "100%", gap: "0" }}>
      {/* Left Side Panel: 35% */}
      <div
        style={{
          width: "35%",
          backgroundColor: "#f8f9fa",
          borderRight: "1px solid #ddd",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          padding: "12px",
        }}
      >
        {/* Site Search */}
        <div style={{ flex: "0 0 auto" }}>
          <h3 style={{ marginTop: 0, marginBottom: "8px", fontSize: "13px", fontWeight: "bold" }}>
            🔍 Search Site
          </h3>
          <SiteSearch sitesWithCoords={allSitesWithCoords} onSiteSelect={setSelectedSiteFromSearch} />
        </div>

        {/* Filter by (NFOs/Sites) - persisted via parent */}
        <div style={{ flex: "0 0 auto" }}>
          <h3 style={{ marginTop: 0, marginBottom: "8px", fontSize: "13px", fontWeight: "bold" }}>
            🗺️ Filter by
          </h3>
          <AreaFilter 
            sitesWithCoords={sites.filter((site) =>
              hasValidLocation({ lat: site.latitude, lng: site.longitude })
            )}
            selectedArea={mapAreaFilter}
            onAreaChange={onMapAreaFilterChange}
          />
        </div>

        {/* Interactive Legend - NFO filter persisted via parent */}
        <div style={{ flex: "0 0 auto" }}>
          <h3 style={{ marginTop: 0, marginBottom: "8px", fontSize: "13px", fontWeight: "bold" }}>
            📋 Legend
          </h3>
          <MapLegend
            sitesWithCoords={sitesWithCoords}
            nfosWithCoords={nfosWithCoords}
            warehouseCount={warehousesWithCoords.length}
            showWarehouses={showWarehouses}
            onToggleWarehouses={() => setShowWarehouses(!showWarehouses)}
            selectedNfoFilter={mapNfoFilter}
            onFilterChange={onMapNfoFilterChange}
          />
        </div>

        {/* NFO Search with Clear button */}
        <div style={{ flex: "0 0 auto" }}>
          <h3 style={{ marginTop: 0, marginBottom: "8px", fontSize: "13px", fontWeight: "bold" }}>
            👤 Search NFO
          </h3>
          <NfoSearch 
            nfosWithCoords={nfosWithCoords} 
            onNfoSelect={handleNfoSelectForTile}
            selectedNfoUsername={selectedNfoForTile?.username ?? null}
            onClear={handleClearNfoTile}
          />
        </div>

        {/* Closest NFOs Panel */}
        {selectedSiteFromSearch && closestNfosToSelectedSite.length > 0 && (
          <div
            style={{
              flex: "1 1 auto",
              backgroundColor: "white",
              borderRadius: "8px",
              border: "2px solid #3388ff",
              padding: "12px",
              minHeight: "200px",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
              <div style={{ fontWeight: "bold", fontSize: "13px" }}>
                Top 5 Closest NFOs
              </div>
              <button
                onClick={() => setSelectedSiteFromSearch(null)}
                style={{
                  background: "none",
                  border: "none",
                  fontSize: "16px",
                  cursor: "pointer",
                  color: "#999",
                  padding: "0",
                  width: "20px",
                  height: "20px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                title="Close"
              >
                ✕
              </button>
            </div>
            <div style={{ fontSize: "11px", color: "#666", marginBottom: "10px", fontWeight: "bold" }}>
              To: <span style={{ color: "#3388ff", fontWeight: "bold" }}>{selectedSiteFromSearch.site_id}</span>
            </div>
            <div style={{ flex: "1", overflowY: "auto", display: "flex", flexDirection: "column", gap: "8px" }}>
              {closestNfosToSelectedSite.map((item, idx) => {
                const hasValidCoords = hasValidLocation({ lat: item.nfo.lat, lng: item.nfo.lng });
                const isActiveRoute = activeRoute?.nfoUsername === item.nfo.username;
                const isLoading = routeLoading === item.nfo.username;
                // Use new assignment-based logic for status color
                const { isBusy, isFree } = computeAssignmentState(item.nfo);
                const statusColor = isFree ? "#22c55e" : isBusy ? "#ef4444" : "#666";
                const statusLabel = isFree ? "Free" : isBusy ? "Busy" : (item.nfo.status || "Off-Shift");
                
                return (
                <div
                  key={`closest-nfo-${item.nfo.username}`}
                  style={{
                    padding: "8px",
                    border: isActiveRoute ? "2px solid #22c55e" : "1px solid #e0e0e0",
                    borderRadius: "4px",
                    backgroundColor: isActiveRoute ? "#f0fff4" : "#fff",
                    borderLeft: isActiveRoute ? "3px solid #22c55e" : "3px solid #3388ff",
                  }}
                >
                  <div 
                    onClick={() => {
                      // Zoom to NFO on map click
                      const nfoLocation = { lat: item.nfo.lat, lng: item.nfo.lng };
                      if (hasValidLocation(nfoLocation)) {
                        const event = new CustomEvent("zoomToNfo", {
                          detail: { lat: item.nfo.lat, lng: item.nfo.lng, zoom: 12 },
                        });
                        window.dispatchEvent(event);
                      }
                    }}
                    style={{
                      cursor: "pointer",
                      transition: "all 0.2s",
                    }}
                  >
                    <div style={{ display: "flex", gap: "6px", alignItems: "flex-start", marginBottom: "4px" }}>
                      <span style={{ color: "#3388ff", fontWeight: "bold", fontSize: "12px", minWidth: "16px" }}>
                        {idx + 1}.
                      </span>
                      <div style={{ flex: 1 }}>
                        {/* Show full name if available, otherwise username */}
                        <div style={{ fontWeight: "bold", fontSize: "12px", color: "#333" }}>
                          {item.nfo.name || item.nfo.username}
                        </div>
                        {/* Second line: username · status · distance */}
                        <div style={{ fontSize: "10px", color: "#666", marginTop: "2px" }}>
                          <span>{item.nfo.username}</span>
                          <span style={{ margin: "0 4px" }}>·</span>
                          <span>Status: <span style={{ 
                            fontWeight: "500",
                            color: statusColor
                          }}>{statusLabel}</span></span>
                          <span style={{ margin: "0 4px" }}>·</span>
                          <span style={{ color: "#ff9800", fontWeight: "bold" }}>
                            ✈ {item.distance.toFixed(2)} km
                          </span>
                        </div>
                        {item.nfo.activity && (
                          <div style={{ fontSize: "10px", color: "#999", marginTop: "2px" }}>
                            Activity: {item.nfo.activity}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  
                  {/* Route button and route info */}
                  <div style={{ marginTop: "6px", paddingTop: "6px", borderTop: "1px solid #e0e0e0" }}>
                    {hasValidCoords && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          fetchRoute(item.nfo);
                        }}
                        disabled={isLoading}
                        style={{
                          padding: "4px 10px",
                          fontSize: "10px",
                          backgroundColor: isLoading ? "#ccc" : isActiveRoute ? "#22c55e" : "#3388ff",
                          color: "#fff",
                          border: "none",
                          borderRadius: "4px",
                          cursor: isLoading ? "not-allowed" : "pointer",
                          fontWeight: "bold",
                        }}
                      >
                        {isLoading ? "Calculating..." : isActiveRoute ? "✓ Route Shown" : "🚗 Route"}
                      </button>
                    )}
                    
                    {/* Show route error */}
                    {routeError && isActiveRoute && (
                      <div style={{ fontSize: "10px", color: "#ef4444", marginTop: "4px" }}>
                        {routeError}
                      </div>
                    )}
                    
                    {/* Show route info when active */}
                    {isActiveRoute && activeRoute && (
                      <div style={{ 
                        marginTop: "6px", 
                        padding: "6px", 
                        backgroundColor: "#e8f5e9", 
                        borderRadius: "4px",
                        fontSize: "10px"
                      }}>
                        <div style={{ fontWeight: "bold", color: "#2e7d32", marginBottom: "2px" }}>
                          🚗 Driving Route
                        </div>
                        <div style={{ color: "#333" }}>
                          <span style={{ fontWeight: "bold" }}>Distance:</span> {(activeRoute.distanceMeters / 1000).toFixed(2)} km
                        </div>
                        <div style={{ color: "#333" }}>
                          <span style={{ fontWeight: "bold" }}>ETA:</span> {Math.round(activeRoute.durationSeconds / 60)} min
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Selected NFO Tile Panel - shows when an NFO is selected via search or marker click */}
        {/* SAME FIELDS AS DASHBOARD ROW: Username, Name, On shift, Status, Ping Status, Activity, Site ID, Via warehouse, Warehouse, Nearest site, Air distance, Last active */}
        {selectedNfoForTile && enrichedSelectedNfo && (
          <div
            style={{
              flex: "0 0 auto",
              backgroundColor: "white",
              borderRadius: "8px",
              border: "2px solid #22c55e",
              padding: "12px",
              marginTop: "auto",
            }}
          >
            {/* Header with NFO name and close button */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
              <div style={{ fontWeight: "bold", fontSize: "14px", color: "#22c55e" }}>
                👤 {enrichedSelectedNfo.name || enrichedSelectedNfo.username}
              </div>
              <button
                onClick={handleClearNfoTile}
                style={{
                  background: "none",
                  border: "none",
                  fontSize: "16px",
                  cursor: "pointer",
                  color: "#999",
                  padding: "0",
                  width: "20px",
                  height: "20px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                title="Clear selection"
              >
                ✕
              </button>
            </div>

            {/* NFO Details Grid - SAME FIELDS AS DASHBOARD */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px", fontSize: "11px", marginBottom: "10px" }}>
              <div>
                <span style={{ color: "#666" }}>Username:</span>{" "}
                <span style={{ fontFamily: "monospace", fontWeight: "bold" }}>{enrichedSelectedNfo.username}</span>
              </div>
              <div>
                <span style={{ color: "#666" }}>On shift:</span>{" "}
                <span style={{ fontWeight: "bold", color: enrichedSelectedNfo.on_shift ? "#22c55e" : "#666" }}>
                  {enrichedSelectedNfo.on_shift ? "Yes" : "No"}
                </span>
              </div>
              <div>
                <span style={{ color: "#666" }}>Status:</span>{" "}
                <span style={{ 
                  fontWeight: "bold", 
                  color: enrichedSelectedNfo.isBusy ? "#ef4444" : 
                         enrichedSelectedNfo.isFree ? "#22c55e" : "#666"
                }}>
                  {enrichedSelectedNfo.status || "-"}
                </span>
              </div>
              <div>
                <span style={{ color: "#666" }}>Ping Status:</span>{" "}
                {enrichedSelectedNfo.isNotActive ? (
                  <span style={{ color: "#ef4444", fontWeight: "bold" }}>
                    Not Active
                    <span style={{ fontWeight: "normal", color: "#999", marginLeft: "4px", fontSize: "10px" }}>
                      ({enrichedSelectedNfo.pingReason})
                    </span>
                  </span>
                ) : (
                  <span style={{ color: "#22c55e", fontWeight: "bold" }}>OK</span>
                )}
              </div>
              <div>
                <span style={{ color: "#666" }}>Activity:</span>{" "}
                <span>{enrichedSelectedNfo.activity || "-"}</span>
              </div>
              <div>
                <span style={{ color: "#666" }}>Site ID:</span>{" "}
                <span style={{ fontFamily: "monospace" }}>{enrichedSelectedNfo.site_id?.trim() || "-"}</span>
              </div>
              <div>
                <span style={{ color: "#666" }}>Via warehouse:</span>{" "}
                <span style={{ fontWeight: enrichedSelectedNfo.via_warehouse ? "bold" : "normal" }}>
                  {enrichedSelectedNfo.via_warehouse ? "Yes" : "-"}
                </span>
              </div>
              <div>
                <span style={{ color: "#666" }}>Warehouse:</span>{" "}
                <span>{enrichedSelectedNfo.warehouse_name || "-"}</span>
              </div>
              <div>
                <span style={{ color: "#666" }}>Nearest site:</span>{" "}
                <span style={{ fontFamily: "monospace" }}>{enrichedSelectedNfo.nearestSiteId || "-"}</span>
              </div>
              <div>
                <span style={{ color: "#666" }}>Air distance:</span>{" "}
                <span style={{ color: "#ff9800", fontWeight: "bold" }}>
                  {enrichedSelectedNfo.airDistanceKm != null 
                    ? `${enrichedSelectedNfo.airDistanceKm.toFixed(2)} km` 
                    : "-"}
                </span>
              </div>
              <div style={{ gridColumn: "1 / -1" }}>
                <span style={{ color: "#666" }}>Last active:</span>{" "}
                <span style={{ fontSize: "10px" }}>
                  {enrichedSelectedNfo.last_active_at
                    ? new Date(enrichedSelectedNfo.last_active_at).toLocaleString()
                    : "-"}
                </span>
              </div>
            </div>

            {/* Route Section */}
            <div style={{ borderTop: "1px solid #e0e0e0", paddingTop: "10px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <button
                  onClick={fetchRouteForNfoTile}
                  disabled={nfoTileRouteLoading}
                  style={{
                    padding: "6px 16px",
                    fontSize: "12px",
                    backgroundColor: nfoTileRouteLoading ? "#ccc" : nfoTileRoute ? "#22c55e" : "#3388ff",
                    color: "#fff",
                    border: "none",
                    borderRadius: "4px",
                    cursor: nfoTileRouteLoading ? "not-allowed" : "pointer",
                    fontWeight: "bold",
                  }}
                >
                  {nfoTileRouteLoading ? "Calculating..." : nfoTileRoute ? "✓ Route Calculated" : "🚗 Calculate Route"}
                </button>

                {nfoTileRoute && (
                  <button
                    onClick={() => { setNfoTileRoute(null); setNfoTileRouteError(null); }}
                    style={{
                      padding: "6px 12px",
                      fontSize: "12px",
                      backgroundColor: "#f3f4f6",
                      color: "#666",
                      border: "1px solid #ddd",
                      borderRadius: "4px",
                      cursor: "pointer",
                    }}
                  >
                    Clear Route
                  </button>
                )}
              </div>

              {/* Route Error */}
              {nfoTileRouteError && (
                <div style={{ marginTop: "8px", color: "#ef4444", fontSize: "11px" }}>
                  ⚠️ {nfoTileRouteError}
                </div>
              )}

              {/* Route Result - SAME FORMAT AS DASHBOARD: "107.41 km, 77 min via Jeddah MC" */}
              {nfoTileRoute && (
                <div style={{ 
                  marginTop: "8px", 
                  padding: "8px", 
                  backgroundColor: nfoTileRoute.isFallback ? "#fff7ed" : "#e8f5e9", 
                  borderRadius: "4px",
                  fontSize: "11px"
                }}>
                  <div style={{ fontWeight: "bold", color: nfoTileRoute.isFallback ? "#d97706" : "#2e7d32" }}>
                    {formatRouteSummary(nfoTileRoute)}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Right Side Map: 65% */}
      <div style={{ flex: "1", position: "relative" }}>
        <MapContainer
          center={center}
          zoom={7}
          style={{ height: "100%", width: "100%" }}
          scrollWheelZoom={true}
        >
      <TileLayer
        attribution="&copy; OpenStreetMap contributors"
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      {/* Fix Leaflet map size when tab becomes active or window resizes */}
      <MapSizeFixer active={isActive} />

      {/* Map Center Control - handles zoom to NFO clicks */}
      <MapCenterControl />

      {/* Bold yellow connection lines from NFOs to selected/nearest sites */}
      {connectionLines.map((line, idx) => (
        <Polyline
          key={`conn-${line.nfoUsername}-${line.siteId}-${idx}`}
          positions={[line.from, line.to]}
          color={line.lineColor}
          weight={3}
          opacity={0.8}
        />
      ))}

      {/* Driving route polyline from ORS (green, thicker) */}
      {activeRoute && activeRoute.coordinates.length > 0 && (
        <Polyline
          key={`ors-route-${activeRoute.nfoUsername}`}
          positions={activeRoute.coordinates.map(([lng, lat]) => [lat, lng] as [number, number])}
          color="#22c55e"
          weight={5}
          opacity={0.9}
        />
      )}

      {/* NFO Tile route polyline (purple, for selected NFO in detail tile) */}
      {nfoTileRoute && nfoTileRoute.coordinates.length > 0 && (
        <Polyline
          key={`nfo-tile-route-${selectedNfoForTile?.username ?? 'selected'}`}
          positions={nfoTileRoute.coordinates.map(([lng, lat]) => [lat, lng] as [number, number])}
          color={nfoTileRoute.isFallback ? "#f59e0b" : "#8b5cf6"}
          weight={5}
          opacity={0.9}
          dashArray={nfoTileRoute.isFallback ? "10,10" : undefined}
        />
      )}

      {/* NFO markers with status-based colors */}
      {filteredEnrichedNfos.map((enriched, nfoIdx) => {
        const minutesSinceActive = ageMinutes(enriched.last_active_at);
        const icon = getNfoIcon(enriched);
        const isSelectedNfo = selectedNfoUsername === enriched.username;
        // Use assignment-based logic for popup labels
        const { isBusy, isFree, isOnShift, isOffShift } = computeAssignmentState(enriched);
        
        // Derive display labels
        const shiftLabel = isOnShift ? "On-shift" : isOffShift ? "Off-shift" : "Unknown";
        const assignmentLabel = isBusy ? "Busy" : isFree ? "Free" : "Other";

        return (
          <Marker
            key={`nfo-${enriched.username}-${nfoIdx}`}
            position={[enriched.lat as number, enriched.lng as number]}
            icon={icon}
            ref={(markerRef) => {
              // Auto-open popup when this NFO is selected from search
              if (markerRef && isSelectedNfo) {
                setTimeout(() => {
                  markerRef.openPopup();
                }, 300);
              }
            }}
            eventHandlers={{
              click: () => {
                // Also set NFO for the detail tile at bottom
                setSelectedNfoForTile(enriched);
                setNfoTileRoute(null);
                setNfoTileRouteError(null);
              }
            }}
          >
            <Popup>
              <div className="text-xs space-y-1" style={{ minWidth: "200px" }}>
                {/* SECTION 1: Name + Username + On-shift + Ping Status */}
                <div className="font-semibold text-sm">
                  {enriched.username}
                  {enriched.name && <span className="font-normal"> – {enriched.name}</span>}
                </div>
                <div className="flex gap-4">
                  <div>
                    <span className="text-gray-500">On shift:</span>{" "}
                    <span className={enriched.isOnShift ? "text-green-600 font-semibold" : "text-gray-600"}>
                      {enriched.on_shift ? "Yes" : "No"}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-500">Ping:</span>{" "}
                    {enriched.isNotActive ? (
                      <span className="text-red-600 font-semibold">Not Active</span>
                    ) : (
                      <span className="text-green-600 font-semibold">OK</span>
                    )}
                  </div>
                </div>

                {/* SECTION 2: Status + Activity */}
                <div className="border-t pt-1 mt-1">
                  <div>
                    <span className="text-gray-500">Status:</span>{" "}
                    <span className={enriched.isBusy ? "text-red-600 font-semibold" : enriched.isFree ? "text-green-600 font-semibold" : ""}>
                      {enriched.status ?? "-"}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-500">Activity:</span>{" "}
                    <span>{enriched.activity ?? "-"}</span>
                  </div>
                </div>

                {/* SECTION 3: Site info - Site ID, Via warehouse, Warehouse, Nearest site, Air distance */}
                <div className="border-t pt-1 mt-1">
                  <div>
                    <span className="text-gray-500">Site ID:</span>{" "}
                    <span className="font-mono">{enriched.site_id?.trim() || "-"}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">Via warehouse:</span>{" "}
                    <span className={enriched.via_warehouse ? "text-orange-600 font-semibold" : ""}>
                      {enriched.via_warehouse ? "Yes" : "-"}
                    </span>
                  </div>
                  {enriched.warehouse_name && (
                    <div>
                      <span className="text-gray-500">Warehouse:</span>{" "}
                      <span className="text-orange-600">{enriched.warehouse_name}</span>
                    </div>
                  )}
                  <div>
                    <span className="text-gray-500">Nearest site:</span>{" "}
                    <span className="font-mono">{enriched.nearestSiteId ?? "-"}</span>
                  </div>
                  <div>
                    <span className="text-gray-500">Air distance:</span>{" "}
                    <span className="text-amber-600 font-semibold">
                      {enriched.airDistanceKm != null ? `${enriched.airDistanceKm.toFixed(2)} km` : "-"}
                    </span>
                  </div>
                </div>

                {/* SECTION 4: Last active + Home area */}
                <div className="border-t pt-1 mt-1 text-gray-500">
                  <div>
                    Last active:{" "}
                    {enriched.last_active_at
                      ? new Date(enriched.last_active_at).toLocaleString()
                      : "-"}
                    {minutesSinceActive !== null && (
                      <span className="text-gray-400"> ({Math.round(minutesSinceActive)} min ago)</span>
                    )}
                  </div>
                  {enriched.home_location && (
                    <div>Home area: {enriched.home_location}</div>
                  )}
                </div>
              </div>
            </Popup>
          </Marker>
        );
      })}

      {/* Site markers with labels - only shown when not NFOs_ONLY */}
      {sitesWithCoords.map((site, siteIdx) => {
        const isSelected = selectedSiteFromSearch?.site_id === site.site_id;
        return (
        <div key={`site-marker-${site.site_id}-${siteIdx}`}>
          <Marker
            position={[site.latitude as number, site.longitude as number]}
            icon={siteIcon}
            zIndexOffset={isSelected ? 1000 : 0}
            eventHandlers={{
              click: () => setSelectedSiteFromSearch(site),
            }}
          >
            <Popup>
              <div className="text-xs space-y-1">
                <div>
                  <strong>Site: {site.site_id}</strong>
                </div>
                {site.name && <div>Name: {site.name}</div>}
                {site.area && <div>Area: {site.area}</div>}
                <div>
                  Coords: {site.latitude?.toFixed(4)}, {site.longitude?.toFixed(4)}
                </div>
              </div>
            </Popup>
          </Marker>
          {/* Site ID label - highlighted if selected */}
          <Marker
            position={[site.latitude as number, site.longitude as number]}
            icon={L.divIcon({
              className: "site-label",
              html: `<div style="background: ${isSelected ? '#ff6600' : 'white'}; border: 1px solid ${isSelected ? '#cc5200' : '#2563eb'}; border-radius: 3px; padding: 1px 4px; font-size: ${isSelected ? '11px' : '9px'}; font-weight: ${isSelected ? '700' : '600'}; color: ${isSelected ? 'white' : '#1e40af'}; white-space: nowrap; box-shadow: ${isSelected ? '0 2px 8px rgba(255,102,0,0.5)' : '0 1px 2px rgba(0,0,0,0.15)'}; ${isSelected ? 'animation: pulse-label 0.5s ease-in-out infinite;' : ''}">${site.site_id}</div>`,
              iconSize: [60, 18],
              iconAnchor: [30, 52],
            })}
            zIndexOffset={isSelected ? 1001 : 1}
            eventHandlers={{
              click: () => setSelectedSiteFromSearch(site),
            }}
          />
        </div>
      );
      })}

      {/* Warehouse markers - orange, toggleable via legend */}
      {showWarehouses && warehousesWithCoords.map((wh, whIdx) => (
        <Marker
          key={`warehouse-${wh.id}-${whIdx}`}
          position={[wh.latitude as number, wh.longitude as number]}
          icon={warehouseIcon}
          zIndexOffset={500}
        >
          <Popup>
            <div className="text-xs space-y-1" style={{ minWidth: "150px" }}>
              <div className="font-semibold text-orange-600">
                🏭 {wh.name}
              </div>
              {wh.region && (
                <div>
                  <span className="text-gray-500">Region:</span> {wh.region}
                </div>
              )}
              <div className="text-gray-500">
                Coords: {wh.latitude?.toFixed(4)}, {wh.longitude?.toFixed(4)}
              </div>
            </div>
          </Popup>
        </Marker>
      ))}

      {/* Pulsing highlight circle for selected site */}
      {showHighlight && selectedSiteFromSearch && hasValidLocation({ lat: selectedSiteFromSearch.latitude, lng: selectedSiteFromSearch.longitude }) && (
        <Circle
          center={[selectedSiteFromSearch.latitude as number, selectedSiteFromSearch.longitude as number]}
          radius={highlightRadius}
          pathOptions={{
            color: '#ff6600',
            fillColor: '#ff6600',
            fillOpacity: 0.3,
            weight: 3,
            opacity: 0.8,
          }}
        />
      )}
        </MapContainer>
      </div>
    </div>
  );
}
