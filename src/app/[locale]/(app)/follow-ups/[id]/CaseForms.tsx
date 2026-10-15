"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { enumKey } from "@/components/status";
import {
  Field,
  FormActions,
  Notice,
  buttonClass,
  inputClass,
  selectClass,
  textareaClass,
} from "@/components/ui";
import {
  InterventionOutcome,
  InterventionType,
  type CaseStatus,
} from "@/generated/prisma/enums";
import {
  changeCaseStatus,
  recordIntervention,
  type CaseActionErrorCode,
  type CaseActionState,
} from "@/server/followup/actions";

/**
 * The two forms on a case: recording what the pharmacist did, and moving the case
 * without recording a contact.
 *
 * They are client components because `useActionState` and `useFormStatus` are
 * hooks, and the screens around them are server components. Nothing clinical is
 * decided here: the option lists and the permitted status moves are computed on
 * the server and passed in, and both actions re-check everything they are sent —
 * this component is a convenient way to submit a request that a stranger could
 * post by hand.
 *
 * The enums come from the generated Prisma module rather than from hand-written
 * arrays, so a new `InterventionType` appears in the dropdown the moment it
 * exists in the schema. It would appear unlabelled, which
 * `tests/i18n.coverage.test.ts` catches.
 */

const INTERVENTION_TYPES = Object.values(InterventionType);
const INTERVENTION_OUTCOMES = Object.values(InterventionOutcome);

/** Error code → the catalog key that says it in the reader's language. */
const ERROR_MESSAGE_KEY: Record<CaseActionErrorCode, string> = {
  NOT_FOUND: "errorNotFound",
  INVALID_INPUT: "errorInvalidInput",
  ILLEGAL_TRANSITION: "errorIllegalTransition",
  FORBIDDEN: "errorForbidden",
  FAILED: "errorFailed",
};

const IDLE: CaseActionState = { kind: "idle" };

export function RecordInterventionForm({
  caseId,
  locale,
  nextStatusOptions,
}: {
  caseId: string;
  locale: string;
  /** Only the moves the action will accept, from the shared transition table. */
  nextStatusOptions: CaseStatus[];
}) {
  const t = useTranslations("caseDetail");
  const tType = useTranslations("caseDetail.interventionType");
  const tOutcome = useTranslations("caseDetail.interventionOutcome");
  const tEnums = useTranslations("enums");

  const [state, formAction] = useActionState(recordIntervention, IDLE);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="caseId" value={caseId} />
      {/* The action cannot see the URL it was posted from, and a rejected
          submission has to come back in the language it was written in. */}
      <input type="hidden" name="locale" value={locale} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("typeLabel")} required>
          <select
            name="interventionType"
            className={selectClass}
            defaultValue=""
            required
          >
            <option value="" disabled>
              {t("selectPlaceholder")}
            </option>
            {INTERVENTION_TYPES.map((value) => (
              <option key={value} value={value}>
                {tType(value)}
              </option>
            ))}
          </select>
        </Field>

        {/* No default outcome. "Reached" is the commonest answer and so the worst
            one to preselect: a call nobody picked up would be recorded as a
            conversation because the form filled itself in. */}
        <Field label={t("outcomeLabel")} required>
          <select name="outcome" className={selectClass} defaultValue="" required>
            <option value="" disabled>
              {t("selectPlaceholder")}
            </option>
            {INTERVENTION_OUTCOMES.map((value) => (
              <option key={value} value={value}>
                {tOutcome(value)}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label={t("notesLabel")}>
        <textarea
          name="notes"
          rows={3}
          maxLength={2000}
          className={textareaClass}
          placeholder={t("notesPlaceholder")}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("nextFollowUp")} hint={t("nextFollowUpHint")}>
          {/* A date is a numeric run: without `dir="ltr"` the digits of
              `2026-11-03` reorder against an RTL paragraph. */}
          <input type="date" name="nextFollowUpDate" dir="ltr" className={inputClass} />
        </Field>

        <Field label={t("statusChange")}>
          <select name="nextStatus" className={selectClass} defaultValue="">
            <option value="">{t("keepStatus")}</option>
            {nextStatusOptions.map((value) => (
              <option key={value} value={value}>
                {tEnums(enumKey.caseStatus(value))}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <FormResult
        state={state}
        successText={t("recorded")}
        errorText={rejectionText(
          state,
          (values) => t("errorIllegalTransition", values),
          tEnums,
          t,
        )}
      />

      <FormActions>
        <SubmitButton label={t("submit")} pendingLabel={t("pending")} />
      </FormActions>
    </form>
  );
}

export function ChangeStatusForm({
  caseId,
  locale,
  options,
}: {
  caseId: string;
  locale: string;
  options: CaseStatus[];
}) {
  const t = useTranslations("caseDetail");
  const tEnums = useTranslations("enums");

  const [state, formAction] = useActionState(changeCaseStatus, IDLE);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="caseId" value={caseId} />
      <input type="hidden" name="locale" value={locale} />

      <div className="max-w-sm">
        {/* No preselected target: a move to a terminal status cannot be undone,
            and a select that arrives with the answer already in it is one
            misplaced click away from closing a case nobody worked. */}
        <Field label={t("statusChange")} required>
          <select name="status" className={selectClass} defaultValue="" required>
            <option value="" disabled>
              {t("selectPlaceholder")}
            </option>
            {options.map((value) => (
              <option key={value} value={value}>
                {tEnums(enumKey.caseStatus(value))}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <FormResult
        state={state}
        successText={t("moved")}
        errorText={rejectionText(
          state,
          (values) => t("errorIllegalTransition", values),
          tEnums,
          t,
        )}
      />

      <FormActions>
        <SubmitButton label={t("moveSubmit")} pendingLabel={t("movePending")} />
      </FormActions>
    </form>
  );
}

/**
 * Why the last submission was refused, or null when it was not.
 *
 * The illegal-transition message is built from the two statuses the action
 * refused. "That move is not allowed" without naming the move leaves the reader
 * guessing which half of it was wrong, and the action is the only thing that
 * knows — the form only ever offers legal targets, so this message is what a
 * stale tab or a hand-built POST gets.
 *
 * `errorIllegalTransition` arrives as a value rather than as a translator: the
 * translators are called here, where their types are exact, instead of being
 * passed around as function-typed props.
 */
function rejectionText(
  state: CaseActionState,
  illegalTransition: (values: { from: string; to: string }) => string,
  tEnums: (key: string) => string,
  t: (key: string) => string,
): string | null {
  if (state.kind !== "error") return null;

  if (state.code === "ILLEGAL_TRANSITION" && state.from && state.to) {
    return illegalTransition({
      from: tEnums(enumKey.caseStatus(state.from)),
      to: tEnums(enumKey.caseStatus(state.to)),
    });
  }

  return t(ERROR_MESSAGE_KEY[state.code]);
}

/**
 * The result of the last submission.
 *
 * A discriminated state rather than a nullable error string, so a success can
 * never be rendered as a failure or the other way round.
 */
function FormResult({
  state,
  successText,
  errorText,
}: {
  state: CaseActionState;
  successText: string;
  errorText: string | null;
}) {
  if (state.kind === "idle") return null;
  if (state.kind === "ok") return <Notice tone="success">{successText}</Notice>;
  return <Notice tone="danger">{errorText}</Notice>;
}

/**
 * The submit button, rendered inside the form so `useFormStatus` can read the
 * submission it belongs to. A sibling of the form would report nothing at all.
 */
function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending} className={buttonClass("primary")}>
      {pending ? pendingLabel : label}
    </button>
  );
}
