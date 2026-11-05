import { useId, useMemo, useRef, useState } from "react";
import { WORDLIST, isWord, normaliseWords } from "../core/keys.js";
import { Button, ProgressBar } from "./kit.js";

/** Shows the words a page at a time ("one screen at a time", ux-spec §4.8), numbered, never selectable for copy. */
export function WordPager({
  words,
  perPage = 4,
  onDone,
  doneLabel = "I've written them all down",
}: {
  words: string[];
  perPage?: number;
  onDone: () => void;
  doneLabel?: string;
}) {
  const [page, setPage] = useState(0);
  const pages = Math.ceil(words.length / perPage);
  const slice = words.slice(page * perPage, page * perPage + perPage);
  const last = page === pages - 1;
  return (
    <div className="flex flex-col gap-4">
      <ProgressBar
        value={(page + 1) / pages}
        label={`Words ${page * perPage + 1} to ${page * perPage + slice.length} of ${words.length}`}
      />
      <p className="t-small text-muted" aria-live="polite">
        Words {page * perPage + 1}–{page * perPage + slice.length} of {words.length}
      </p>
      <ol className="flex flex-col gap-2" start={page * perPage + 1} data-testid="word-page">
        {slice.map((w, i) => (
          <li
            key={i}
            className="flex items-baseline gap-3 rounded-md border border-line bg-surface px-4 py-3 select-none"
          >
            <span className="w-8 text-right t-small text-muted tabular">{page * perPage + i + 1}</span>
            <span className="t-mono text-[20px] leading-7" data-testid="word">
              {w}
            </span>
          </li>
        ))}
      </ol>
      <div className="flex gap-2">
        {page > 0 && (
          <Button variant="secondary" onClick={() => setPage(page - 1)}>
            Previous
          </Button>
        )}
        <Button onClick={() => (last ? onDone() : setPage(page + 1))} data-testid="words-next">
          {last ? doneLabel : "Next"}
        </Button>
      </div>
    </div>
  );
}

/** Pick `n` distinct random positions (CSPRNG). */
export function randomPositions(total: number, n: number): number[] {
  const out = new Set<number>();
  const buf = new Uint32Array(1);
  while (out.size < n) {
    crypto.getRandomValues(buf);
    out.add(buf[0]! % total);
  }
  return [...out].sort((a, b) => a - b);
}

/** Quiz: type the word at each asked position (ux-spec §4.8: 3 random positions; §4.6: 6 for the Recovery key). */
export function WordQuiz({
  words,
  positions,
  onPass,
  label = "Check your backup",
}: {
  words: string[];
  positions: number[];
  onPass: () => void;
  label?: string;
}) {
  const [answers, setAnswers] = useState<string[]>(positions.map(() => ""));
  const [error, setError] = useState<string>();
  const check = () => {
    const wrong = positions.filter((p, i) => normaliseWords([answers[i] ?? ""])[0] !== words[p]);
    if (wrong.length > 0) setError(`Word ${wrong.map((p) => `#${p + 1}`).join(", ")} doesn't match. Check your paper.`);
    else onPass();
  };
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        check();
      }}
    >
      <p className="t-body">{label}: type these words from your paper.</p>
      {positions.map((p, i) => (
        <WordInput
          key={p}
          label={`Word #${p + 1}`}
          value={answers[i] ?? ""}
          onChange={(v) => {
            setError(undefined);
            setAnswers((a) => a.map((x, j) => (j === i ? v : x)));
          }}
          testId={`quiz-${p + 1}`}
        />
      ))}
      {error && (
        <p role="alert" className="t-small text-danger">
          {error}
        </p>
      )}
      <Button type="submit" data-testid="quiz-check">
        Check
      </Button>
    </form>
  );
}

/** One word with BIP-39 autocomplete (no network: the list is bundled). */
export function WordInput({
  label,
  value,
  onChange,
  testId,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  testId?: string;
  autoFocus?: boolean;
}) {
  const id = useId();
  const ok = value === "" || isWord(value);
  const suggestions = useMemo(
    () =>
      value.length >= 2 && !isWord(value)
        ? WORDLIST.filter((w) => w.startsWith(value.trim().toLowerCase())).slice(0, 4)
        : [],
    [value],
  );
  return (
    <div>
      <label htmlFor={id} className="mb-1 block t-small text-muted">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        autoFocus={autoFocus}
        inputMode="text"
        aria-invalid={!ok}
        data-testid={testId}
        className={`tap w-full rounded-md border bg-bg px-3 py-2 t-mono text-[16px] ${ok ? "border-line" : "border-limit"}`}
      />
      {suggestions.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1" aria-label="Suggestions">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              className="tap rounded-sm bg-surface-2 px-2 t-mono"
              onClick={() => onChange(s)}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** All 24 fields, with "paste all words" for people restoring from a password manager. */
export function WordGrid({
  count = 24,
  onComplete,
  submitLabel,
}: {
  count?: number;
  onComplete: (words: string[]) => void;
  submitLabel: string;
}) {
  const [words, setWords] = useState<string[]>(Array.from({ length: count }, () => ""));
  const [error, setError] = useState<string>();
  const first = useRef(true);
  const filled = words.filter((w) => isWord(w)).length;
  const pasteAll = (text: string) => {
    const ws = normaliseWords(text.split(/\s+/));
    if (ws.length === count) {
      setWords(ws);
      return true;
    }
    return false;
  };
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (filled !== count) {
          setError(`${count - filled} word${count - filled === 1 ? " is" : "s are"} missing or not on the word list.`);
          return;
        }
        onComplete(normaliseWords(words));
      }}
    >
      <p className="t-small text-muted" aria-live="polite">
        {filled} of {count} words
      </p>
      <div className="grid grid-cols-2 gap-2">
        {words.map((w, i) => (
          <WordInput
            key={i}
            label={`${i + 1}`}
            value={w}
            autoFocus={i === 0 && first.current}
            onChange={(v) => {
              first.current = false;
              setError(undefined);
              if (/\s/.test(v.trim()) && pasteAll(v)) return;
              setWords((a) => a.map((x, j) => (j === i ? v.trim().toLowerCase() : x)));
            }}
            testId={`word-${i + 1}`}
          />
        ))}
      </div>
      {error && (
        <p role="alert" className="t-small text-danger">
          {error}
        </p>
      )}
      <Button type="submit" data-testid="words-submit">
        {submitLabel}
      </Button>
    </form>
  );
}
