import { estimateCostUsd, formatReportedCost, parseScaledPrice } from './cost.js';

const price = {
  inputPricePerMillion: '2.500000',
  outputPricePerMillion: '10.000000',
  cachedInputPricePerMillion: '1.250000',
};

describe('parseScaledPrice', () => {
  it('scales decimal strings exactly', () => {
    expect(parseScaledPrice('2.5')).toBe(2_500_000n);
    expect(parseScaledPrice('0.000001')).toBe(1n);
    expect(parseScaledPrice('15')).toBe(15_000_000n);
    expect(parseScaledPrice('3.1000000')).toBe(3_100_000n);
  });

  it('rejects malformed or over-precise values', () => {
    expect(() => parseScaledPrice('-1')).toThrow();
    expect(() => parseScaledPrice('abc')).toThrow();
    expect(() => parseScaledPrice('0.0000001')).toThrow(/decimal places/);
  });
});

describe('estimateCostUsd', () => {
  it('prices input and output tokens per million', () => {
    // 1000 × 2.5/1M + 500 × 10/1M = 0.0025 + 0.005
    expect(
      estimateCostUsd({ inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0 }, price),
    ).toBe('0.00750000');
  });

  it('bills cached input at the cached price', () => {
    // 600 × 2.5/1M + 400 × 1.25/1M + 0 = 0.0015 + 0.0005
    expect(
      estimateCostUsd({ inputTokens: 1000, outputTokens: 0, cachedInputTokens: 400 }, price),
    ).toBe('0.00200000');
  });

  it('falls back to the input price when the model has no cached price', () => {
    const noCache = { ...price, cachedInputPricePerMillion: null };
    expect(
      estimateCostUsd({ inputTokens: 1000, outputTokens: 0, cachedInputTokens: 400 }, noCache),
    ).toBe('0.00250000');
  });

  it('rounds half up to 8 decimal places', () => {
    // 1 token × 0.000005 USD = 0.000000000005 → rounds to 0.00000000 ; 3 tokens × 1.5/1M = 0.0000045
    expect(
      estimateCostUsd(
        { inputTokens: 3, outputTokens: 0, cachedInputTokens: 0 },
        { ...price, inputPricePerMillion: '1.5' },
      ),
    ).toBe('0.00000450');
    expect(
      estimateCostUsd(
        { inputTokens: 1, outputTokens: 0, cachedInputTokens: 0 },
        { ...price, inputPricePerMillion: '0.005' },
      ),
    ).toBe('0.00000001');
  });

  it('does not lose precision at large volumes', () => {
    // 100M tokens × 0.1 USD/1M = 10 USD exactly (float math would be fine here, but 0.1 is not
    // representable in binary; the integer path keeps it exact).
    expect(
      estimateCostUsd(
        { inputTokens: 100_000_000, outputTokens: 0, cachedInputTokens: 0 },
        { ...price, inputPricePerMillion: '0.1' },
      ),
    ).toBe('10.00000000');
  });

  it('is zero for zero tokens', () => {
    expect(estimateCostUsd({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }, price)).toBe(
      '0.00000000',
    );
  });

  it('rejects inconsistent token counts', () => {
    expect(() =>
      estimateCostUsd({ inputTokens: 1, outputTokens: 0, cachedInputTokens: 2 }, price),
    ).toThrow();
  });
});

describe('formatReportedCost', () => {
  it('formats with 8 decimal places', () => {
    expect(formatReportedCost(0.0123)).toBe('0.01230000');
  });
});
