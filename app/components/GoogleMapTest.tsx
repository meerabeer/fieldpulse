"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { GoogleMap, useLoadScript, Marker, InfoWindow, Polyline } from "@react-google-maps/api";
import { useSearchParams, useRouter } from "next/navigation";
import { supabase } from "../../lib/supabaseClient";

// Types for site coordinates
interface SiteCoordinate {
    site_id: string;
    site_name: string | null;
    latitude: number;
    longitude: number;
    area: string | null;
    cluster_owner: string | null;
}

interface NfoRecord {
    username: string;
    name: string | null;
    lat: number | null;
    lng: number | null;
    home_location: string | null;
    on_shift: boolean;
    status: string | null;
}

interface WarehouseRecord {
    id: number;
    name: string;
    region: string | null;
    latitude: number | null;
    longitude: number | null;
    is_active: boolean;
}

// Map container style
const containerStyle = {
    width: "100%",
    height: "100%",
};

// Default center: Jeddah, Saudi Arabia
const DEFAULT_CENTER = {
    lat: 21.4858,
    lng: 39.1925,
};

const DEFAULT_ZOOM = 7;

// Pagination and limits for large dataset
const SITE_LIMIT = 5000;
const PAGE_SIZE = 1000;

// Helper to check valid location
const hasValidLocation = (lat: number | null, lng: number | null): boolean => {
    if (lat == null || lng == null) return false;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    if (lat === 0 && lng === 0) return false;
    if (lat < -90 || lat > 90) return false;
    if (lng < -180 || lng > 180) return false;
    return true;
};

// Calculate air distance between two points (Haversine formula)
const calculateAirDistanceKm = (
    lat1: number, lng1: number,
    lat2: number, lng2: number
): number => {
    const R = 6371; // Earth's radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
};

