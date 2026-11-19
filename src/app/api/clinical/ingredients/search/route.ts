import { type NextRequest, NextResponse } from "next/server";
import { searchIngredients } from "@/server/catalog/search";

export async function GET(req: NextRequest) {
  try {
    const searchParams = req.nextUrl.searchParams;
    const q = searchParams.get("q") ?? undefined;
    const limit = searchParams.get("limit") ? Number(searchParams.get("limit")) : 20;

    const items = await searchIngredients(q, limit);

    return NextResponse.json({
      ok: true,
      data: items,
      total: items.length,
    });
  } catch (error) {
    console.error("GET /api/clinical/ingredients/search error:", error);
    return NextResponse.json(
      { ok: false, error: "INGREDIENT_SEARCH_ERROR", message: (error as Error).message },
      { status: 500 },
    );
  }
}
