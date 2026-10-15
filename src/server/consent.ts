/**
 * Whether a message may leave for this patient.
 *
 * ## Consent records are evidence, not a gate
 *
 * A `ConsentRecord` — `WHATSAPP_MESSAGING` included — is still written at
 * enrollment and still shown on the patient screen: it is what the pharmacy can
 * produce to say what the patient agreed to and when. It is **not consulted
 * before sending.** A patient with no record, or with one whose `revokedAt` is
 * set, is messaged exactly like any other. That is deliberate: a recorded
 * approval is not a precondition for a reminder.
 *
 * ## What does stop a send
 *
 * Two facts, and neither is an approval:
 *
 *   - `messagingOptOutAt` — the patient themselves asked us to stop. It is a
 *     live instruction from them rather than a record we hold about them, it
 *     arrives out of band (`recordOptOut`), and honouring it is what keeps the
 *     number sendable at all: Meta's quality rating is driven by recipients
 *     blocking and reporting, and an ignored STOP reply produces both.
 *   - a patient who is not `ACTIVE` — an archived or paused patient has no care
 *     relationship left to remind. That is a scheduling fact, not consent.
 *
 * ## Where it runs
 *
 * At SEND time, inside the pre-send transaction. A patient can opt out between
 * the reminder being materialized and the reminder being sent, and the send must
 * lose. See `claimDueReminders`.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any;

export type MessagingCheck = {
  allowed: boolean;
  /** Machine-readable cause, stored as the reminder's `cancelReason`. */
  reason?: "OPTED_OUT" | "PATIENT_NOT_ACTIVE";
};

/**
 * Whether we may send a messaging reminder to this patient right now.
 */
export async function checkMessagingAllowed(
  tx: Tx,
  patientId: string,
): Promise<MessagingCheck> {
  const patient = await tx.patient.findUnique({
    where: { id: patientId },
    select: { status: true, messagingOptOutAt: true },
  });

  if (!patient) return { allowed: false, reason: "PATIENT_NOT_ACTIVE" };
  if (patient.messagingOptOutAt) return { allowed: false, reason: "OPTED_OUT" };
  if (patient.status !== "ACTIVE") return { allowed: false, reason: "PATIENT_NOT_ACTIVE" };

  return { allowed: true };
}
