"use client";

import dynamic from "next/dynamic";
import { type NfoStatusRow } from "../lib/nfoHelpers";

type NfoRoutesViewProps = {
  nfos: NfoStatusRow[];
};

const NfoRoutesViewInner = dynamic(() => import("./NfoRoutesViewInner"), {
  ssr: false, // critical: do NOT render leaflet on server
  loading: () => (
    <div className="space-y-4">
      <div className="bg-white rounded-lg shadow p-4">
        <h2 className="text-lg font-bold mb-4 text-slate-900">NFO Route Planning</h2>
        <p className="text-slate-500">Loading routes component…</p>
      </div>
    </div>
  ),
});

export default function NfoRoutesView(props: NfoRoutesViewProps) {
  return <NfoRoutesViewInner {...props} />;
}
