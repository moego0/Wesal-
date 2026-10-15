"use client";

import { useTranslations } from "next-intl";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { inputClass } from "@/components/ui";
import type { DrugSuggestion } from "@/lib/drug-name-search";

/**
 * The medication-name field, with drug-name suggestions.
 *
 * This is the only combobox in the app, so it is worth saying what it is not:
 * it is not a control that can refuse a value. Every path below — upstream
 * down, upstream slow, nothing matched, an Egyptian brand DailyMed has never
 * heard of — leaves a plain text input that submits exactly as it did before
 * this component existed. The suggestions are an offer.
 *
 * Two implementation notes that are not obvious:
 *
 *   1. THE NAME INPUT IS UNCONTROLLED. It is `defaultValue`-based so that
 *      React's post-action form reset restores the echoed value after a
 *      rejected save, which is how every other field on this form works.
 *      Making it controlled would mean rebuilding that echo by hand. A
 *      selection is therefore written into the DOM node directly, through the
 *      ref — and `search` below is NOT the field's value; it is only the text
 *      currently being searched for.
 *
 *   2. THE CODE IS NOT THIS COMPONENT'S STATE. The form owns it in a hidden
 *      input; this component only ever clears or sets it. See `handleChange`
 *      and `select` for why clearing it is a correctness requirement rather
 *      than tidiness.
 */

/** Below this, DailyMed matches so broadly that the list is noise. */
const MIN_QUERY = 3;

/** Same debounce feel as the duplicate-phone warning on the patient form. */
const DEBOUNCE_MS = 350;

/**
 * `done` exists to separate "the answer was nothing" from "no answer yet". With
 * only a loading flag, the 350ms before the request even starts renders as
 * "No match", which is a lie the pharmacist reads as "this drug is not in the
 * list" while the search is still pending.
 */
type Phase = "idle" | "loading" | "done" | "error";

