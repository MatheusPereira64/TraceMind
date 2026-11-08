export interface DiffSegment {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

/** Words and the whitespace after them, so joining the tokens restores the original text. */
const tokenize = (text: string) => text.match(/\S+\s*|\s+/g) ?? [];

/**
 * Word-level diff (longest common subsequence). Inputs above `maxTokens` words each are compared
 * as whole blocks instead, which keeps the quadratic table small for very long completions.
 */
export function wordDiff(before: string, after: string, maxTokens = 1_500): DiffSegment[] {
  if (before === after) return before ? [{ kind: 'same', text: before }] : [];
  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length > maxTokens || b.length > maxTokens) {
    return [
      ...(before ? [{ kind: 'removed' as const, text: before }] : []),
      ...(after ? [{ kind: 'added' as const, text: after }] : []),
    ];
  }

  // lcs[i][j] = length of the LCS of a[i..] and b[j..]; compared ignoring trailing whitespace.
  const key = (token: string) => token.trimEnd();
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        key(a[i]!) === key(b[j]!)
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const segments: DiffSegment[] = [];
  const push = (kind: DiffSegment['kind'], text: string) => {
    const last = segments.at(-1);
    if (last?.kind === kind) last.text += text;
    else segments.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (key(a[i]!) === key(b[j]!)) {
      push('same', b[j]!);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      push('removed', a[i++]!);
    } else {
      push('added', b[j++]!);
    }
  }
  while (i < a.length) push('removed', a[i++]!);
  while (j < b.length) push('added', b[j++]!);
  return segments;
}
