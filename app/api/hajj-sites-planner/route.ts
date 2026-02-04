import { NextRequest, NextResponse } from "next/server";
import { supabase, isSupabaseConfigured } from "../../../lib/supabaseClient";

const TABLE_NAME = "hajj_sites_planner";
const BATCH_SIZE = 500;

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

function normalizeRow(row: Record<string, unknown>): HajjSiteRow | null {
  const normalized: HajjSiteRow = {};

  for (const column of REQUIRED_COLUMNS) {
    const value = row[column];
    normalized[column] = value == null ? null : (value as string | number);
  }

  const lat = parseCoordinate(normalized["Latitude"]);
  const lng = parseCoordinate(normalized["Longitude"]);

  if (lat == null || lng == null) {
    return null;
  }

  normalized["Latitude"] = lat;
  normalized["Longitude"] = lng;

  return normalized;
}

export async function POST(request: NextRequest) {
  try {
    if (!isSupabaseConfigured) {
      return NextResponse.json(
        { ok: false, error: "Supabase is not configured" },
        { status: 200 }
      );
    }

    const body = await request.json();
    const rows = body?.rows;

    if (!Array.isArray(rows)) {
      return NextResponse.json(
        { ok: false, error: "Invalid payload: rows array is required" },
        { status: 200 }
      );
    }

    const normalizedRows: HajjSiteRow[] = [];
    let skipped = 0;

    for (const row of rows) {
      if (!row || typeof row !== "object") {
        skipped += 1;
        continue;
      }

      const normalized = normalizeRow(row as Record<string, unknown>);
      if (!normalized) {
        skipped += 1;
        continue;
      }

      normalizedRows.push(normalized);
    }

    if (normalizedRows.length === 0) {
      return NextResponse.json(
        { ok: false, error: "No valid rows to insert" },
        { status: 200 }
      );
    }

    // Requires a SQL function in Supabase named truncate_hajj_sites_planner
    const { error: truncateError } = await supabase.rpc("truncate_hajj_sites_planner");
    if (truncateError) {
      return NextResponse.json(
        {
          ok: false,
          error: "Failed to truncate hajj_sites_planner",
          detail: truncateError.message,
        },
        { status: 200 }
      );
    }

    const batchSizes: number[] = [];

    for (let i = 0; i < normalizedRows.length; i += BATCH_SIZE) {
      const batch = normalizedRows.slice(i, i + BATCH_SIZE);
      const { error: insertError } = await supabase
        .from(TABLE_NAME)
        .insert(batch, { returning: "minimal" });

      if (insertError) {
        return NextResponse.json(
          {
            ok: false,
            error: "Insert failed",
            detail: insertError.message,
            batch: Math.floor(i / BATCH_SIZE) + 1,
          },
          { status: 200 }
        );
      }

      batchSizes.push(batch.length);
    }

    return NextResponse.json({
      ok: true,
      inserted: normalizedRows.length,
      skipped,
      batchSize: BATCH_SIZE,
      batchSizes,
    });
  } catch (error) {
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
