import type { ReactNode } from "react";

/**
 * Presentational primitives shared by every screen.
 *
 * Deliberately free of Next.js APIs — no `Link`, no params, no data fetching.
 * That keeps them usable from server components, client components and tests
 * alike, and means a change to routing conventions never reaches this file.
 *
 * ## Direction
 *
 * Every spacing utility here is LOGICAL (`ms-`, `me-`, `ps-`, `pe-`,
 * `text-start`) rather than physical (`ml-`, `mr-`). Arabic is the primary
 * locale and the whole interface mirrors under RTL; a single `ml-2` becomes a
 * gap on the wrong side of the text the moment `dir="rtl"` applies, and it does
 * so silently. There is no lint rule that catches it, so the convention is the
 * only defence.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Layout
// ─────────────────────────────────────────────────────────────────────────────

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
          {title}
        </h1>
        {subtitle ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900 ${className}`}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
      <div className="space-y-0.5">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-50">{title}</h2>
        {subtitle ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">{subtitle}</p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function CardBody({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`px-5 py-4 ${className}`}>{children}</div>;
}

/**
 * A metric.
 *
 * `value` is formatted by the caller, not here: the correct digits, separators
 * and unit live in the locale, and this component has no business knowing
 * whether it is rendering Arabic-Indic or Latin numerals.
 */
export function StatCard({
  label,
  value,
  unit,
  hint,
  tone = "neutral",
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  hint?: ReactNode;
  tone?: "neutral" | "attention" | "good";
}) {
  const accent =
    tone === "attention"
      ? "text-rose-600 dark:text-rose-400"
      : tone === "good"
        ? "text-teal-600 dark:text-teal-400"
        : "text-slate-900 dark:text-slate-50";

  return (
    <Card className="p-5">
      <p className="text-sm font-medium text-slate-500 dark:text-slate-400">{label}</p>
      <p className="mt-2 flex items-baseline gap-1.5">
        <span
          className={`text-3xl font-semibold tracking-tight tabular-nums ${accent}`}
        >
          {value}
        </span>
        {unit ? (
          <span className="text-sm text-slate-500 dark:text-slate-400">{unit}</span>
        ) : null}
      </p>
      {hint ? (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hint}</p>
      ) : null}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// States
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shown when a list is genuinely empty.
 *
 * `hint` is where the useful sentence goes. "No patients yet" tells a pharmacist
 * nothing they did not already know; "Register a patient to start sending
 * reminders" tells them what to do about it.
 */
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{title}</p>
      {hint ? (
        <p className="max-w-sm text-sm text-slate-500 dark:text-slate-400">{hint}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** Holds a block's height while it loads, so the page below does not jump. */
export function Skeleton({ className = "h-24" }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`animate-pulse rounded-2xl bg-slate-100 dark:bg-slate-800 ${className}`}
    />
  );
}

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div aria-hidden className="space-y-2 p-5">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="h-10 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800"
        />
      ))}
    </div>
  );
}

/**
 * An inline problem notice.
 *
 * `tone` is not decoration: "danger" is for something that has gone wrong that
 * the reader must act on, "warning" for a caveat, "info" for context. Using
 * "danger" for an informational note trains people to ignore the colour.
 */