export function DrugNameCombobox({
  id,
  name = "name",
  defaultValue,
  required,
  maxLength = 160,
  onCodeChange,
}: {
  id: string;
  name?: string;
  defaultValue?: string;
  required?: boolean;
  maxLength?: number;
  /** Called with an RxCUI on selection, and with "" whenever the name changes. */
  onCodeChange: (code: string) => void;
}) {
  const t = useTranslations("drugPicker");

  /**
   * The text being searched for — deliberately not mirrored from the input.
   * After a selection it is cleared, so the debounce below does not immediately
   * re-search the name the pharmacist just picked and pop the list back open.
   */
  const [search, setSearch] = useState("");
  const [suggestions, setSuggestions] = useState<DrugSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [phase, setPhase] = useState<Phase>("idle");

  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * Monotonic request id. Every response is checked against it before being
   * applied, so a slow answer for `metf` cannot land on top of a fast one for
   * `atorva`, and a code arriving after the name was edited is discarded.
   */
  const seqRef = useRef(0);

  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  /**
   * The route stays mounted-but-hidden under Cache Components, so state here
   * SURVIVES navigation — an open dropdown would still be open on return.
   * `useLayoutEffect` rather than `useEffect` because the bundled docs require
   * the cleanup to run synchronously before the component is hidden, or the
   * stale list is visible for a frame.
   */
  useLayoutEffect(() => {
    return () => {
      setOpen(false);
      setActiveIndex(-1);
    };
  }, []);

  useEffect(() => {
    const trimmed = search.trim();

    // The early return for a short or non-Latin query lives in `handleChange`,
    // not here: setting state synchronously in an effect body is what the
    // `react-hooks/set-state-in-effect` lint rule exists to catch.
    if (trimmed.length < MIN_QUERY || !/[A-Za-z]/.test(trimmed)) return;

    const controller = new AbortController();
    let cancelled = false;

    const timer = setTimeout(async () => {
      const mySeq = ++seqRef.current;
      setPhase("loading");

      try {
        const response = await fetch(`/api/drug-names?q=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
        });

        if (cancelled || mySeq !== seqRef.current) return;

        if (!response.ok) {
          setSuggestions([]);
          setPhase("error");
          setOpen(false);
          return;
        }

        const body = (await response.json()) as { suggestions?: DrugSuggestion[] };
        if (cancelled || mySeq !== seqRef.current) return;

        const list = Array.isArray(body.suggestions) ? body.suggestions : [];
        setSuggestions(list);
        setPhase("done");
        setOpen(list.length > 0);
        setActiveIndex(-1);
      } catch {
        // An aborted request is a cleanup, not a failure worth reporting.
        if (cancelled) return;
        setSuggestions([]);
        setPhase("error");
        setOpen(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [search]);

  /**
   * Typing invalidates the picked code, IMMEDIATELY and synchronously.
   *
   * This is the one data-integrity rule in the component. A code describes one
   * name exactly; once the pharmacist edits the name, the stored code is about
   * a drug that is no longer in the field. The server cannot detect that — it
   * receives a name and a code and has no way to tell whether they were ever a
   * matched pair — so this is the real defence, not a nicety. Bumping the
   * sequence also discards a code request still in flight.
   */
  function handleChange(value: string) {
    setSearch(value);
    onCodeChange("");
    seqRef.current += 1;
    setPhase("idle");

    const trimmed = value.trim();
    if (trimmed.length < MIN_QUERY || !/[A-Za-z]/.test(trimmed)) {
      setSuggestions([]);
      setOpen(false);
      setActiveIndex(-1);
    }
  }

  function select(index: number) {
    const choice = suggestions[index];
    if (!choice) return;

    // Written to the DOM node, not to state: the input stays uncontrolled so
    // the form's own echo-and-reset behaviour keeps working. See note 1 above.
    if (inputRef.current) inputRef.current.value = choice.name;

    // Cleared so the debounce does not re-search what was just selected.
    setSearch("");
    setSuggestions([]);
    setOpen(false);
    setActiveIndex(-1);
    setPhase("idle");

    onCodeChange("");

    const mySeq = ++seqRef.current;

    void (async () => {
      try {
        const response = await fetch(`/api/drug-code?name=${encodeURIComponent(choice.name)}`);
        if (!response.ok) return;

        const body = (await response.json()) as { code?: unknown };
        if (mySeq !== seqRef.current) return;

        // Belt and braces: the sequence already covers a keystroke, and this
        // covers the field being changed by anything that skips `handleChange`.
        if (inputRef.current?.value !== choice.name) return;

        if (typeof body.code === "string" && /^\d{1,8}$/.test(body.code)) {
          onCodeChange(body.code);
        }
      } catch {
        // No code, and no consequence: the medication saves without one.
      }
    })();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape" || event.key === "Tab") {
      setOpen(false);
      setActiveIndex(-1);
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (suggestions.length === 0) return;
      event.preventDefault();

      setOpen(true);
      setActiveIndex((current) => {
        if (current < 0) return event.key === "ArrowDown" ? 0 : suggestions.length - 1;
        const delta = event.key === "ArrowDown" ? 1 : -1;
        return (current + delta + suggestions.length) % suggestions.length;
      });
      return;
    }

    /*
     * Enter selects ONLY when a suggestion is highlighted.
     *
     * With nothing highlighted it is left entirely alone, so the primary
     * workflow — type the name, press Enter, save — keeps working, and Arabic
     * free text (which never produces suggestions) is unaffected. Swallowing
     * Enter whenever the list happened to be open would make the form feel
     * broken at exactly the moment the pharmacist is fastest.
     */
    if (event.key === "Enter" && open && activeIndex >= 0) {
      event.preventDefault();
      select(activeIndex);
    }
  }

  const showList = open && suggestions.length > 0;
  const showNoResults = phase === "done" && suggestions.length === 0;

  return (
    <div
      className="relative"
      onBlur={(event) => {
        // Focus moving within the widget keeps it open; leaving it closes the
        // list, which is also what lets a click on Save land on the button.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
          setActiveIndex(-1);
        }
      }}
    >
      <input
        ref={inputRef}
        id={id}
        name={name}
        type="text"
        required={required}
        maxLength={maxLength}
        defaultValue={defaultValue}
        autoComplete="off"
        // Drug names are Latin, but the field also accepts an Arabic name the
        // list does not have, so the direction follows what was typed.
        dir="auto"
        className={inputClass}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={
          showList && activeIndex >= 0 ? optionId(activeIndex) : undefined
        }
        onChange={(event) => handleChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />

      {showList ? (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={t("suggestionsLabel")}
          className="absolute inset-x-0 z-20 mt-1 max-h-72 overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
          // Keeps focus on the input through the click, so the blur handler
          // above cannot close the list before the option is chosen. This is
          // why no timeout trick is needed here.
          onMouseDown={(event) => event.preventDefault()}
        >
          {suggestions.map((suggestion, index) => (
            <li
              key={suggestion.name}
              id={optionId(index)}
              role="option"
              aria-selected={index === activeIndex}
              className={`cursor-pointer px-3 py-2 text-sm ${
                index === activeIndex ? "bg-teal-50 dark:bg-teal-950/50" : "bg-transparent"
              }`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => select(index)}
            >
              <span dir="ltr" className="font-medium text-slate-900 dark:text-slate-100">
                {suggestion.name}
              </span>
              <span className="ms-2 text-xs text-slate-500 dark:text-slate-400">
                {suggestion.nameType === "G" ? t("generic") : t("brand")}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {phase === "error" ? (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t("error")}</p>
      ) : null}

      {showNoResults ? (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t("noResults")}</p>
      ) : null}

      {/*
        One live region, because a list appearing under the cursor is invisible
        to a screen reader. It reports the two things worth interrupting for:
        that a search is running, and how many names came back.
      */}
      <p role="status" aria-live="polite" className="sr-only">
        {phase === "loading"
          ? t("loading")
          : showList
            ? t("resultsAnnouncement", { count: suggestions.length })
            : ""}
      </p>
    </div>
  );
}
