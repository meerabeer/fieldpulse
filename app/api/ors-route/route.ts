import { NextRequest, NextResponse } from "next/server";

/**
 * API Route: /api/ors-route
 * 
 * Proxies routing requests to the ORS backend with enhanced options:
 * - Increased maximum_search_radius (5000m / 5km) so off-road sites can still get routes
 * - Returns { ok: true, route: <data> } on success
 * - Returns { ok: false, orsStatus, orsError } on failure (with 200 status for graceful handling)
 * 
 * We use POST to the /route_post endpoint which supports the full ORS options including
 * maximum_search_radius.
 */

const ORS_BACKEND_URL = process.env.NEXT_PUBLIC_ORS_BACKEND_URL || "https://meerabeer1990-nfo-ors-backend.hf.space";

// Increased search radius to handle off-road sites (default is 350m, we use 5km)
const MAXIMUM_SEARCH_RADIUS = 5000;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { coordinates, profile = "driving-car" } = body;

    // Validate coordinates
    if (!coordinates || !Array.isArray(coordinates) || coordinates.length < 2) {
      return NextResponse.json(
        { ok: false, error: "Invalid coordinates: need at least 2 waypoints" },
        { status: 200 }
      );
    }

    // Log the incoming request for debugging
    console.log("ORS API route - incoming request:", {
      coordinates,
      profile,
      searchRadius: MAXIMUM_SEARCH_RADIUS,
    });

    // For multi-waypoint routes, make sequential leg requests
    let totalDistanceMeters = 0;
    let totalDurationSeconds = 0;
    let allCoordinates: [number, number][] = [];

    for (let i = 0; i < coordinates.length - 1; i++) {
      const startCoord = coordinates[i];
      const endCoord = coordinates[i + 1];

      // Build the ORS request body with options.maximum_search_radius
      // This is the proper ORS API format for POST requests
      const orsRequestBody = {
        coordinates: [startCoord, endCoord],
        profile,
        preference: "fastest",
        instructions: false,
        options: {
          maximum_search_radius: MAXIMUM_SEARCH_RADIUS,
        },
      };

      // Log the exact body we're sending to ORS
      console.log(`ORS request body (leg ${i + 1}):`, JSON.stringify(orsRequestBody, null, 2));

      // Use POST to the /route_post endpoint which supports options
      const url = `${ORS_BACKEND_URL}/route_post`;
      console.log(`ORS API route - leg ${i + 1} URL:`, url);

      const orsRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(orsRequestBody),
      });

      const orsText = await orsRes.text();
      console.log(`ORS API route - leg ${i + 1} status:`, orsRes.status, "body:", orsText.substring(0, 500));

      if (!orsRes.ok) {
        // ORS failed - return graceful error response (200 OK with ok: false)
        console.error("ORS error for leg", i + 1, ":", orsRes.status, orsText);
        return NextResponse.json(
          {
            ok: false,
            orsStatus: orsRes.status,
            orsError: orsText,
            failedLeg: i + 1,
            coordinates: { start: startCoord, end: endCoord },
          },
          { status: 200 }
        );
      }

      let orsData;
      try {
        orsData = JSON.parse(orsText);
      } catch {
        console.error("ORS JSON parse error:", orsText);
        return NextResponse.json(
          { ok: false, error: "Invalid JSON from ORS", orsText },
          { status: 200 }
        );
      }

      const feature = orsData.features?.[0];
      if (!feature) {
        console.error("ORS no feature in response:", orsData);
        return NextResponse.json(
          { ok: false, error: "No route feature in ORS response", orsData },
          { status: 200 }
        );
      }

      const legCoordinates = (feature.geometry?.coordinates as [number, number][]) || [];
      const summary = feature.properties?.summary;
      const distanceMeters = summary?.distance ?? 0;
      const durationSeconds = summary?.duration ?? 0;

      totalDistanceMeters += distanceMeters;
      totalDurationSeconds += durationSeconds;

      // Append coordinates (skip first point on subsequent legs to avoid duplicates)
      if (i === 0) {
        allCoordinates = [...legCoordinates];
      } else {
        allCoordinates = [...allCoordinates, ...legCoordinates.slice(1)];
      }
    }

    // Success - return the combined route
    return NextResponse.json({
      ok: true,
      route: {
        coordinates: allCoordinates,
        distanceMeters: totalDistanceMeters,
        durationSeconds: totalDurationSeconds,
      },
    });
  } catch (error) {
    console.error("ORS API route exception:", error);
    return NextResponse.json(
      {
        ok: false,
        error: "Server exception",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 200 }
    );
  }
}
