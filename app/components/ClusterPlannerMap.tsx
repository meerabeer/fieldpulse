"use client";

import { useMemo } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";

// Types
interface SiteWithOwner {
  site_id: string;
  site_name: string | null;
  latitude: number | null;
  longitude: number | null;
  area: string | null;
  cluster_owner: string | null;
}

interface ClusterPlannerMapProps {
  sites: SiteWithOwner[];
  selectedOwner: string | null;
  ownerColors: Map<string, string>;
  onSiteClick?: (site: SiteWithOwner) => void;
}

// Create a custom colored pin marker using SVG with site ID text
function createColoredPinIcon(color: string, siteId: string): L.DivIcon {
  // Calculate text width for dynamic background sizing
  const textLength = siteId.length;
  const rectWidth = Math.max(14, textLength * 5.5);
  const rectX = 12 - rectWidth / 2;

  // SVG marker pin with dynamic fill color and prominent white label for site ID
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 36" width="28" height="42">
      <defs>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="1" dy="2" stdDeviation="1.5" flood-opacity="0.3"/>
        </filter>
      </defs>
      <path fill="${color}" stroke="#ffffff" stroke-width="1.5" filter="url(#shadow)"
        d="M12 0C5.4 0 0 5.4 0 12c0 7.2 10.8 22.4 11.4 23.2.3.4.9.4 1.2 0C13.2 34.4 24 19.2 24 12c0-6.6-5.4-12-12-12z"/>
      <rect x="${rectX}" y="7" width="${rectWidth}" height="10" rx="2" ry="2" fill="#ffffff" opacity="0.95"/>
      <text x="12" y="14.5" text-anchor="middle" font-size="7.5" font-weight="bold" fill="#333333" font-family="Arial, sans-serif">${siteId}</text>
    </svg>
  `;

  return L.divIcon({
    html: svg,
    className: "custom-pin-marker",
    iconSize: [28, 42],
    iconAnchor: [14, 42],
    popupAnchor: [0, -42],
  });
}

// Map auto-fit component - adjusts map bounds to show all markers
function MapAutoFit({ sites }: { sites: SiteWithOwner[] }) {
  const map = useMap();

  useMemo(() => {
    const validSites = sites.filter(
      (s) => s.latitude != null && s.longitude != null &&
        Number.isFinite(s.latitude) && Number.isFinite(s.longitude)
    );

    if (validSites.length === 0) return;

    if (validSites.length === 1) {
      map.setView([validSites[0].latitude!, validSites[0].longitude!], 12);
    } else {
      const bounds = L.latLngBounds(
        validSites.map((s) => [s.latitude!, s.longitude!] as [number, number])
      );
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 14 });
    }
  }, [sites, map]);

  return null;
}

export default function ClusterPlannerMap({
  sites,
  selectedOwner,
  ownerColors,
  onSiteClick,
}: ClusterPlannerMapProps) {
  // Filter sites by selected owner if set
  const displaySites = useMemo(() => {
    if (!selectedOwner) return sites;
    return sites.filter((s) => {
      const owner = s.cluster_owner || "Unassigned";
      return owner === selectedOwner;
    });
  }, [sites, selectedOwner]);

  // Filter to only sites with valid coordinates
  const sitesWithCoords = useMemo(() => {
    return displaySites.filter(
      (s) =>
        s.latitude != null &&
        s.longitude != null &&
        Number.isFinite(s.latitude) &&
        Number.isFinite(s.longitude)
    );
  }, [displaySites]);

  // Create icon cache per site for performance (each site has unique ID)
  const iconCache = useMemo(() => {
    const cache = new Map<string, L.DivIcon>();
    // Pre-create icons for all sites with coordinates
    sitesWithCoords.forEach((site) => {
      const owner = site.cluster_owner || "Unassigned";
      const color = ownerColors.get(owner) || "hsl(0, 0%, 50%)";
      cache.set(site.site_id, createColoredPinIcon(color, site.site_id));
    });
    return cache;
  }, [sitesWithCoords, ownerColors]);

  // Get icon for a site based on its ID
  const getIconForSite = (site: SiteWithOwner): L.DivIcon => {
    const cachedIcon = iconCache.get(site.site_id);
    if (cachedIcon) return cachedIcon;

    // Fallback: create new icon with the color and site ID
    const owner = site.cluster_owner || "Unassigned";
    const color = ownerColors.get(owner) || "hsl(0, 0%, 50%)";
    return createColoredPinIcon(color, site.site_id);
  };

  // Default center: Saudi Arabia
  const defaultCenter: [number, number] = [24.7136, 46.6753];
  const defaultZoom = 6;

  return (
    <div className="h-[500px] w-full rounded-lg overflow-hidden border border-slate-200">
      {/* Custom styles for the marker */}
      <style>{`
        .custom-pin-marker {
          background: transparent !important;
          border: none !important;
        }
      `}</style>

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

        {/* Auto-fit to markers when sites change */}
        {sitesWithCoords.length > 0 && <MapAutoFit sites={sitesWithCoords} />}

        {/* Site markers using custom colored pin icons */}
        {sitesWithCoords.map((site) => {
          const icon = getIconForSite(site);
          const color = ownerColors.get(site.cluster_owner || "Unassigned") || "hsl(0, 0%, 50%)";

          return (
            <Marker
              key={site.site_id}
              position={[site.latitude!, site.longitude!]}
              icon={icon}
              eventHandlers={{
                click: () => onSiteClick?.(site),
              }}
            >
              <Popup>
                <div className="text-sm space-y-1 min-w-[180px]">
                  <div className="font-semibold text-base">{site.site_id}</div>
                  {site.site_name && (
                    <div className="text-slate-600">{site.site_name}</div>
                  )}
                  {site.area && (
                    <div>
                      <span className="text-slate-500">Area:</span> {site.area}
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <span className="text-slate-500">Cluster Owner:</span>
                    <span
                      className="inline-block w-3 h-3 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    <span className="font-medium">
                      {site.cluster_owner || "Unassigned"}
                    </span>
                  </div>
                  <div className="text-xs text-slate-400 pt-1 border-t border-slate-100">
                    {site.latitude?.toFixed(6)}, {site.longitude?.toFixed(6)}
                  </div>
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>
    </div>
  );
}
