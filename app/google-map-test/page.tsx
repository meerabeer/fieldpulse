"use client";

import Link from "next/link";
import { Suspense } from "react";
import GoogleMapTest from "../components/GoogleMapTest";

/**
 * Standalone page for Google Maps Route Planner
 * Route: /google-map-test
 * 
 * Features:
 * - Select NFO, Warehouse (optional), and Site
 * - Calculate driving route and ETA using Google Directions API
 * - View all sites on the map
 * - URL state persistence (selections preserved when navigating away)
 * 
 * Security Notes:
 * - The API key should be restricted in Google Cloud Console:
 *   1. HTTP referrers: Add your domains (localhost:3000/*, your-app.vercel.app/*)
 *   2. API restrictions: Enable "Maps JavaScript API" and "Routes API"
 * - Never commit .env.local or expose the key in logs
 */

// Loading component for Suspense
function LoadingFallback() {
    return (
        <div className="flex items-center justify-center h-64">
            <div className="text-slate-500">Loading route planner...</div>
        </div>
    );
}
export default function GoogleMapTestPage() {
    return (
        <div className="min-h-screen bg-slate-50 flex">
            {/* Sidebar */}
            <aside className="w-64 bg-slate-900 text-slate-100 flex flex-col">
                <div className="px-4 py-4 border-b border-slate-800">
                    <h1 className="text-lg font-semibold">NFO Manager</h1>
                    <p className="text-xs text-slate-400">Web console</p>
                </div>
                <nav className="flex-1 px-2 py-4 space-y-1 text-sm">
                    <Link
                        href="/"
                        className="block w-full text-left px-3 py-2 rounded-md transition text-slate-300 hover:bg-slate-800 hover:text-white"
                    >
                        Dashboard
                    </Link>
                    <Link
                        href="/?view=map"
                        className="block w-full text-left px-3 py-2 rounded-md transition text-slate-300 hover:bg-slate-800 hover:text-white"
                    >
                        Live map
                    </Link>
                    <Link
                        href="/?view=routePlanner"
                        className="block w-full text-left px-3 py-2 rounded-md transition text-slate-300 hover:bg-slate-800 hover:text-white"
                    >
                        Route Planner (ORS)
                    </Link>
                    <Link
                        href="/?view=clusterPlanner"
                        className="block w-full text-left px-3 py-2 rounded-md transition text-slate-300 hover:bg-slate-800 hover:text-white"
                    >
                        Cluster Planner
                    </Link>
                    <Link
                        href="/google-map-test"
                        className="block w-full text-left px-3 py-2 rounded-md transition bg-slate-700 text-white"
                    >
                        Route Planner (Google)
                    </Link>
                    <Link
                        href="/hajj-sites-planner"
                        className="block w-full text-left px-3 py-2 rounded-md transition text-slate-300 hover:bg-slate-800 hover:text-white"
                    >
                        Hajj Sites Planner
                    </Link>
                </nav>
                <div className="px-4 py-3 border-t border-slate-800 text-xs text-slate-500">
                    <div>Data source: Supabase</div>
                    <div className="mt-1 text-slate-400">
                        Google Maps & Directions API
                    </div>
                </div>
            </aside>

            {/* Main content */}
            <main className="flex-1 px-4 py-6 overflow-auto">
                <div className="max-w-full mx-auto space-y-4">
                    <div className="flex items-center justify-between">
                        <h2 className="text-xl font-semibold">Route Planner (Google)</h2>
                        <div className="flex items-center gap-4">
                            <p className="text-xs text-slate-500">
                                Calculate driving routes using Google Directions API
                            </p>
                            <Link
                                href="/"
                                className="text-xs text-blue-600 hover:text-blue-800 hover:underline"
                            >
                                ← Back to Dashboard
                            </Link>
                        </div>
                    </div>
                    <Suspense fallback={<LoadingFallback />}>
                        <GoogleMapTest />
                    </Suspense>
                </div>
            </main>
        </div>
    );
}
