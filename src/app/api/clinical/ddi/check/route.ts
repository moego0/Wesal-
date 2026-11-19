import { type NextRequest, NextResponse } from "next/server";
import { evaluateMedicationInteractions, type DrugInput } from "@/server/ddi/engine";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { medications?: DrugInput[] };

    if (!body.medications || !Array.isArray(body.medications) || body.medications.length === 0) {
      return NextResponse.json(
        { ok: false, error: "INVALID_MEDICATION_LIST", message: "A list of at least one medication is required." },
        { status: 400 },
      );
    }

    const report = await evaluateMedicationInteractions(body.medications);

    return NextResponse.json({
      ok: true,
      data: report,
    });
  } catch (error) {
    console.error("POST /api/clinical/ddi/check error:", error);
    return NextResponse.json(
      { ok: false, error: "DDI_EVALUATION_ERROR", message: (error as Error).message },
      { status: 500 },
    );
  }
}
