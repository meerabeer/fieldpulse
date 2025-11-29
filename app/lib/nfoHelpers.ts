/**
 * NFO Helpers - extracted from legacy nfo-manager-prototype.html
 * 
 * Core utilities for distance calculations, site lookups, NFO ranking, and online status.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Basic types for locations and sites
 */
export type LatLng = {
  lat: number | null;
  lng: number | null;
};

export type SiteInfo = {
  id: string;
  name?: string | null;
  lat: number | null;
  lng: number | null;
  // optional flags – if your data doesn't have them, just ignore
  isDefaultLocation?: boolean | null;
  missingCoords?: boolean | null;
};

export type SiteRecord = {
  site_id: string;
  latitude: number | null;
  longitude: number | null;
  area?: string | null;
  name?: string | null;
};

export type NfoStatusRow = {
  username: string;
  name: string | null;
  on_shift: boolean | null;
  status: string | null;
  activity: string | null;
  site_id: string | null;
  lat: number | null;
  lng: number | null;
  logged_in: boolean | null;
  last_active_at: string | null;
  home_location: string | null;
};

// ============================================================================
// Helpers
// ============================================================================

export function hasValidLocation(loc?: LatLng | null): boolean {
  if (!loc) return false;
  if (loc.lat == null || loc.lng == null) return false;
  return Number.isFinite(loc.lat) && Number.isFinite(loc.lng);
}

/**
 * Haversine distance in km between two lat/lng points.
 * This matches the logic we had in the old index.html.
 */
export function calculateDistanceKm(a: LatLng, b: LatLng): number {
  const R = 6371; // km
  const dLat = ((b.lat! - a.lat!) * Math.PI) / 180;
  const dLng = ((b.lng! - a.lng!) * Math.PI) / 180;

  const lat1 = (a.lat! * Math.PI) / 180;
  const lat2 = (b.lat! * Math.PI) / 180;

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);

  const aa =
    sinDLat * sinDLat +
    Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;

  const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
  return R * c;
}

/**
 * Find the nearest site to an NFO location from a list of sites.
 * Returns both the site and the distance in km.
 */
export function findNearestSite(
  nfoLoc: LatLng | null | undefined,
  sites: SiteInfo[] | SiteRecord[]
): { site: SiteInfo | SiteRecord; distanceKm: number } | null {
  if (!hasValidLocation(nfoLoc)) return null;

  let best: { site: SiteInfo | SiteRecord; distanceKm: number } | null = null;

  for (const site of sites) {
    // Handle both SiteInfo and SiteRecord
    const lat = ("lat" in site ? site.lat : site.latitude) as number | null;
    const lng = ("lng" in site ? site.lng : site.longitude) as number | null;

    const siteLoc: LatLng = { lat, lng };
    if (!hasValidLocation(siteLoc)) continue;

    const d = calculateDistanceKm(nfoLoc as LatLng, siteLoc);
    if (!best || d < best.distanceKm) {
      best = { site, distanceKm: d };
    }
  }

  return best;
}

/**
 * Build a human-readable distance label.
 * Returns the distance in km with 2 decimal places.
 * No limitations on maximum distance.
 */
export function formatDistanceLabel(distanceKm: number): string {
  if (!Number.isFinite(distanceKm)) return "N/A";
  return `${distanceKm.toFixed(2)} km`;
}

/**
 * Find a site by ID, with case-insensitive and whitespace-trimmed matching.
 * Extracted from legacy: getSiteById(siteId)
 */
export function getSiteById(
  sites: SiteRecord[],
  siteId: string | null | undefined
): SiteRecord | null {
  if (!siteId) return null;

  const normalizedId = siteId.trim().toLowerCase();
  return (
    sites.find((s) => s.site_id && s.site_id.trim().toLowerCase() === normalizedId) ||
    null
  );
}

/**
 * Calculate minutes since lastActiveAt timestamp.
 * Returns null if lastActiveAt is invalid.
 * Extracted from legacy online status logic.
 */
export function ageMinutes(
  lastActiveAt: string | null,
  now: number = Date.now()
): number | null {
  if (!lastActiveAt) {
    return null;
  }

  const parsed = Date.parse(lastActiveAt);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  const ageMs = now - parsed;
  const ageMins = ageMs / (60 * 1000);

  return ageMins;
}

/**
 * Determine if an NFO is "online" based on lastActiveAt.
 * Legacy threshold: active within last 15 minutes (ACTIVE_WINDOW_MINUTES = 15).
 * Extracted from legacy: isOnline = loggedIn && lastActiveAtMs && (now - lastActiveAtMs <= ACTIVE_WINDOW_MS)
 */
export function isOnline(
  lastActiveAt: string | null,
  now: number = Date.now()
): boolean {
  const ACTIVE_WINDOW_MINUTES = 15;
  const ACTIVE_WINDOW_MS = ACTIVE_WINDOW_MINUTES * 60 * 1000;

  if (!lastActiveAt) {
    return false;
  }

  const parsed = Date.parse(lastActiveAt);
  if (!Number.isFinite(parsed)) {
    return false;
  }

  const age = now - parsed;
  return age <= ACTIVE_WINDOW_MS;
}

// ============================================================================
// Ping Status (Not Active Detection)
// ============================================================================

const STALE_MINUTES = 30;

export type PingStatus = {
  isNotActive: boolean;
  pingReason: string;
};

/**
 * Compute ping status based on last_active_at timestamp.
 * An NFO is considered "Not Active" if no ping for > 30 minutes.
 * This is separate from on_shift/status logic - purely derived from last_active_at.
 */
export function computePingStatus(
  lastActiveAt: string | null,
  now: number = Date.now()
): PingStatus {
  if (!lastActiveAt) {
    return {
      isNotActive: true,
      pingReason: "No last active time recorded",
    };
  }

  const parsed = Date.parse(lastActiveAt);
  if (!Number.isFinite(parsed)) {
    return {
      isNotActive: true,
      pingReason: "Invalid timestamp",
    };
  }

  const diffMs = now - parsed;
  const diffMinutes = diffMs / (1000 * 60);

  if (diffMinutes > STALE_MINUTES) {
    return {
      isNotActive: true,
      pingReason: `No ping for ${Math.floor(diffMinutes)} min`,
    };
  }

  return {
    isNotActive: false,
    pingReason: "OK",
  };
}
