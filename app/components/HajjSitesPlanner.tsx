"use client";

import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import dynamic from "next/dynamic";
import * as XLSX from "xlsx";
import { supabase } from "../../lib/supabaseClient";

const TABLE_NAME = "hajj_sites_planner";

const REQUIRED_COLUMNS = [
  "Site ID",
  "Name",
  "FE ID",
  "Technology",
  "Latitude",
  "Longitude",
  "Location",
  "Area",
  "ON/OFF_Season-26",
  "VIP_Category",
  "Site_Type_Category",
  "Project_Scope_2026",
  "Survey_Priority",
  "Access_Status",
  "Survey_Plan_Date",
  "Survey_date",
  "Survey_Status",
  "Survey_NFO",
  "PMR_NFO",
  "Plan_Date",
  "PMR_Status",
  "Done_By",
  "PMR_LAN_status ",
  "RF_Audit",
  "Blower_Status",
  "Blower_Date",
  "Blower_LAN_status ",
  "EM_Feedback",
  "NFO_Feeback",
  "Site_Operational_Status",
  "Main_root_cause",
  "Remarks",
  "MDB_Door_Status",
  "TRM_Type",
  "RBS_Type",
  "TRM_Enclosure",
  "Wi-Fi_Enclosure",
  "Design",
  "Installed",
  "Working",
  "Not_Working",
  "Missing",
  "Required",
  "Modules_Status",
  "Rectifier_Data",
  "Reftifier_Status",
] as const;

type HajjSiteRow = Record<string, string | number | null>;

type UploadResponse = {
  ok: boolean;
  inserted?: number;
  skipped?: number;
  batchSize?: number;
  batchSizes?: number[];
  error?: string;
  detail?: string;
};

const HajjSitesPlannerMap = dynamic(() => import("./HajjSitesPlannerMap"), {
  ssr: false,
  loading: () => (
    <div className="h-[600px] w-full rounded-xl border border-slate-200 flex items-center justify-center bg-slate-50">
      <p className="text-slate-500">Loading map...</p>
    </div>
  ),
});

function parseCoordinate(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeDateForPostgres(value: unknown): string | null {
  if (value == null) return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const date = new Date(Date.UTC(1899, 11, 30) + value * 86400 * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;

    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      const serial = Number.parseFloat(trimmed);
      if (!Number.isFinite(serial)) return null;
      const date = new Date(Date.UTC(1899, 11, 30) + serial * 86400 * 1000);
      return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
    }

    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) return null;
    return new Date(parsed).toISOString().slice(0, 10);
  }

  return null;
}

