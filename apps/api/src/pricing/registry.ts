import { z } from 'zod';

/**
 * Model price registry file format (apps/api/pricing/models.json) and its validation. Pure, so the
 * rules are unit-tested without a database.
 */

const decimal = z
  .string()
  .regex(/^\d{1,8}(\.\d{1,6})?$/, 'Use a non-negative decimal with at most 6 decimal places');
const instant = z.iso.datetime({ offset: true });

export const registryEntrySchema = z
  .object({
    provider: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    model: z.string().min(1).max(200),
    input: decimal,
    output: decimal,
    cachedInput: decimal.nullable(),
    /** null: the listed price applies to all usage before the first dated change. */
    effectiveFrom: instant.nullable(),
    effectiveTo: instant.nullable(),
    source: z.string().min(1).max(500),
  })
  .refine(
    (entry) =>
      !entry.effectiveFrom ||
      !entry.effectiveTo ||
      Date.parse(entry.effectiveTo) > Date.parse(entry.effectiveFrom),
    { message: 'effectiveTo must be after effectiveFrom', path: ['effectiveTo'] },
  );

export const registryFileSchema = z.object({
  verifiedAt: z.iso.date(),
  models: z.array(registryEntrySchema).min(1),
});
export type RegistryFile = z.infer<typeof registryFileSchema>;
export type RegistryEntry = z.infer<typeof registryEntrySchema>;

/** Start of time for prices with no known start (stored NOT NULL). */
export const OPEN_START = new Date('1970-01-01T00:00:00Z');

export interface PriceRowInput {
  providerId: string;
  model: string;
  inputPricePerMillion: string;
  outputPricePerMillion: string;
  cachedInputPricePerMillion: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  source: string;
}

/** Validates the file and rejects overlapping validity windows for the same model. */
export function parseRegistry(raw: unknown): PriceRowInput[] {
  const file = registryFileSchema.parse(raw);
  const rows = file.models.map<PriceRowInput>((entry) => ({
    providerId: entry.provider,
    model: entry.model,
    inputPricePerMillion: entry.input,
    outputPricePerMillion: entry.output,
    cachedInputPricePerMillion: entry.cachedInput,
    effectiveFrom: entry.effectiveFrom ? new Date(entry.effectiveFrom) : OPEN_START,
    effectiveTo: entry.effectiveTo ? new Date(entry.effectiveTo) : null,
    source: `${entry.source} — verified ${file.verifiedAt}`,
  }));

  const byModel = new Map<string, PriceRowInput[]>();
  for (const row of rows) {
    const key = `${row.providerId}/${row.model}`;
    byModel.set(key, [...(byModel.get(key) ?? []), row]);
  }
  for (const [key, windows] of byModel) {
    const sorted = [...windows].sort(
      (a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime(),
    );
    for (let i = 1; i < sorted.length; i += 1) {
      const previous = sorted[i - 1]!;
      const current = sorted[i]!;
      if (previous.effectiveTo === null || previous.effectiveTo > current.effectiveFrom) {
        throw new Error(
          `Overlapping price windows for ${key}: ${previous.effectiveFrom.toISOString()} and ${current.effectiveFrom.toISOString()}`,
        );
      }
    }
  }
  return rows;
}

/**
 * Providers return dated snapshots (`gpt-4.1-2025-04-14`, `model-20250514`) while price lists use
 * the alias. Returns the alias candidate, or null when the name has no date suffix.
 */
export function undatedModel(model: string): string | null {
  const stripped = model.replace(/-(\d{4}-\d{2}-\d{2}|\d{8})$/, '');
  return stripped === model ? null : stripped;
}

/** Same rule, as SQL, for set-based cost recomputation. */
export const UNDATED_MODEL_SQL_PATTERN = '-(\\d{4}-\\d{2}-\\d{2}|\\d{8})$';
