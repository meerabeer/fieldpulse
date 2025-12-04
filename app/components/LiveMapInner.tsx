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
} from "../lib/nfoHelpers";

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
 */
function NfoSearch({ nfosWithCoords }: { nfosWithCoords: NfoStatusRow[] }) {
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
      // Zoom to NFO and open popup
      if (hasValidLocation({ lat: nfo.lat, lng: nfo.lng })) {
        window.dispatchEvent(
          new CustomEvent("zoomToNfo", {
            detail: { lat: nfo.lat, lng: nfo.lng, zoom: 16, username: nfo.username },
          })
        );
      }
    },
    []
  );

  return (
    <div className="relative text-xs">
      <input
        type="text"
        placeholder="Search by NFO name or username..."
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
        className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs focus:outline-none focus:border-blue-500"
      />

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
  selectedNfoFilter,
  onFilterChange,
}: {
  sitesWithCoords: SiteRecord[];
  nfosWithCoords: NfoStatusRow[];
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

export default function LiveMapInner({ 
  nfos, 
  sites,
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
  
  // ORS Route state (ephemeral - route clears on tab switch, which is expected)
  const [activeRoute, setActiveRoute] = useState<RouteInfo | null>(null);
  const [routeLoading, setRouteLoading] = useState<string | null>(null); // username of NFO being loaded
  const [routeError, setRouteError] = useState<string | null>(null);

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
  // This uses the same logic as the Dashboard to ensure consistency
  // MUST be defined BEFORE closestNfosToSelectedSite
  const enrichedNfos = useMemo(() => {
    return nfosWithCoords.map((nfo) => {
      let selectedSiteId: string | null = null;
      let selectedSiteName: string | null = null;
      let selectedSiteArea: string | null = null;
      let selectedSiteDistanceKm: number | null = null;

      // Use new assignment-based busy logic
      const { isBusy } = computeAssignmentState(nfo);

      // 1a. If NFO is busy and has an assigned site with valid coords, use that
      if (
        isBusy &&
        nfo.site_id &&
        hasValidLocation({ lat: nfo.lat, lng: nfo.lng })
      ) {
        // Look up site from ALL sites (not just those with coords), as site may exist but have no coords
        const activeSite = getSiteById(sites, nfo.site_id);
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
          // Site exists but doesn't have valid coords - still show site info without distance
          selectedSiteId = activeSite.site_id;
          selectedSiteName = activeSite.name ?? null;
          selectedSiteArea = activeSite.area ?? null;
          selectedSiteDistanceKm = null;
        }
      } else {
        // 1b. Otherwise, find nearest site
        const nearest = findNearestSite(
          { lat: nfo.lat, lng: nfo.lng },
          sites
        );

        if (nearest) {
          const siteRec = nearest.site as SiteRecord;
          selectedSiteId = siteRec.site_id;
          selectedSiteName = siteRec.name ?? null;
          selectedSiteArea = siteRec.area ?? null;
          selectedSiteDistanceKm = nearest.distanceKm;
        }
      }

      if (nfo.username === "ZAMEBIR") {
        console.log("[LiveMap DISTANCE DEBUG]", {
          username: nfo.username,
          status: nfo.status,
          site_id: nfo.site_id,
          nfoLat: nfo.lat,
          nfoLng: nfo.lng,
          selectedSiteId,
          selectedSiteDistanceKm,
        });
      }

      return {
        ...nfo,
        selectedSiteId,
        selectedSiteName,
        selectedSiteArea,
        selectedSiteDistanceKm,
      };
    });
  }, [nfosWithCoords, sites]);

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
      const params = new URLSearchParams({
        start_lon: String(startLng),
        start_lat: String(startLat),
        end_lon: String(endLng),
        end_lat: String(endLat),
        profile: "driving-car",
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
            selectedNfoFilter={mapNfoFilter}
            onFilterChange={onMapNfoFilterChange}
          />
        </div>

        {/* NFO Search */}
        <div style={{ flex: "0 0 auto" }}>
          <h3 style={{ marginTop: 0, marginBottom: "8px", fontSize: "13px", fontWeight: "bold" }}>
            👤 Search NFO
          </h3>
          <NfoSearch nfosWithCoords={nfosWithCoords} />
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
          >
            <Popup>
              <div className="text-xs space-y-1">
                {/* NFO name + username */}
                <div>
                  <strong>{enriched.username}</strong>
                  {enriched.name && ` – ${enriched.name}`}
                </div>

                {/* Shift and Assignment status (new clear labels) */}
                <div className={isOnShift ? "text-blue-600 font-semibold" : isOffShift ? "text-orange-600 font-semibold" : ""}>
                  <strong>Shift:</strong> {shiftLabel}
                </div>
                <div className={isBusy ? "text-red-600 font-semibold" : isFree ? "text-green-600 font-semibold" : ""}>
                  <strong>Assignment:</strong> {assignmentLabel}
                </div>
                
                {/* Raw status and activity for reference */}
                <div className="text-gray-500">Status: {enriched.status ?? "-"}</div>
                <div className="text-gray-500">Activity: {enriched.activity ?? "-"}</div>
                
                {minutesSinceActive !== null && (
                  <div>
                    Last active: {Math.round(minutesSinceActive)} min ago
                  </div>
                )}

                {/* Site and distance info */}
                {enriched.selectedSiteId ? (
                  <div className="font-semibold text-blue-600 border-t pt-1 mt-1">
                    <div>
                      {isBusy ? "📍 Selected site:" : "🧭 Nearest site:"}
                    </div>
                    <div>
                      {enriched.selectedSiteId}
                      {enriched.selectedSiteName && ` – ${enriched.selectedSiteName}`}
                      {enriched.selectedSiteArea && ` (${enriched.selectedSiteArea})`}
                    </div>
                    {enriched.selectedSiteDistanceKm !== null && (
                      <div>
                        Air distance:{" "}
                        {enriched.selectedSiteDistanceKm.toFixed(1)} km
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-gray-500 border-t pt-1 mt-1">
                    Nearest site: –
                  </div>
                )}

                <div className="text-gray-500 text-xs border-t pt-1 mt-1">
                  Last updated:{" "}
                  {enriched.last_active_at
                    ? new Date(enriched.last_active_at).toLocaleString()
                    : "-"}
                </div>
                {enriched.home_location && (
                  <div>Home area: {enriched.home_location}</div>
                )}
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
