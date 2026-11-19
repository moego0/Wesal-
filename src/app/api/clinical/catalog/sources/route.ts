import { type NextRequest, NextResponse } from "next/server";
import { getCatalogSources } from "@/server/catalog/search";

export async function GET(_req: NextRequest) {
  try {
    const sources = await getCatalogSources();

    return NextResponse.json({
      ok: true,
      data: sources,
      total: sources.length,
    });
  } catch (error) {
    console.error("GET /api/clinical/catalog/sources error:", error);
    return NextResponse.json(
      { ok: false, error: "CATALOG_SOURCES_ERROR", message: (error as Error).message },
      { status: 500 },
    );
  }
}
