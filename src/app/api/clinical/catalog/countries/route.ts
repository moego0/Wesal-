import { type NextRequest, NextResponse } from "next/server";
import { getCatalogCountries } from "@/server/catalog/search";

export async function GET(_req: NextRequest) {
  try {
    const countries = await getCatalogCountries();

    return NextResponse.json({
      ok: true,
      data: countries,
      total: countries.length,
    });
  } catch (error) {
    console.error("GET /api/clinical/catalog/countries error:", error);
    return NextResponse.json(
      { ok: false, error: "CATALOG_COUNTRIES_ERROR", message: (error as Error).message },
      { status: 500 },
    );
  }
}
