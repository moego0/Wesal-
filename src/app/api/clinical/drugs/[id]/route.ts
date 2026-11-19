import { type NextRequest, NextResponse } from "next/server";
import { getDrugProductById } from "@/server/catalog/search";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    if (!id || !id.trim()) {
      return NextResponse.json(
        { ok: false, error: "INVALID_DRUG_ID", message: "Drug ID is required." },
        { status: 400 },
      );
    }

    const drug = await getDrugProductById(id.trim());

    if (!drug) {
      return NextResponse.json(
        { ok: false, error: "DRUG_NOT_FOUND", message: `Drug with ID '${id}' was not found.` },
        { status: 404 },
      );
    }

    return NextResponse.json({
      ok: true,
      data: drug,
    });
  } catch (error) {
    console.error("GET /api/clinical/drugs/[id] error:", error);
    return NextResponse.json(
      { ok: false, error: "CATALOG_FETCH_ERROR", message: (error as Error).message },
      { status: 500 },
    );
  }
}