export default function HajjSitesPlanner() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [statusLines, setStatusLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isLoadingSites, setIsLoadingSites] = useState(false);
  const [sites, setSites] = useState<HajjSiteRow[]>([]);

  const appendStatus = useCallback((line: string) => {
    setStatusLines((prev) => [...prev, line]);
  }, []);

  const loadSites = useCallback(async () => {
    setIsLoadingSites(true);
    setError(null);

    const { data, error: fetchError } = await supabase
      .from(TABLE_NAME)
      .select("*");

    if (fetchError) {
      setError(fetchError.message);
      setSites([]);
      setIsLoadingSites(false);
      return;
    }

    setSites((data ?? []) as HajjSiteRow[]);
    setIsLoadingSites(false);
  }, []);

  useEffect(() => {
    void loadSites();
  }, [loadSites]);

  const handleFileChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setSelectedFile(file);
    setError(null);
    setStatusLines([]);
  }, []);

  const handleUpload = useCallback(async () => {
    setError(null);
    setStatusLines([]);

    if (!selectedFile) {
      setError("Please select an .xlsx file first.");
      return;
    }

    if (!selectedFile.name.toLowerCase().endsWith(".xlsx")) {
      setError("Only .xlsx files are supported.");
      return;
    }

    setIsUploading(true);
    setStatusLines(["Parsing Excel file..."]);

    try {
      const arrayBuffer = await selectedFile.arrayBuffer();
      const workbook = XLSX.read(arrayBuffer, { type: "array" });
      const sheetName = workbook.SheetNames[0];

      if (!sheetName) {
        throw new Error("No sheets found in the Excel file.");
      }

      const sheet = workbook.Sheets[sheetName];
      if (!sheet) {
        throw new Error("Unable to read the first sheet.");
      }

      const headerRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
      const header = (headerRows[0] ?? []).map((value) => String(value ?? ""));
      const missingHeaders = REQUIRED_COLUMNS.filter((column) => !header.includes(column));

      if (missingHeaders.length > 0) {
        throw new Error(`Missing required columns: ${missingHeaders.join(", ")}`);
      }

      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });
      appendStatus(`Parsed ${rawRows.length} rows from sheet "${sheetName}".`);

      const normalizedRows: HajjSiteRow[] = [];
      let skipped = 0;

      for (const row of rawRows) {
        const normalized: HajjSiteRow = {};

        for (const column of REQUIRED_COLUMNS) {
          const value = row[column];
          normalized[column] = value == null ? null : (value as string | number);
        }

        const lat = parseCoordinate(normalized["Latitude"]);
        const lng = parseCoordinate(normalized["Longitude"]);

        if (lat == null || lng == null) {
          skipped += 1;
          continue;
        }

        normalized["Survey_Plan_Date"] = normalizeDateForPostgres(normalized["Survey_Plan_Date"]);
        normalized["Survey_date"] = normalizeDateForPostgres(normalized["Survey_date"]);
        normalized["Plan_Date"] = normalizeDateForPostgres(normalized["Plan_Date"]);
        normalized["Blower_Date"] = normalizeDateForPostgres(normalized["Blower_Date"]);

        normalized["Latitude"] = lat;
        normalized["Longitude"] = lng;
        normalizedRows.push(normalized);
      }

      if (normalizedRows.length === 0) {
        throw new Error("No valid rows found with latitude/longitude values.");
      }

      appendStatus(`Valid rows with coordinates: ${normalizedRows.length}. Skipped: ${skipped}.`);
      appendStatus("Truncating table and inserting rows...");

      const response = await fetch("/api/hajj-sites-planner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: normalizedRows }),
      });

      const payload = (await response.json()) as UploadResponse;

      if (!payload.ok) {
        const detail = payload.detail ? ` ${payload.detail}` : "";
        throw new Error(`${payload.error ?? "Upload failed."}${detail}`);
      }

      appendStatus("Table truncated.");

      if (payload.batchSizes && payload.batchSizes.length > 0) {
        payload.batchSizes.forEach((size, index) => {
          appendStatus(`Inserted batch ${index + 1}/${payload.batchSizes!.length} (${size} rows).`);
        });
      } else if (payload.inserted != null) {
        appendStatus(`Inserted ${payload.inserted} rows.`);
      }

      if (payload.skipped) {
        appendStatus(`Server skipped ${payload.skipped} rows due to invalid coordinates.`);
      }

      await loadSites();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setIsUploading(false);
    }
  }, [appendStatus, loadSites, selectedFile]);

  return (
    <div className="space-y-6">
      <section className="bg-white rounded-xl shadow p-6">
        <h2 className="text-lg font-semibold mb-2">Upload Excel</h2>
        <p className="text-sm text-slate-500 mb-4">
          Upload a .xlsx file to overwrite the <span className="font-mono">hajj_sites_planner</span> table.
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <input
            type="file"
            accept=".xlsx"
            onChange={handleFileChange}
            className="text-sm"
          />
          <button
            onClick={handleUpload}
            disabled={!selectedFile || isUploading}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed transition"
          >
            {isUploading ? "Uploading..." : "Upload & Overwrite"}
          </button>
        </div>

        {selectedFile && (
          <div className="mt-3 text-xs text-slate-500">
            Selected file: <span className="font-medium text-slate-700">{selectedFile.name}</span>
          </div>
        )}

        {error && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            {error}
          </div>
        )}

        {statusLines.length > 0 && (
          <div className="mt-4 p-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700">
            <div className="font-medium mb-2">Status</div>
            <ul className="list-disc pl-5 space-y-1">
              {statusLines.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="bg-white rounded-xl shadow p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-semibold">Hajj Sites Map</h3>
          <span className="text-xs text-slate-500">
            {isLoadingSites ? "Loading sites..." : `${sites.length} rows loaded`}
          </span>
        </div>

        {sites.length === 0 && !isLoadingSites && (
          <div className="mb-3 text-sm text-slate-500">
            No rows found in hajj_sites_planner.
          </div>
        )}
        <HajjSitesPlannerMap sites={sites} />
      </section>
    </div>
  );
}
