import { type NextRequest, NextResponse } from "next/server";
import { systemPrisma } from "@/server/db";
import { upsertTimingRule, type TimingRuleInput } from "@/server/ddi/timing";

export async function GET(_req: NextRequest) {
  try {
    const rules = await systemPrisma.ddiTimingRule.findMany({
      include: {
        ingredientA: true,
        ingredientB: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({
      ok: true,
      data: rules,
      total: rules.length,
    });
  } catch (error) {
    console.error("GET /api/clinical/ddi/timing-rules error:", error);
    return NextResponse.json(
      { ok: false, error: "TIMING_RULES_FETCH_ERROR", message: (error as Error).message },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as TimingRuleInput;

    if (!body.ingredientAId || !body.ingredientBId || !body.minIntervalHours || !body.clinicalReference) {
      return NextResponse.json(
        {
          ok: false,
          error: "MISSING_REQUIRED_FIELDS",
          message: "ingredientAId, ingredientBId, minIntervalHours, and clinicalReference are required.",
        },
        { status: 400 },
      );
    }

    const rule = await upsertTimingRule(body);

    return NextResponse.json({
      ok: true,
      data: rule,
    });
  } catch (error) {
    console.error("POST /api/clinical/ddi/timing-rules error:", error);
    return NextResponse.json(
      { ok: false, error: "TIMING_RULE_UPSERT_ERROR", message: (error as Error).message },
      { status: 500 },
    );
  }
}