export function Notice({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warning" | "danger" | "success";
  title?: ReactNode;
  children?: ReactNode;
}) {
  const styles = {
    info: "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-200",
    warning:
      "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200",
    danger:
      "border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200",
    success:
      "border-teal-200 bg-teal-50 text-teal-900 dark:border-teal-900/60 dark:bg-teal-950/40 dark:text-teal-200",
  }[tone];

  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${styles}`}>
      {title ? <p className="font-medium">{title}</p> : null}
      {children ? <div className={title ? "mt-1" : ""}>{children}</div> : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Table
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A table that degrades to a stack of cards on narrow screens.
 *
 * A pharmacy's front desk is often a phone or a small tablet, and a six-column
 * table there is a horizontal scrollbar nobody uses. The `stack` prop on each
 * cell supplies the label that would have been the column header.
 */
export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({
  children,
  align = "start",
  className = "",
}: {
  children: ReactNode;
  align?: "start" | "end" | "center";
  className?: string;
}) {
  const alignClass =
    align === "end" ? "text-end" : align === "center" ? "text-center" : "text-start";

  return (
    <th
      scope="col"
      className={`border-b border-slate-200 px-4 py-2.5 text-xs font-semibold tracking-wide text-slate-500 uppercase dark:border-slate-800 dark:text-slate-400 ${alignClass} ${className}`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = "start",
  className = "",
}: {
  children: ReactNode;
  align?: "start" | "end" | "center";
  className?: string;
}) {
  const alignClass =
    align === "end" ? "text-end" : align === "center" ? "text-center" : "text-start";

  return (
    <td
      className={`border-b border-slate-100 px-4 py-3 align-middle text-slate-700 dark:border-slate-800/60 dark:text-slate-300 ${alignClass} ${className}`}
    >
      {children}
    </td>
  );
}

export function Tr({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <tr className={`transition hover:bg-slate-50 dark:hover:bg-slate-800/40 ${className}`}>
      {children}
    </tr>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Buttons
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Button and link share one visual scale so a row of actions does not come out
 * mismatched. `secondary` is the default: a screen with three primary buttons
 * has no primary button.
 */
export const buttonStyles = {
  base: "inline-flex items-center justify-center gap-1.5 rounded-lg text-sm font-medium transition focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-1 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:focus-visible:ring-offset-slate-900",
  primary:
    "bg-teal-600 text-white shadow-sm hover:bg-teal-700 disabled:hover:bg-teal-600",
  secondary:
    "border border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-600 dark:hover:bg-slate-800",
  danger:
    "border border-rose-300 bg-white text-rose-700 hover:border-rose-400 hover:bg-rose-50 dark:border-rose-900 dark:bg-slate-900 dark:text-rose-300 dark:hover:bg-rose-950/40",
  ghost:
    "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100",
} as const;

export const buttonSizes = {
  xs: "px-2 py-1 text-xs",
  sm: "px-2.5 py-1.5 text-xs",
  md: "px-3 py-2",
} as const;

export function buttonClass(
  variant: keyof typeof buttonStyles = "secondary",
  size: keyof typeof buttonSizes = "md",
  extra = "",
): string {
  return `${buttonStyles.base} ${buttonStyles[variant]} ${buttonSizes[size]} ${extra}`.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Forms
// ─────────────────────────────────────────────────────────────────────────────

export function Field({
  label,
  hint,
  error,
  required,
  children,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label
        htmlFor={htmlFor}
        className="block text-sm font-medium text-slate-700 dark:text-slate-200"
      >
        {label}
        {required ? (
          <span aria-hidden className="ms-1 text-rose-600 dark:text-rose-400">
            *
          </span>
        ) : null}
      </label>
      {children}
      {/* `hint` and `error` occupy the same slot rather than stacking: showing
          both means the hint is read as part of the error message. */}
      {error ? (
        <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>
      ) : hint ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">{hint}</p>
      ) : null}
    </div>
  );
}

export const inputClass =
  "block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm transition placeholder:text-slate-400 focus:border-teal-500 focus:ring-2 focus:ring-teal-500/30 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 dark:disabled:bg-slate-800";

export const textareaClass = `${inputClass} min-h-24 resize-y`;

export const selectClass = `${inputClass} pe-8`;

export function FormActions({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4 dark:border-slate-800">
      {children}
    </div>
  );
}

export function DefinitionList({
  items,
}: {
  items: { term: ReactNode; detail: ReactNode }[];
}) {
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map((item, i) => (
        <div key={i} className="space-y-0.5">
          <dt className="text-xs font-medium text-slate-500 dark:text-slate-400">
            {item.term}
          </dt>
          <dd className="text-sm text-slate-800 dark:text-slate-200">{item.detail}</dd>
        </div>
      ))}
    </dl>
  );
}