export default function GoogleMapTest() {
    // ============ URL State for persistence ============
    const searchParams = useSearchParams();
    const router = useRouter();

    // ============ Data states ============
    const [sites, setSites] = useState<SiteCoordinate[]>([]);
    const [nfos, setNfos] = useState<NfoRecord[]>([]);
    const [totalNfoCount, setTotalNfoCount] = useState<number>(0); // Total NFOs including those without GPS
    const [warehouses, setWarehouses] = useState<WarehouseRecord[]>([]);
    const [loading, setLoading] = useState(true);
    const [initialLoadDone, setInitialLoadDone] = useState(false); // Track if initial load completed
    const [error, setError] = useState<string | null>(null);
    const [sitesLoadedCount, setSitesLoadedCount] = useState(0);
    const [lastNfoRefresh, setLastNfoRefresh] = useState<Date | null>(null);

    // ============ Map states (persist position) ============
    const [mapError, setMapError] = useState<string | null>(null);
    const [selectedSite, setSelectedSite] = useState<SiteCoordinate | null>(null);
    const mapRef = useRef<google.maps.Map | null>(null);
    const [mapCenter, setMapCenter] = useState<{ lat: number; lng: number }>(() => {
        const lat = parseFloat(searchParams.get("lat") || "");
        const lng = parseFloat(searchParams.get("lng") || "");
        if (!isNaN(lat) && !isNaN(lng)) return { lat, lng };
        return { lat: 21.4858, lng: 39.1925 }; // Default: Jeddah
    });
    const [mapZoom, setMapZoom] = useState<number>(() => {
        const zoom = parseInt(searchParams.get("zoom") || "");
        return !isNaN(zoom) ? zoom : 7;
    });

    // ============ Routing states (initialized from URL params) ============
    const [selectedNfoUsername, setSelectedNfoUsername] = useState<string>(searchParams.get("nfo") || "");
    const [selectedWarehouseId, setSelectedWarehouseId] = useState<string>(searchParams.get("wh") || "");
    const [selectedSiteId, setSelectedSiteId] = useState<string>(searchParams.get("site") || "");
    const [directions, setDirections] = useState<google.maps.DirectionsResult | null>(null);
    const [routePolylineTraffic, setRoutePolylineTraffic] = useState<google.maps.LatLng[] | null>(null);
    const [routePolylineNoTraffic, setRoutePolylineNoTraffic] = useState<google.maps.LatLng[] | null>(null);
    const [showTrafficRoute, setShowTrafficRoute] = useState<boolean>(true); // Toggle for which polyline to show
    const [routeLoading, setRouteLoading] = useState(false);
    const [routeError, setRouteError] = useState<string | null>(null);
    const [routeInfo, setRouteInfo] = useState<{
        distanceKm: number;
        distanceDisplay: string;
        etaWithTrafficSeconds: number;
        etaWithTrafficDisplay: string;
        etaNoTrafficSeconds: number;
        etaNoTrafficDisplay: string;
        trafficDifferenceSeconds: number;
        trafficDifferenceDisplay: string;
        staticDurationSeconds: number | null; // From routes.staticDuration if available
    } | null>(null);

    // ============ Filter states (initialized from URL params) ============
    const [areaFilter, setAreaFilter] = useState<string>(searchParams.get("area") || "all");
    const [nfoSearch, setNfoSearch] = useState<string>(searchParams.get("nfoSearch") || "");
    const [siteSearch, setSiteSearch] = useState<string>(searchParams.get("siteSearch") || "");

    // ============ Update URL when selections change ============
    const updateUrlParams = useCallback((params: Record<string, string>) => {
        const newParams = new URLSearchParams(searchParams.toString());
        Object.entries(params).forEach(([key, value]) => {
            if (value && value !== "all") {
                newParams.set(key, value);
            } else {
                newParams.delete(key);
            }
        });
        const newUrl = newParams.toString() ? `?${newParams.toString()}` : window.location.pathname;
        router.replace(newUrl, { scroll: false });
    }, [searchParams, router]);

    // Load Google Maps script with required libraries (including geometry for polyline decoding)
    const { isLoaded, loadError } = useLoadScript({
        googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY || "",
        libraries: ["places", "geometry"],
    });

    // Handle Google Maps errors
    useEffect(() => {
        if (loadError) {
            const errorMessage = loadError.message || "Unknown error loading Google Maps";
            setMapError(errorMessage);
            console.error("[GoogleMapTest] Google Maps load error:", loadError);

            if (errorMessage.includes("RefererNotAllowedMapError")) {
                console.error("[GoogleMapTest] RefererNotAllowedMapError: The current URL is not authorized.");
            } else if (errorMessage.includes("ApiNotActivatedMapError")) {
                console.error("[GoogleMapTest] ApiNotActivatedMapError: The Maps JavaScript API is not activated.");
            } else if (errorMessage.includes("BillingNotEnabledMapError")) {
                console.error("[GoogleMapTest] BillingNotEnabledMapError: Billing is not enabled.");
            } else if (errorMessage.includes("InvalidKeyMapError")) {
                console.error("[GoogleMapTest] InvalidKeyMapError: The API key is invalid.");
            }
        }
    }, [loadError]);

    // ============ Fetch all data ============
    const fetchAllData = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);

            // 1) Fetch sites with pagination
            let allSites: any[] = [];
            let pageNumber = 0;
            let hasMoreRows = true;

            while (hasMoreRows && allSites.length < SITE_LIMIT) {
                const start = pageNumber * PAGE_SIZE;
                const end = Math.min(start + PAGE_SIZE - 1, SITE_LIMIT - 1);

                const { data, error: fetchError } = await supabase
                    .from("Site_Coordinates")
                    .select("site_id, site_name, latitude, longitude, area, cluster_owner")
                    .range(start, end);

                if (fetchError) throw fetchError;

                if (!data || data.length === 0) {
                    hasMoreRows = false;
                    break;
                }

                allSites = allSites.concat(data);
                if (data.length < PAGE_SIZE) hasMoreRows = false;
                pageNumber++;
            }

            console.log(`[GoogleMapTest] Fetched ${allSites.length} site rows across ${pageNumber} pages`);

            // Filter valid coordinates
            const validSites: SiteCoordinate[] = allSites
                .map((row: any) => ({
                    site_id: row.site_id,
                    site_name: row.site_name ?? null,
                    latitude: typeof row.latitude === "string" ? parseFloat(row.latitude) : row.latitude,
                    longitude: typeof row.longitude === "string" ? parseFloat(row.longitude) : row.longitude,
                    area: row.area ?? null,
                    cluster_owner: row.cluster_owner ?? null,
                }))
                .filter((site) => hasValidLocation(site.latitude, site.longitude));

            setSites(validSites);
            setSitesLoadedCount(validSites.length);

            // 2) Fetch NFOs
            const { data: nfoData, error: nfoError } = await supabase
                .from("nfo_status")
                .select("username, name, lat, lng, home_location, on_shift, status")
                .order("username");

            if (nfoError) throw nfoError;

            const allNfos = nfoData ?? [];
            setTotalNfoCount(allNfos.length); // Store total count including those without GPS
            
            const validNfos: NfoRecord[] = allNfos.filter(
                (nfo: any) => hasValidLocation(nfo.lat, nfo.lng)
            );
            setNfos(validNfos);
            console.log(`[GoogleMapTest] Loaded ${validNfos.length} NFOs with GPS (${allNfos.length} total)`);

            // 3) Fetch Warehouses
            const { data: whData, error: whError } = await supabase
                .from("warehouses")
                .select("id, name, region, latitude, longitude, is_active")
                .eq("is_active", true)
                .order("name");

            if (whError) throw whError;

            const validWarehouses: WarehouseRecord[] = (whData ?? []).filter(
                (wh: any) => hasValidLocation(wh.latitude, wh.longitude)
            );
            setWarehouses(validWarehouses);
            console.log(`[GoogleMapTest] Loaded ${validWarehouses.length} active warehouses`);

        } catch (err: any) {
            const errorMsg = err instanceof Error ? err.message : String(err ?? "Unknown error");
            setError(errorMsg);
            console.error("[GoogleMapTest] Error fetching data:", err);
        } finally {
            setLoading(false);
            setInitialLoadDone(true);
        }
    }, []);

    // Function to refresh only NFO positions (lightweight, no sites/warehouses)
    const refreshNfoPositions = useCallback(async () => {
        try {
            const { data: nfoData, error: nfoError } = await supabase
                .from("nfo_status")
                .select("username, name, lat, lng, home_location, on_shift, status")
                .order("username");

            if (nfoError) {
                console.error("[GoogleMapTest] NFO refresh error:", nfoError);
                return;
            }

            const allNfos = nfoData ?? [];
            setTotalNfoCount(allNfos.length);
            
            const validNfos: NfoRecord[] = allNfos.filter(
                (nfo: any) => hasValidLocation(nfo.lat, nfo.lng)
            );
            setNfos(validNfos);
            setLastNfoRefresh(new Date());
            console.log(`[GoogleMapTest] NFO positions refreshed: ${validNfos.length} with GPS`);
        } catch (err) {
            console.error("[GoogleMapTest] NFO refresh failed:", err);
        }
    }, []);

    // Fetch data on mount
    useEffect(() => {
        fetchAllData();
    }, [fetchAllData]);

    // Auto-refresh NFO positions every 15 seconds
    useEffect(() => {
        if (!initialLoadDone) return;
        
        const interval = setInterval(() => {
            refreshNfoPositions();
        }, 15000); // 15 seconds

        return () => clearInterval(interval);
    }, [initialLoadDone, refreshNfoPositions]);

    // ============ Computed values ============
    const areas = useMemo(() => {
        const areaSet = new Set<string>();
        sites.forEach((site) => {
            if (site.area && site.area.trim()) {
                areaSet.add(site.area.trim());
            }
        });
        return Array.from(areaSet).sort();
    }, [sites]);

    const filteredSites = useMemo(() => {
        let result = sites;
        if (areaFilter !== "all") {
            result = result.filter((site) => site.area?.trim() === areaFilter);
        }
        if (siteSearch.trim()) {
            const term = siteSearch.toLowerCase();
            result = result.filter((s) =>
                `${s.site_id} ${s.site_name ?? ""} ${s.area ?? ""}`.toLowerCase().includes(term)
            );
        }
        return result;
    }, [sites, areaFilter, siteSearch]);

    const filteredNfos = useMemo(() => {
        if (!nfoSearch.trim()) return nfos;
        const term = nfoSearch.toLowerCase();
        return nfos.filter((n) =>
            `${n.username} ${n.name ?? ""} ${n.home_location ?? ""}`.toLowerCase().includes(term)
        );
    }, [nfos, nfoSearch]);

    // Deduplicate sites for dropdown
    const uniqueSitesForDropdown = useMemo(() => {
        return Array.from(new Map(filteredSites.map((s) => [s.site_id, s])).values());
    }, [filteredSites]);

    // Get selected entities
    const selectedNfo = useMemo(() => {
        return nfos.find((n) => n.username === selectedNfoUsername) ?? null;
    }, [nfos, selectedNfoUsername]);

    const selectedWarehouse = useMemo(() => {
        if (!selectedWarehouseId) return null;
        return warehouses.find((w) => String(w.id) === selectedWarehouseId) ?? null;
    }, [warehouses, selectedWarehouseId]);

    const selectedSiteForRoute = useMemo(() => {
        return sites.find((s) => s.site_id === selectedSiteId) ?? null;
    }, [sites, selectedSiteId]);

    // Check if we can calculate route
    const canRoute = useMemo(() => {
        if (!selectedNfo || !selectedSiteForRoute) return false;
        if (!hasValidLocation(selectedNfo.lat, selectedNfo.lng)) return false;
        if (!hasValidLocation(selectedSiteForRoute.latitude, selectedSiteForRoute.longitude)) return false;
        return true;
    }, [selectedNfo, selectedSiteForRoute]);

    // Calculate air distances
    const airDistances = useMemo(() => {
        if (!selectedNfo || !selectedSiteForRoute) return null;
        if (!hasValidLocation(selectedNfo.lat, selectedNfo.lng)) return null;
        if (!hasValidLocation(selectedSiteForRoute.latitude, selectedSiteForRoute.longitude)) return null;

        const nfoToSite = calculateAirDistanceKm(
            selectedNfo.lat!, selectedNfo.lng!,
            selectedSiteForRoute.latitude, selectedSiteForRoute.longitude
        );

        let nfoToWarehouse: number | null = null;
        let warehouseToSite: number | null = null;

        if (selectedWarehouse && hasValidLocation(selectedWarehouse.latitude, selectedWarehouse.longitude)) {
            nfoToWarehouse = calculateAirDistanceKm(
                selectedNfo.lat!, selectedNfo.lng!,
                selectedWarehouse.latitude!, selectedWarehouse.longitude!
            );
            warehouseToSite = calculateAirDistanceKm(
                selectedWarehouse.latitude!, selectedWarehouse.longitude!,
                selectedSiteForRoute.latitude, selectedSiteForRoute.longitude
            );
        }

        return { nfoToSite, nfoToWarehouse, warehouseToSite };
    }, [selectedNfo, selectedSiteForRoute, selectedWarehouse]);

    // ============ Route calculation using Google Routes API (TWO requests: Traffic ON vs OFF) ============
    const calculateRoute = useCallback(async () => {
        if (!isLoaded || !canRoute || !selectedNfo || !selectedSiteForRoute) return;

        setRouteLoading(true);
        setRouteError(null);
        setDirections(null);
        setRouteInfo(null);
        setRoutePolylineTraffic(null);
        setRoutePolylineNoTraffic(null);
        setShowTrafficRoute(true); // Default to showing traffic route

        try {
            const origin = { lat: selectedNfo.lat!, lng: selectedNfo.lng! };
            const destination = { lat: selectedSiteForRoute.latitude, lng: selectedSiteForRoute.longitude };

            // Build waypoints array (intermediates)
            const intermediates: { latitude: number; longitude: number }[] = [];
            if (selectedWarehouse && hasValidLocation(selectedWarehouse.latitude, selectedWarehouse.longitude)) {
                intermediates.push({
                    latitude: selectedWarehouse.latitude!,
                    longitude: selectedWarehouse.longitude!,
                });
            }

            // API Key (from env)
            const apiKey = process.env.NEXT_PUBLIC_ROUTES_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY || "";
            const fieldMask = "routes.duration,routes.staticDuration,routes.distanceMeters,routes.polyline.encodedPolyline";

            // Base request body (shared between both requests)
            const baseRequestBody: any = {
                origin: {
                    location: {
                        latLng: {
                            latitude: origin.lat,
                            longitude: origin.lng,
                        },
                    },
                },
                destination: {
                    location: {
                        latLng: {
                            latitude: destination.lat,
                            longitude: destination.lng,
                        },
                    },
                },
                travelMode: "DRIVE",
                computeAlternativeRoutes: false,
                languageCode: "en-US",
                units: "METRIC",
            };

            // Add intermediates (waypoints) if any
            if (intermediates.length > 0) {
                baseRequestBody.intermediates = intermediates.map((wp) => ({
                    location: {
                        latLng: {
                            latitude: wp.latitude,
                            longitude: wp.longitude,
                        },
                    },
                }));
            }

            // Request #1: TRAFFIC_AWARE (live traffic ETA)
            // Note: Google requires departureTime to be in the future, so add 60 seconds
            const futureTime = new Date(Date.now() + 60000); // 60 seconds from now
            const trafficRequestBody = {
                ...baseRequestBody,
                routingPreference: "TRAFFIC_AWARE",
                departureTime: futureTime.toISOString(), // Slightly in future for live traffic
            };

            // Request #2: TRAFFIC_UNAWARE (no traffic, baseline ETA)
            const noTrafficRequestBody = {
                ...baseRequestBody,
                routingPreference: "TRAFFIC_UNAWARE",
                // No departureTime for baseline
            };

            // DEBUG LOG (safe - no API key logged)
            console.log("[GoogleMapTest] === ROUTES API DUAL REQUEST DEBUG ===");
            console.log("[GoogleMapTest] Endpoint: https://routes.googleapis.com/directions/v2:computeRoutes");
            console.log("[GoogleMapTest] Field Mask:", fieldMask);
            console.log("[GoogleMapTest] Origin:", origin);
            console.log("[GoogleMapTest] Destination:", destination);
            console.log("[GoogleMapTest] Intermediates:", intermediates.length > 0 ? intermediates : "None");
            console.log("[GoogleMapTest] Request #1 (TRAFFIC_AWARE):", { 
                routingPreference: "TRAFFIC_AWARE", 
                departureTime: trafficRequestBody.departureTime 
            });
            console.log("[GoogleMapTest] Request #2 (TRAFFIC_UNAWARE):", { 
                routingPreference: "TRAFFIC_UNAWARE", 
                departureTime: "omitted" 
            });
            console.log("[GoogleMapTest] API Key:", apiKey ? `${apiKey.substring(0, 8)}...REDACTED` : "MISSING!");
            console.log("[GoogleMapTest] =====================================");

            // Make both requests in parallel
            const [trafficResponse, noTrafficResponse] = await Promise.all([
                fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "X-Goog-Api-Key": apiKey,
                        "X-Goog-FieldMask": fieldMask,
                    },
                    body: JSON.stringify(trafficRequestBody),
                }),
                fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "X-Goog-Api-Key": apiKey,
                        "X-Goog-FieldMask": fieldMask,
                    },
                    body: JSON.stringify(noTrafficRequestBody),
                }),
            ]);

            // Check for errors
            if (!trafficResponse.ok) {
                const errorData = await trafficResponse.json().catch(() => ({}));
                console.error("[GoogleMapTest] Traffic request error:", trafficResponse.status, errorData);
                throw new Error(errorData.error?.message || `Routes API (traffic) error: ${trafficResponse.status}`);
            }
            if (!noTrafficResponse.ok) {
                const errorData = await noTrafficResponse.json().catch(() => ({}));
                console.error("[GoogleMapTest] No-traffic request error:", noTrafficResponse.status, errorData);
                throw new Error(errorData.error?.message || `Routes API (no-traffic) error: ${noTrafficResponse.status}`);
            }

            // Parse responses
            const [trafficData, noTrafficData] = await Promise.all([
                trafficResponse.json(),
                noTrafficResponse.json(),
            ]);

            console.log("[GoogleMapTest] === ROUTES API RESPONSE DEBUG ===");
            console.log("[GoogleMapTest] Traffic Response:", trafficData);
            console.log("[GoogleMapTest] No-Traffic Response:", noTrafficData);

            // Validate routes exist
            if (!trafficData.routes || trafficData.routes.length === 0) {
                throw new Error("No route found (traffic-aware request)");
            }
            if (!noTrafficData.routes || noTrafficData.routes.length === 0) {
                throw new Error("No route found (traffic-unaware request)");
            }

            const trafficRoute = trafficData.routes[0];
            const noTrafficRoute = noTrafficData.routes[0];

            // Parse durations (format: "1234s")
            const parseDuration = (d: string): number => parseInt(d?.replace("s", "") || "0", 10);

            const etaWithTrafficSeconds = parseDuration(trafficRoute.duration);
            const etaNoTrafficSeconds = parseDuration(noTrafficRoute.duration);
            const staticDurationSeconds = trafficRoute.staticDuration 
                ? parseDuration(trafficRoute.staticDuration) 
                : null;
            const distanceMeters = trafficRoute.distanceMeters || noTrafficRoute.distanceMeters || 0;
            const trafficDifferenceSeconds = etaWithTrafficSeconds - etaNoTrafficSeconds;

            // DEBUG: Log parsed values
            console.log("[GoogleMapTest] === PARSED RESULTS ===");
            console.log("[GoogleMapTest] ETA with traffic:", etaWithTrafficSeconds, "s =", formatDuration(etaWithTrafficSeconds));
            console.log("[GoogleMapTest] ETA without traffic:", etaNoTrafficSeconds, "s =", formatDuration(etaNoTrafficSeconds));
            console.log("[GoogleMapTest] Static duration (from traffic response):", staticDurationSeconds, "s");
            console.log("[GoogleMapTest] Traffic difference:", trafficDifferenceSeconds, "s =", Math.round(trafficDifferenceSeconds / 60), "min");
            console.log("[GoogleMapTest] Distance:", distanceMeters, "m =", (distanceMeters / 1000).toFixed(1), "km");
            console.log("[GoogleMapTest] RAW duration strings - Traffic:", trafficRoute.duration, "| No-Traffic:", noTrafficRoute.duration);
            console.log("[GoogleMapTest] =====================");

            // Decode polylines
            const trafficPolyline = google.maps.geometry.encoding.decodePath(trafficRoute.polyline.encodedPolyline);
            const noTrafficPolyline = google.maps.geometry.encoding.decodePath(noTrafficRoute.polyline.encodedPolyline);

            setRoutePolylineTraffic(trafficPolyline);
            setRoutePolylineNoTraffic(noTrafficPolyline);

            // Format difference string
            const diffSign = trafficDifferenceSeconds >= 0 ? "+" : "";
            const trafficDifferenceDisplay = `${diffSign}${formatDuration(trafficDifferenceSeconds)}`;

            setRouteInfo({
                distanceKm: distanceMeters / 1000,
                distanceDisplay: `${(distanceMeters / 1000).toFixed(1)} km`,
                etaWithTrafficSeconds,
                etaWithTrafficDisplay: formatDuration(etaWithTrafficSeconds),
                etaNoTrafficSeconds,
                etaNoTrafficDisplay: formatDuration(etaNoTrafficSeconds),
                trafficDifferenceSeconds,
                trafficDifferenceDisplay,
                staticDurationSeconds,
            });

            // Fit map to route bounds (use traffic route)
            if (mapRef.current && trafficPolyline.length > 0) {
                const bounds = new google.maps.LatLngBounds();
                trafficPolyline.forEach((point) => bounds.extend(point));
                mapRef.current.fitBounds(bounds, {
                    top: 50,
                    right: 50,
                    bottom: 50,
                    left: 50,
                });
            }
        } catch (err: any) {
            console.error("[GoogleMapTest] Routes API error:", err);
            let errorMsg = err.message || "Failed to calculate route";
            if (errorMsg.includes("API key") || errorMsg.includes("API_KEY")) {
                errorMsg = "Routes API key error. Check your API key permissions.";
            } else if (errorMsg.includes("PERMISSION_DENIED")) {
                errorMsg = "Permission denied. Ensure Routes API is enabled in Google Cloud Console.";
            }
            setRouteError(errorMsg);
        } finally {
            setRouteLoading(false);
        }
    }, [isLoaded, canRoute, selectedNfo, selectedSiteForRoute, selectedWarehouse]);

    // Format duration helper
    const formatDuration = (seconds: number): string => {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.round((seconds % 3600) / 60);
        if (hours > 0) {
            return `${hours}h ${minutes}m`;
        }
        return `${minutes} min`;
    };

    // Clear route
    const clearRoute = useCallback(() => {
        setSelectedNfoUsername("");
        setSelectedWarehouseId("");
        setSelectedSiteId("");
        setDirections(null);
        setRoutePolylineTraffic(null);
        setRoutePolylineNoTraffic(null);
        setShowTrafficRoute(true);
        setRouteInfo(null);
        setRouteError(null);
        // Clear URL params
        router.replace(window.location.pathname, { scroll: false });
    }, [router]);

    // Handle marker click
    const handleMarkerClick = (site: SiteCoordinate) => {
        setSelectedSite(site);
    };

    const handleInfoWindowClose = () => {
        setSelectedSite(null);
    };

    // Handle map load
    const handleMapLoad = useCallback((map: google.maps.Map) => {
        mapRef.current = map;
        console.log("[GoogleMapTest] Google Map loaded successfully");
    }, []);

    // Track if map position has been manually changed by user
    const mapPositionChangedByUser = useRef(false);

    // Save map position to URL (debounced, only after user interaction)
    useEffect(() => {
        if (!mapPositionChangedByUser.current) return;
        
        const timer = setTimeout(() => {
            updateUrlParams({
                lat: mapCenter.lat.toFixed(4),
                lng: mapCenter.lng.toFixed(4),
                zoom: String(mapZoom),
            });
        }, 1000); // Debounce 1 second to avoid too many URL updates

        return () => clearTimeout(timer);
    }, [mapCenter, mapZoom, updateUrlParams]);

    // ============ Render status banner ============
    const renderStatusBanner = () => {
        const mapsStatus = loadError ? (
            <span className="text-red-600">❌ Maps failed: {mapError || loadError.message}</span>
        ) : isLoaded ? (
            <span className="text-green-600">✅ Maps loaded</span>
        ) : (
            <span className="text-gray-500">⏳ Loading maps...</span>
        );

        const sitesStatus = loading ? (
            <span className="text-gray-500">⏳ Loading data...</span>
        ) : error ? (
            <span className="text-red-600">❌ Data failed: {error}</span>
        ) : (
            <span className="text-green-600">✅ Sites: {sitesLoadedCount} | NFOs: {nfos.length} | WH: {warehouses.length}</span>
        );

        const nfoRefreshStatus = lastNfoRefresh ? (
            <span className="text-slate-500 text-xs">NFO updated: {lastNfoRefresh.toLocaleTimeString()}</span>
        ) : null;

        return (
            <div className="bg-slate-100 border border-slate-300 rounded-lg px-4 py-3 mb-4">
                <div className="flex flex-wrap items-center gap-4 text-sm">
                    <div className="flex items-center gap-2">
                        <span className="font-medium text-slate-700">Maps:</span>
                        {mapsStatus}
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="font-medium text-slate-700">Data:</span>
                        {sitesStatus}
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="font-medium text-slate-700">Markers:</span>
                        <span className="text-blue-600 font-semibold">{Math.min(filteredSites.length, 2000)}</span>
                    </div>
                    {nfoRefreshStatus && (
                        <div className="flex items-center gap-1">
                            <span className="animate-pulse text-green-500">●</span>
                            {nfoRefreshStatus}
                        </div>
                    )}
                </div>
            </div>
        );
    };

    // ============ Render loading state ============
    if (!isLoaded || loading) {
        return (
            <div className="space-y-4">
                {renderStatusBanner()}
                <div className="flex items-center justify-center h-96 bg-slate-100 rounded-lg">
                    <p className="text-slate-600">Loading Google Maps and data...</p>
                </div>
            </div>
        );
    }

    // ============ Render error state ============
    if (loadError) {
        return (
            <div className="space-y-4">
                {renderStatusBanner()}
                <div className="bg-red-50 border border-red-200 rounded-lg p-6">
                    <h3 className="font-semibold text-red-700 mb-2">Google Maps Error</h3>
                    <p className="text-red-600 text-sm mb-4">{mapError || loadError.message}</p>
                    <div className="text-xs text-red-500">
                        <p className="font-medium mb-2">Common causes:</p>
                        <ul className="list-disc list-inside space-y-1">
                            <li>API key not set or invalid</li>
                            <li>Current domain not allowed in API key restrictions</li>
                            <li>Maps JavaScript API not enabled</li>
                            <li>Directions API not enabled</li>
                            <li>Billing not enabled</li>
                        </ul>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="flex gap-4 h-[calc(100vh-12rem)]">
            {/* Left side: Control panel */}
            <div className="w-80 flex-shrink-0 space-y-4 overflow-y-auto">
                {/* Status banner */}
                {renderStatusBanner()}

                {/* Site selector */}
                <div className="bg-white rounded-xl shadow p-4">
                    <label className="block text-sm font-medium text-slate-700 mb-2">
                        Destination Site <span className="text-red-500">*</span>
                    </label>
                    <input
                        type="text"
                        placeholder="Search sites..."
                        value={siteSearch}
                        onChange={(e) => {
                            setSiteSearch(e.target.value);
                            updateUrlParams({ siteSearch: e.target.value });
                        }}
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-sky-500"
                    />
                    <select
                        value={selectedSiteId}
                        onChange={(e) => {
                            setSelectedSiteId(e.target.value);
                            updateUrlParams({ site: e.target.value });
                        }}
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                    >
                        <option value="">Select a site... ({uniqueSitesForDropdown.length} available)</option>
                        {uniqueSitesForDropdown
                            .sort((a, b) => a.site_id.localeCompare(b.site_id))
                            .slice(0, 500) // Limit dropdown for performance
                            .map((site) => (
                                <option key={site.site_id} value={site.site_id}>
                                    {site.site_id} – {site.site_name || "Unnamed"} ({site.area || "No area"})
                                </option>
                            ))}
                    </select>
                </div>

                {/* Warehouse selector (optional) */}
                <div className="bg-white rounded-xl shadow p-4">
                    <label className="block text-sm font-medium text-slate-700 mb-2">
                        Warehouse <span className="text-slate-400">(optional waypoint)</span>
                    </label>
                    <select
                        value={selectedWarehouseId}
                        onChange={(e) => {
                            setSelectedWarehouseId(e.target.value);
                            updateUrlParams({ wh: e.target.value });
                        }}
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                    >
                        <option value="">None (direct route)</option>
                        {warehouses.map((wh) => (
                            <option key={wh.id} value={String(wh.id)}>
                                {wh.name} – {wh.region || "No region"}
                            </option>
                        ))}
                    </select>
                </div>

                {/* NFO selector */}
                <div className="bg-white rounded-xl shadow p-4">
                    <label className="block text-sm font-medium text-slate-700 mb-2">
                        NFO (Origin) <span className="text-red-500">*</span>
                    </label>
                    <input
                        type="text"
                        placeholder="Search NFOs..."
                        value={nfoSearch}
                        onChange={(e) => {
                            setNfoSearch(e.target.value);
                            updateUrlParams({ nfoSearch: e.target.value });
                        }}
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-sky-500"
                    />
                    <select
                        value={selectedNfoUsername}
                        onChange={(e) => {
                            setSelectedNfoUsername(e.target.value);
                            updateUrlParams({ nfo: e.target.value });
                        }}
                        className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                    >
                        <option value="">Select an NFO... ({filteredNfos.length} with GPS / {totalNfoCount} total)</option>
                        {filteredNfos
                            .sort((a, b) => a.username.localeCompare(b.username))
                            .map((nfo) => (
                                <option key={nfo.username} value={nfo.username}>
                                    {nfo.username} – {nfo.name || "Unnamed"} ({nfo.home_location || "No area"})
                                </option>
                            ))}
                    </select>
                    <p className="text-xs text-slate-400 mt-1">
                        ⚠️ Only NFOs with GPS coordinates can be selected ({nfos.length} of {totalNfoCount})
                    </p>
                </div>

                {/* Route buttons */}
                <div className="flex gap-2">
                    <button
                        onClick={calculateRoute}
                        disabled={!canRoute || routeLoading}
                        className={`flex-1 py-3 rounded-xl font-medium transition ${canRoute && !routeLoading
                            ? "bg-sky-600 text-white hover:bg-sky-700"
                            : "bg-slate-200 text-slate-400 cursor-not-allowed"
                            }`}
                    >
                        {routeLoading ? "Calculating..." : "Calculate Route (Google)"}
                    </button>
                    <button
                        onClick={clearRoute}
                        disabled={routeLoading}
                        className="px-4 py-3 rounded-xl font-medium transition border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                    >
                        Clear
                    </button>
                </div>

                {/* Route error */}
                {routeError && (
                    <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm">
                        {routeError}
                    </div>
                )}

                {/* Route info panel */}
                {routeInfo && (
                    <div className="bg-white rounded-xl shadow p-4 space-y-3">
                        <h3 className="font-semibold text-slate-800 text-sm flex items-center gap-2">
                            <span className="text-green-600">✅</span> Route Summary (Google Routes API)
                        </h3>

                        <div className="text-sm text-slate-600 space-y-1">
                            {selectedWarehouse ? (
                                <p className="font-medium text-slate-700">
                                    NFO → Warehouse → Site
                                    <br />
                                    <span className="text-xs text-slate-500">via {selectedWarehouse.name}</span>
                                </p>
                            ) : (
                                <p className="font-medium text-slate-700">NFO → Site (direct)</p>
                            )}
                        </div>

                        <div className="border-t border-slate-100 pt-3 space-y-2">
                            {/* Distance */}
                            <div className="flex justify-between text-sm">
                                <span className="text-slate-600">Distance:</span>
                                <span className="font-semibold text-slate-800">{routeInfo.distanceDisplay}</span>
                            </div>

                            {/* ETA WITH Traffic */}
                            <div className="flex justify-between text-sm bg-green-50 rounded px-2 py-1">
                                <span className="text-green-700 font-medium">🚗 ETA (with traffic):</span>
                                <span className="font-bold text-green-700 text-lg">{routeInfo.etaWithTrafficDisplay}</span>
                            </div>

                            {/* ETA WITHOUT Traffic */}
                            <div className="flex justify-between text-sm bg-slate-50 rounded px-2 py-1">
                                <span className="text-slate-600">📊 ETA (no traffic):</span>
                                <span className="font-semibold text-slate-700">{routeInfo.etaNoTrafficDisplay}</span>
                            </div>

                            {/* Traffic Difference */}
                            <div className="flex justify-between text-sm">
                                <span className="text-slate-500">Traffic impact:</span>
                                <span className={`font-medium ${routeInfo.trafficDifferenceSeconds > 0 ? 'text-red-600' : routeInfo.trafficDifferenceSeconds < 0 ? 'text-green-600' : 'text-slate-500'}`}>
                                    {routeInfo.trafficDifferenceDisplay}
                                </span>
                            </div>

                            {/* Static Duration (if available) */}
                            {routeInfo.staticDurationSeconds !== null && (
                                <div className="flex justify-between text-xs text-slate-400">
                                    <span>Static duration (from API):</span>
                                    <span>{formatDuration(routeInfo.staticDurationSeconds)}</span>
                                </div>
                            )}
                        </div>

                        {/* Polyline Toggle */}
                        <div className="border-t border-slate-100 pt-3">
                            <label className="block text-xs font-medium text-slate-600 mb-2">
                                Show route on map:
                            </label>
                            <div className="flex gap-2">
                                <button
                                    onClick={() => setShowTrafficRoute(true)}
                                    className={`flex-1 px-3 py-1.5 text-xs rounded transition ${showTrafficRoute
                                        ? 'bg-green-600 text-white'
                                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                                        }`}
                                >
                                    🚗 With Traffic
                                </button>
                                <button
                                    onClick={() => setShowTrafficRoute(false)}
                                    className={`flex-1 px-3 py-1.5 text-xs rounded transition ${!showTrafficRoute
                                        ? 'bg-blue-600 text-white'
                                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                                        }`}
                                >
                                    📊 No Traffic
                                </button>
                            </div>
                        </div>

                        {/* Info note */}
                        <div className="text-[10px] text-slate-400 bg-slate-50 rounded p-2 mt-2">
                            ℹ️ ETA is based on Google road network + legal speed limits. 
                            "With traffic" uses live traffic data.
                        </div>
                    </div>
                )}

                {/* Air distances */}
                {airDistances && (
                    <div className="bg-white rounded-xl shadow p-4">
                        <h3 className="font-semibold text-slate-800 text-sm mb-2">Air Distances (straight line)</h3>
                        <div className="space-y-1 text-xs">
                            <div className="flex justify-between">
                                <span className="text-slate-500">NFO → Site:</span>
                                <span className="text-slate-600">{airDistances.nfoToSite.toFixed(1)} km</span>
                            </div>
                            {airDistances.nfoToWarehouse !== null && (
                                <div className="flex justify-between">
                                    <span className="text-slate-500">NFO → Warehouse:</span>
                                    <span className="text-slate-600">{airDistances.nfoToWarehouse.toFixed(1)} km</span>
                                </div>
                            )}
                            {airDistances.warehouseToSite !== null && (
                                <div className="flex justify-between">
                                    <span className="text-slate-500">Warehouse → Site:</span>
                                    <span className="text-slate-600">{airDistances.warehouseToSite.toFixed(1)} km</span>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* Area filter */}
                {areas.length > 0 && (
                    <div className="bg-white rounded-xl shadow p-4">
                        <label className="block text-sm font-medium text-slate-700 mb-2">
                            Filter Sites by Area
                        </label>
                        <select
                            value={areaFilter}
                            onChange={(e) => {
                                setAreaFilter(e.target.value);
                                updateUrlParams({ area: e.target.value });
                            }}
                            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                        >
                            <option value="all">All Areas ({sites.length} sites)</option>
                            {areas.map((area) => {
                                const count = sites.filter((s) => s.area?.trim() === area).length;
                                return (
                                    <option key={area} value={area}>
                                        {area} ({count} sites)
                                    </option>
                                );
                            })}
                        </select>
                    </div>
                )}
            </div>

            {/* Right side: Map */}
            <div className="flex-1 bg-white rounded-xl shadow overflow-hidden">
                <GoogleMap
                    mapContainerStyle={containerStyle}
                    center={mapCenter}
                    zoom={mapZoom}
                    onLoad={handleMapLoad}
                    onDragEnd={() => {
                        mapPositionChangedByUser.current = true;
                        if (mapRef.current) {
                            const center = mapRef.current.getCenter();
                            if (center) {
                                setMapCenter({ lat: center.lat(), lng: center.lng() });
                            }
                        }
                    }}
                    onZoomChanged={() => {
                        mapPositionChangedByUser.current = true;
                        if (mapRef.current) {
                            const newZoom = mapRef.current.getZoom();
                            if (newZoom && newZoom !== mapZoom) {
                                setMapZoom(newZoom);
                            }
                        }
                    }}
                    options={{
                        streetViewControl: false,
                        mapTypeControl: true,
                        fullscreenControl: true,
                    }}
                >
                    {/* Render markers for filtered sites (limit for performance) */}
                    {filteredSites.slice(0, 2000).map((site) => {
                        const isSelectedSite = site.site_id === selectedSiteId;
                        return (
                            <Marker
                                key={site.site_id}
                                position={{ lat: site.latitude, lng: site.longitude }}
                                onClick={() => handleMarkerClick(site)}
                                title={site.site_id}
                                icon={{
                                    url: isSelectedSite 
                                        ? "data:image/svg+xml," + encodeURIComponent(`
                                            <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
                                                <circle cx="20" cy="20" r="18" fill="#ef4444" stroke="white" stroke-width="3"/>
                                                <text x="20" y="26" font-family="Arial, sans-serif" font-size="18" font-weight="bold" fill="white" text-anchor="middle">S</text>
                                            </svg>
                                        `)
                                        : "data:image/svg+xml," + encodeURIComponent(`
                                            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
                                                <circle cx="12" cy="12" r="8" fill="#3b82f6" stroke="white" stroke-width="2"/>
                                            </svg>
                                        `),
                                    scaledSize: isSelectedSite ? new google.maps.Size(40, 40) : new google.maps.Size(16, 16),
                                    anchor: isSelectedSite ? new google.maps.Point(20, 20) : new google.maps.Point(8, 8),
                                }}
                                zIndex={isSelectedSite ? 1000 : 1} // Bring selected to front
                            />
                        );
                    })}

                    {/* NFO marker */}
                    {selectedNfo && hasValidLocation(selectedNfo.lat, selectedNfo.lng) && (
                        <Marker
                            position={{ lat: selectedNfo.lat!, lng: selectedNfo.lng! }}
                            title={`NFO: ${selectedNfo.username}`}
                            icon={{
                                url: "data:image/svg+xml," + encodeURIComponent(`
                                    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
                                        <circle cx="16" cy="16" r="12" fill="#22c55e" stroke="white" stroke-width="3"/>
                                        <text x="16" y="20" text-anchor="middle" fill="white" font-size="10" font-weight="bold">N</text>
                                    </svg>
                                `),
                                scaledSize: new google.maps.Size(32, 32),
                                anchor: new google.maps.Point(16, 16),
                            }}
                        />
                    )}

                    {/* Warehouse marker */}
                    {selectedWarehouse && hasValidLocation(selectedWarehouse.latitude, selectedWarehouse.longitude) && (
                        <Marker
                            position={{ lat: selectedWarehouse.latitude!, lng: selectedWarehouse.longitude! }}
                            title={`Warehouse: ${selectedWarehouse.name}`}
                            icon={{
                                url: "data:image/svg+xml," + encodeURIComponent(`
                                    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
                                        <circle cx="16" cy="16" r="12" fill="#8b5cf6" stroke="white" stroke-width="3"/>
                                        <text x="16" y="20" text-anchor="middle" fill="white" font-size="10" font-weight="bold">W</text>
                                    </svg>
                                `),
                                scaledSize: new google.maps.Size(32, 32),
                                anchor: new google.maps.Point(16, 16),
                            }}
                        />
                    )}

                    {/* Route polyline from Routes API - toggleable between traffic/no-traffic */}
                    {showTrafficRoute && routePolylineTraffic && routePolylineTraffic.length > 0 && (
                        <Polyline
                            path={routePolylineTraffic}
                            options={{
                                strokeColor: "#16a34a", // green for traffic-aware
                                strokeWeight: 5,
                                strokeOpacity: 0.8,
                            }}
                        />
                    )}
                    {!showTrafficRoute && routePolylineNoTraffic && routePolylineNoTraffic.length > 0 && (
                        <Polyline
                            path={routePolylineNoTraffic}
                            options={{
                                strokeColor: "#3b82f6", // blue for no-traffic
                                strokeWeight: 5,
                                strokeOpacity: 0.8,
                            }}
                        />
                    )}

                    {/* InfoWindow for selected site */}
                    {selectedSite && (
                        <InfoWindow
                            position={{ lat: selectedSite.latitude, lng: selectedSite.longitude }}
                            onCloseClick={handleInfoWindowClose}
                        >
                            <div className="p-2 min-w-[200px]">
                                <h3 className="font-semibold text-gray-800 mb-2">Site Information</h3>
                                <table className="text-sm">
                                    <tbody>
                                        <tr>
                                            <td className="text-gray-500 pr-3 py-0.5">Site ID:</td>
                                            <td className="font-mono text-gray-800">{selectedSite.site_id}</td>
                                        </tr>
                                        {selectedSite.site_name && (
                                            <tr>
                                                <td className="text-gray-500 pr-3 py-0.5">Name:</td>
                                                <td className="text-gray-800">{selectedSite.site_name}</td>
                                            </tr>
                                        )}
                                        {selectedSite.area && (
                                            <tr>
                                                <td className="text-gray-500 pr-3 py-0.5">Area:</td>
                                                <td className="text-gray-800">{selectedSite.area}</td>
                                            </tr>
                                        )}
                                        {selectedSite.cluster_owner && (
                                            <tr>
                                                <td className="text-gray-500 pr-3 py-0.5">Cluster Owner:</td>
                                                <td className="text-gray-800">{selectedSite.cluster_owner}</td>
                                            </tr>
                                        )}
                                        <tr>
                                            <td className="text-gray-500 pr-3 py-0.5">Coordinates:</td>
                                            <td className="font-mono text-xs text-gray-600">
                                                {selectedSite.latitude.toFixed(6)}, {selectedSite.longitude.toFixed(6)}
                                            </td>
                                        </tr>
                                    </tbody>
                                </table>
                                <div className="mt-3 pt-2 border-t border-gray-200 flex gap-2">
                                    <a
                                        href={`https://www.google.com/maps?q=${selectedSite.latitude},${selectedSite.longitude}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 px-3 py-1.5 bg-blue-500 text-white text-xs font-medium rounded hover:bg-blue-600 transition-colors"
                                    >
                                        Open in Maps
                                    </a>
                                    <button
                                        onClick={() => {
                                            setSelectedSiteId(selectedSite.site_id);
                                            setSelectedSite(null);
                                        }}
                                        className="inline-flex items-center gap-1 px-3 py-1.5 bg-green-500 text-white text-xs font-medium rounded hover:bg-green-600 transition-colors"
                                    >
                                        Use as Destination
                                    </button>
                                </div>
                            </div>
                        </InfoWindow>
                    )}
                </GoogleMap>
            </div>
        </div>
    );
}
