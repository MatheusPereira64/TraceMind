/**
 * Exact cost estimation with integer arithmetic.
 *
 * Prices are stored as NUMERIC(14,6) USD per 1M tokens and arrive from the driver as decimal
 * strings. Converting them to floating point would accumulate rounding errors across millions of
 * spans, so prices are scaled to integers (micro-USD per 1M tokens) and multiplied with BigInt:
 *
 *   cost_usd = tokens × price_per_million / 1e6 = tokens × price_micro / 1e12
 */

export interface PriceRow {
  inputPricePerMillion: string;
  outputPricePerMillion: string;
  cachedInputPricePerMillion: string | null;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  /** Subset of inputTokens served from the provider's prompt cache. */
  cachedInputTokens: number;
}

const PRICE_SCALE_DIGITS = 6;
/** Result precision: NUMERIC(18,8). */
const RESULT_DIGITS = 8;

/** Parses a non-negative decimal string into an integer scaled by 10^6, exactly. */
export function parseScaledPrice(value: string): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid price: "${value}"`);
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').padEnd(PRICE_SCALE_DIGITS, '0');
  if (fraction.length > PRICE_SCALE_DIGITS && /[1-9]/.test(fraction.slice(PRICE_SCALE_DIGITS))) {
    throw new Error(`Price "${value}" has more than ${PRICE_SCALE_DIGITS} decimal places`);
  }
  return (
    BigInt(whole) * 10n ** BigInt(PRICE_SCALE_DIGITS) +
    BigInt(fraction.slice(0, PRICE_SCALE_DIGITS))
  );
}

/** Formats an amount expressed in 1e-12 USD as a decimal string with 8 places (half-up). */
function formatPicoUsd(pico: bigint): string {
  const divisor = 10n ** BigInt(12 - RESULT_DIGITS);
  const rounded = (pico + divisor / 2n) / divisor;
  const scale = 10n ** BigInt(RESULT_DIGITS);
  const whole = rounded / scale;
  const fraction = (rounded % scale).toString().padStart(RESULT_DIGITS, '0');
  return `${whole}.${fraction}`;
}

/**
 * Returns the estimated cost in USD as a decimal string, e.g. "0.00412500".
 * Cached input tokens are billed at the cached price when the model has one, otherwise at the
 * regular input price.
 */
export function estimateCostUsd(tokens: TokenCounts, price: PriceRow): string {
  if (tokens.cachedInputTokens > tokens.inputTokens) {
    throw new Error('cachedInputTokens cannot exceed inputTokens');
  }
  const input = parseScaledPrice(price.inputPricePerMillion);
  const output = parseScaledPrice(price.outputPricePerMillion);
  const cached =
    price.cachedInputPricePerMillion === null
      ? input
      : parseScaledPrice(price.cachedInputPricePerMillion);

  const uncachedInput = BigInt(tokens.inputTokens - tokens.cachedInputTokens);
  const pico =
    uncachedInput * input +
    BigInt(tokens.cachedInputTokens) * cached +
    BigInt(tokens.outputTokens) * output;
  return formatPicoUsd(pico);
}

/** Formats a client-reported cost (a JS number) for a NUMERIC(18,8) column. */
export function formatReportedCost(costUsd: number): string {
  return costUsd.toFixed(RESULT_DIGITS);
}
