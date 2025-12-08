"use client";

import { useEffect, useMemo, useState } from "react";
import { MapContainer, Marker, Polyline, Popup, TileLayer } from "react-leaflet";
import L from "leaflet";
import { supabase } from "../../lib/supabaseClient";
import { parseCoords } from "../lib/geoHelpers";
import { type NfoStatusRow, computeAssignmentState } from "../lib/nfoHelpers";

type SiteCoordinate = {
  site_id: string;
  latitude: any; // can be string or number from Supabase
  longitude: any; // can be string or number from Supabase
};

type NfoRoutesViewProps = {
  nfos: NfoStatusRow[];
};

// Create icon lazily only on client side to avoid SSR issues
const createDefaultIcon = () =>
  L.icon({
    iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
    iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
    shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
    iconSize: [25, 41],
    iconAnchor: [12, 41],
  });

const ORS_BACKEND_URL =
  process.env.NEXT_PUBLIC_ORS_BACKEND_URL ??
  "https://meerabeer1990-nfo-ors-backend.hf.space";

export default function NfoRoutesViewInner({ nfos }: NfoRoutesViewProps) {
  // Client-only guard to prevent Leaflet initialization before DOM is ready
  // This prevents "Cannot read properties of undefined (reading 'appendChild')" errors
  const [isClient, setIsClient] = useState(false);
  useEffect(() => {
    setIsClient(true);
  }, []);

  // Create icon only on client side
  const defaultIcon = useMemo(() => {
    if (!isClient) return null;
    return createDefaultIcon();
  }, [isClient]);

  const [sites, setSites] = useState<SiteCoordinate[]>([]);
  const [selectedUsername, setSelectedUsername] = useState<string>("");
  const [selectedSiteId, setSelectedSiteId] = useState<string>("");
  const [routeCoords, setRouteCoords] = useState<[number, number][]>([]);
  const [loadingRoute, setLoadingRoute] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load sites from Supabase
  useEffect(() => {
    const loadSites = async () => {
      const { data, error } = await supabase
        .from("Site_Coordinates")
        .select("site_id, site_name, latitude, longitude, area");

      if (error) {
        console.error("Error loading sites:", error);
      } else {
        setSites(
          (data ?? []).map((row: any) => ({
            site_id: row.site_id,
            latitude: row.latitude,
            longitude: row.longitude,
          }))
        );
      }
    };

    loadSites();
  }, []);

  // Auto-select first NFO with coordinates
  useEffect(() => {
    const nfoWithCoords = nfos.find((n) => n.lat !== null && n.lng !== null);
    if (nfoWithCoords && !selectedUsername) {
      setSelectedUsername(nfoWithCoords.username);
    }
  }, [nfos, selectedUsername]);

  // Auto-link to current site if NFO is busy
  useEffect(() => {
    if (!selectedUsername) return;

    const nfo = nfos.find((n) => n.username === selectedUsername);
    // Use new assignment-based busy logic
    const { isBusy } = nfo ? computeAssignmentState(nfo) : { isBusy: false };
    if (nfo && isBusy && nfo.site_id && !selectedSiteId) {
      setSelectedSiteId(nfo.site_id);
    }
  }, [selectedUsername, nfos, selectedSiteId]);

  // Fetch route from ORS backend
  useEffect(() => {
    const fetchRoute = async () => {
      if (!selectedUsername || !selectedSiteId) return;

      const nfo = nfos.find((n) => n.username === selectedUsername);
      const site = sites.find((s) => s.site_id === selectedSiteId);

      if (!nfo || !site || nfo.lat === null || nfo.lng === null) {
        setRouteCoords([]);
        return;
      }

      // Parse site coordinates (they may be strings from Supabase)
      const siteCoords = parseCoords(site.latitude, site.longitude);
      if (!siteCoords) {
        setError("Invalid site coordinates");
        setRouteCoords([]);
        return;
      }

      setLoadingRoute(true);
      setError(null);

      try {
        const params = new URLSearchParams({
          start_lon: String(nfo.lng),
          start_lat: String(nfo.lat),
          end_lon: String(siteCoords.lon),
          end_lat: String(siteCoords.lat),
          profile: "driving-car",
        });

        const res = await fetch(`${ORS_BACKEND_URL}/route?${params}`, {
          headers: {
            "Content-Type": "application/json",
          },
        });

        if (!res.ok) {
          throw new Error(`Route request failed: ${res.statusText}`);
        }

        const data = await res.json();

        if (data.features && data.features.length > 0) {
          const coords = data.features[0].geometry.coordinates.map(
            ([lng, lat]: [number, number]) => [lat, lng] as [number, number]
          );
          setRouteCoords(coords);
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Unknown error fetching route"
        );
      } finally {
        setLoadingRoute(false);
      }
    };

    fetchRoute();
  }, [selectedUsername, selectedSiteId, nfos, sites]);

  // Memoize NFO-site pair
  const selectedNfo = useMemo(
    () => nfos.find((n) => n.username === selectedUsername),
    [selectedUsername, nfos]
  );

  const selectedSite = useMemo(
    () => sites.find((s) => s.site_id === selectedSiteId),
    [selectedSiteId, sites]
  );

  // Parse selected site coordinates safely
  const selectedSiteCoords = useMemo(() => {
    if (!selectedSite) return null;
    return parseCoords(selectedSite.latitude, selectedSite.longitude);
  }, [selectedSite]);

  // Map bounds calculation
  const mapCenter: [number, number] = useMemo(() => {
    if (!selectedNfo || selectedNfo.lat === null || selectedNfo.lng === null) {
      return [21.5, 39.2];
    }
    return [selectedNfo.lat, selectedNfo.lng];
  }, [selectedNfo]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-white rounded-lg shadow p-4">
        <h2 className="text-lg font-bold mb-4 text-slate-900">
          NFO Route Planning
        </h2>

        <div className="grid grid-cols-2 gap-4 mb-4">
          {/* NFO Selection */}
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-2">
              Select NFO:
            </label>
            <select
              value={selectedUsername}
              onChange={(e) => setSelectedUsername(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Choose NFO...</option>
              {nfos
                .filter((n) => n.lat !== null && n.lng !== null)
                .map((n) => (
                  <option key={n.username} value={n.username}>
                    {n.name} ({n.username})
                  </option>
                ))}
            </select>
          </div>

          {/* Site Selection */}
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-2">
              Select Destination Site:
            </label>
            <select
              value={selectedSiteId}
              onChange={(e) => setSelectedSiteId(e.target.value)}
              className="w-full px-3 py-2 border border-slate-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Choose site...</option>
              {/* Deduplicate sites by site_id to avoid duplicate option keys */}
              {Array.from(new Map(sites.map((s) => [s.site_id, s])).values()).map((s) => (
                <option key={s.site_id} value={s.site_id}>
                  {s.site_id}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Info & Error */}
        {selectedNfo && selectedSite && selectedSiteCoords && (
          <div className="mb-4 p-3 bg-slate-50 rounded border border-slate-200 text-xs text-slate-700 space-y-1">
            <div>
              <strong>From:</strong> {selectedNfo.name} ({selectedNfo.username})
              at ({selectedNfo.lat?.toFixed(4)}, {selectedNfo.lng?.toFixed(4)})
            </div>
            <div>
              <strong>To:</strong> Site {selectedSite.site_id} at (
              {selectedSiteCoords.lat.toFixed(4)}, {selectedSiteCoords.lon.toFixed(4)})
            </div>
            {loadingRoute && (
              <div className="text-blue-600 font-medium">
                Fetching route...
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700">
            {error}
          </div>
        )}
      </div>

      {/* Map - only render when client is ready to prevent Leaflet init errors */}
      <div className="rounded-lg overflow-hidden border border-slate-200 shadow">
        {isClient && defaultIcon ? (
          <MapContainer
            center={mapCenter}
            zoom={8}
            style={{ height: "600px", width: "100%" }}
          >
            <TileLayer
              attribution="&copy; OpenStreetMap contributors"
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />

            {/* NFO marker */}
            {selectedNfo && selectedNfo.lat !== null && selectedNfo.lng !== null && (
              <Marker position={[selectedNfo.lat, selectedNfo.lng]} icon={defaultIcon}>
                <Popup>
                  <div className="text-xs">
                    <strong>{selectedNfo.username}</strong>
                    <br />
                    {selectedNfo.name}
                    <br />
                    Status: {selectedNfo.status ?? "-"}
                  </div>
                </Popup>
              </Marker>
            )}

            {/* Site marker */}
            {selectedSite && selectedSiteCoords && (
              <Marker position={[selectedSiteCoords.lat, selectedSiteCoords.lon]}>
                <Popup>
                  <div className="text-xs">
                    <strong>Site: {selectedSite.site_id}</strong>
                  </div>
                </Popup>
              </Marker>
            )}

            {/* Route polyline */}
            {routeCoords.length > 0 && (
              <Polyline positions={routeCoords} color="blue" weight={2} />
            )}
          </MapContainer>
        ) : (
          <div 
            className="bg-slate-100 flex items-center justify-center"
            style={{ height: "600px", width: "100%" }}
          >
            <p className="text-slate-500">Loading map...</p>
          </div>
        )}
      </div>
    </div>
  );
}
