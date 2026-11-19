import { systemPrisma } from "@/server/db";

export interface ReviewSubmission {
  interactionId: string;
  reviewerUserId: string;
  reviewerRole: "PHARMACIST" | "PHYSICIAN";
  decision: "APPROVED" | "REJECTED" | "MODIFIED" | "NEEDS_MORE_EVIDENCE";
  adjustedSeverity?: "MAJOR" | "MODERATE" | "MINOR" | "UNKNOWN";
  adjustedManagement?: string;
  clinicalNotes: string;
}

/**
 * Submit clinical review by a pharmacist or physician for a drug interaction.
 * Transitions interaction state from IMPORTED_UNREVIEWED to CLINICALLY_APPROVED, REJECTED, etc.
 */
export async function submitDdiReview(submission: ReviewSubmission) {
  const interaction = await systemPrisma.ddiInteraction.findUnique({
    where: { id: submission.interactionId },
  });

  if (!interaction) {
    throw new Error(`Interaction with ID '${submission.interactionId}' not found.`);
  }

  // Create review audit row
  const review = await systemPrisma.ddiReview.create({
    data: {
      interactionId: submission.interactionId,
      reviewerUserId: submission.reviewerUserId,
      reviewerRole: submission.reviewerRole,
      decision: submission.decision,
      adjustedSeverity: submission.adjustedSeverity || null,
      adjustedManagement: submission.adjustedManagement || null,
      clinicalNotes: submission.clinicalNotes,
    },
  });

  // Transition clinical approval state based on decision
  let nextState: "CLINICALLY_APPROVED" | "REJECTED" | "FLAGGED_FOR_REVIEW" | "IMPORTED_UNREVIEWED";

  switch (submission.decision) {
    case "APPROVED":
      nextState = "CLINICALLY_APPROVED";
      break;
    case "MODIFIED":
      nextState = "CLINICALLY_APPROVED";
      break;
    case "REJECTED":
      nextState = "REJECTED";
      break;
    case "NEEDS_MORE_EVIDENCE":
      nextState = "FLAGGED_FOR_REVIEW";
      break;
    default:
      nextState = "IMPORTED_UNREVIEWED";
  }

  const updatedInteraction = await systemPrisma.ddiInteraction.update({
    where: { id: submission.interactionId },
    data: {
      clinicalApprovalState: nextState,
      severity: submission.adjustedSeverity || interaction.severity,
      management: submission.adjustedManagement || interaction.management,
    },
    include: {
      ingredientA: true,
      ingredientB: true,
      reviews: true,
    },
  });

  return {
    review,
    interaction: updatedInteraction,
  };
}

/**
 * Retrieve interactions pending clinical review.
 */
export async function getPendingReviews(limit = 50) {
  return systemPrisma.ddiInteraction.findMany({
    where: {
      clinicalApprovalState: {
        in: ["IMPORTED_UNREVIEWED", "FLAGGED_FOR_REVIEW"],
      },
    },
    take: limit,
    include: {
      ingredientA: true,
      ingredientB: true,
      reviews: true,
    },
    orderBy: [{ severity: "asc" }, { createdAt: "desc" }],
  });
}
