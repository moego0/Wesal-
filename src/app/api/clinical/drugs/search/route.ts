import { type NextRequest, NextResponse } from "next/server";
import { searchDrugProducts } from "@/server/catalog/search";

export async function GET(req: NextRequest) {
  try {
    const searchParams = req.nextUrl.searchParams;
    const q = searchParams.get("q") ?? undefined;
    const country = searchParams.get("country") ?? undefined;
    const dosageForm = searchParams.get("dosageForm") ?? undefined;
    const strength = searchParams.get("strength") ?? undefined;
    const verificationState = searchParams.get("verificationState") ?? undefined;
    const limit = searchParams.get("limit") ? Number(searchParams.get("limit")) : undefined;
    const offset = searchParams.get("offset") ? Number(searchParams.get("offset")) : undefined;

    const result = await searchDrugProducts({
      q,
      country,
      dosageForm,
      strength,
      verificationState,
      limit,
      offset,
    });

    return NextResponse.json({
      ok: true,
      data: result.items,
      pagination: {
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      },
    });
  } catch (error) {
    console.error("GET /api/clinical/drugs/search error:", error);
    return NextResponse.json(
      { ok: false, error: "CATALOG_SEARCH_ERROR", message: (error as Error).message },
      { status: 500 },
    );
  }
}
