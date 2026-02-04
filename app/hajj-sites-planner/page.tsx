import Link from "next/link";
import HajjSitesPlanner from "../components/HajjSitesPlanner";

export default function HajjSitesPlannerPage() {
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
            className="block w-full text-left px-3 py-2 rounded-md transition text-slate-300 hover:bg-slate-800 hover:text-white"
          >
            Route Planner (Google)
          </Link>
          <Link
            href="/hajj-sites-planner"
            className="block w-full text-left px-3 py-2 rounded-md transition bg-slate-700 text-white"
          >
            Hajj Sites Planner
          </Link>
        </nav>
        <div className="px-4 py-3 border-t border-slate-800 text-xs text-slate-500">
          <div>Data source: Supabase</div>
          <div className="mt-1 text-slate-400">Hajj Sites Planner</div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 px-4 py-6 overflow-auto">
        <div className="max-w-6xl mx-auto space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold">Hajj Sites Planner</h2>
            <Link
              href="/"
              className="text-xs text-blue-600 hover:text-blue-800 hover:underline"
            >
              Back to Dashboard
            </Link>
          </div>
          <HajjSitesPlanner />
        </div>
      </main>
    </div>
  );
}
