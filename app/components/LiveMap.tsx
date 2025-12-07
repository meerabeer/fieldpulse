"use client";

import dynamic from "next/dynamic";
import type { NfoStatusRow, SiteRecord } from "../lib/nfoHelpers";
import type { WarehouseRecord } from "./RoutePlanner";

/**
 * Props for LiveMap component.
 * 
 * MAP STATE PERSISTENCE:
 * - `mapAreaFilter` and `mapNfoFilter` are controlled by the parent (page.tsx)
 * - Parent persists these to localStorage so they survive tab switches and F5
 * - When user changes filters, LiveMapInner calls the onChange callbacks
 */
type LiveMapProps = {
  nfos: NfoStatusRow[];
  sites: SiteRecord[];
  warehouses: WarehouseRecord[];
  // Persisted map state - controlled by parent
  mapAreaFilter: string | null;        // "NFOs_ONLY", null (All Sites), or specific area name
  mapNfoFilter: string | null;         // null (all), "free", "busy", "on-shift", "off-shift"
  onMapAreaFilterChange: (area: string | null) => void;
  onMapNfoFilterChange: (filter: string | null) => void;
  // For Leaflet invalidateSize() - true when Live Map tab is active
  isActive: boolean;
};

const LiveMapInner = dynamic(() => import("./LiveMapInner"), {
  ssr: false, // critical: do NOT render leaflet on server
  loading: () => (
    <div className="w-full h-[600px] rounded-xl overflow-hidden border border-slate-200 bg-slate-50 flex items-center justify-center">
      <p className="text-slate-500">Loading map…</p>
    </div>
  ),
});

export default function LiveMap(props: LiveMapProps) {
  return (
    <div className="w-full h-[600px] rounded-xl overflow-hidden border border-slate-200">
      <LiveMapInner {...props} />
    </div>
  );
}
