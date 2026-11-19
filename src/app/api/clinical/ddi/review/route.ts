import { type NextRequest, NextResponse } from "next/server";
import { submitDdiReview, getPendingReviews, type ReviewSubmission } from "@/server/ddi/reviews";

export async function GET(_req: NextRequest) {
  try {
    const pending = await getPendingReviews(50);
    return NextResponse.json({ ok: true, data: pending, total: pending.length });
  } catch (error) {
    console.error("GET /api/clinical/ddi/review error:", error);
    return NextResponse.json(
      { ok: false, error: "DDI_REVIEW_FETCH_ERROR", message: (error as Error).message },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ReviewSubmission;

    if (!body.interactionId || !body.reviewerUserId || !body.reviewerRole || !body.decision || !body.clinicalNotes) {
      return NextResponse.json(
        {
          ok: false,
          error: "MISSING_REQUIRED_FIELDS",
          message: "interactionId, reviewerUserId, reviewerRole, decision, and clinicalNotes are required.",
        },
        { status: 400 },
      );
    }

    const result = await submitDdiReview(body);

    return NextResponse.json({
      ok: true,
      data: result,
    });
  } catch (error) {
    console.error("POST /api/clinical/ddi/review error:", error);
    return NextResponse.json(
      { ok: false, error: "DDI_REVIEW_SUBMISSION_ERROR", message: (error as Error).message },
      { status: 500 },
    );
  }
}
