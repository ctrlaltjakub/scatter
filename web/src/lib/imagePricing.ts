import type { ImagePriceLine } from '@/providers/types';

export interface ImagePriceSelection {
  quality?: string;
  size?: string;
  resolution?: string;
  customWidth?: number;
  customHeight?: number;
}

export interface ImagePricePresentation {
  label: string;
  tooltip: string;
  available: boolean;
}

const STANDARD_SIZES = ['1024x1024', '1024x1536', '1536x1024'] as const;
type StandardSize = typeof STANDARD_SIZES[number];
type Quality = 'low' | 'medium' | 'high';

const OPENAI_OUTPUT_PRICES: Record<string, Record<Quality, Record<StandardSize, number>>> = {
  'gpt-image-2': {
    low: { '1024x1024': 0.006, '1024x1536': 0.005, '1536x1024': 0.005 },
    medium: { '1024x1024': 0.053, '1024x1536': 0.041, '1536x1024': 0.041 },
    high: { '1024x1024': 0.211, '1024x1536': 0.165, '1536x1024': 0.165 },
  },
  'gpt-image-1.5': {
    low: { '1024x1024': 0.009, '1024x1536': 0.013, '1536x1024': 0.013 },
    medium: { '1024x1024': 0.034, '1024x1536': 0.05, '1536x1024': 0.05 },
    high: { '1024x1024': 0.133, '1024x1536': 0.2, '1536x1024': 0.2 },
  },
  'gpt-image-1': {
    low: { '1024x1024': 0.011, '1024x1536': 0.016, '1536x1024': 0.016 },
    medium: { '1024x1024': 0.042, '1024x1536': 0.063, '1536x1024': 0.063 },
    high: { '1024x1024': 0.167, '1024x1536': 0.25, '1536x1024': 0.25 },
  },
  'gpt-image-1-mini': {
    low: { '1024x1024': 0.005, '1024x1536': 0.006, '1536x1024': 0.006 },
    medium: { '1024x1024': 0.011, '1024x1536': 0.015, '1536x1024': 0.015 },
    high: { '1024x1024': 0.036, '1024x1536': 0.052, '1536x1024': 0.052 },
  },
};

/** OpenAI's model-list response is ID-only, so its documented output table is
 * kept locally. Unknown aliases deliberately receive no guessed price. */
export function documentedOpenAIImagePricing(modelId: string): ImagePriceLine[] | undefined {
  const id = modelId.toLowerCase();
  const key = Object.keys(OPENAI_OUTPUT_PRICES).sort((a, b) => b.length - a.length).find((candidate) =>
    id === candidate || id.startsWith(`${candidate}-`));
  if (!key) return undefined;
  const table = OPENAI_OUTPUT_PRICES[key]!;
  return (Object.keys(table) as Quality[]).flatMap((quality) =>
    STANDARD_SIZES.map((size) => ({
      billable: 'output_image',
      unit: 'image',
      costUsd: table[quality][size],
      quality,
      size,
      source: 'documented' as const,
    })));
}

function normalized(value: string | undefined): string | undefined {
  const result = value?.trim().toLowerCase();
  return result && result !== 'auto' ? result : undefined;
}

function formatUsd(value: number): string {
  const fixed = value.toFixed(value < 0.001 ? 6 : value < 0.1 ? 4 : 3)
    .replace(/0+$/, '')
    .replace(/\.$/, '');
  return `$${fixed}`;
}

function rangeLabel(values: number[], suffix: string): string {
  const min = Math.min(...values);
  const max = Math.max(...values);
  return min === max ? `${formatUsd(min)}${suffix}` : `${formatUsd(min)}–${formatUsd(max)}${suffix}`;
}

function outputLines(lines: ImagePriceLine[]): ImagePriceLine[] {
  return lines.filter((line) => line.billable === 'output_image'
    && Number.isFinite(line.costUsd) && line.costUsd >= 0);
}

function selectedTags(selection: ImagePriceSelection): Set<string> {
  return new Set([
    normalized(selection.quality),
    normalized(selection.size),
    normalized(selection.resolution),
  ].filter((value): value is string => !!value));
}

function applicableOutputLines(lines: ImagePriceLine[], selection: ImagePriceSelection): ImagePriceLine[] {
  const output = outputLines(lines);
  const quality = normalized(selection.quality);
  const size = normalized(selection.size);
  const resolution = normalized(selection.resolution);
  const tags = selectedTags(selection);
  const variants = new Set(output.map((line) => normalized(line.variant)).filter(Boolean));
  const selectedVariants = new Set([...tags].filter((tag) => variants.has(tag)));
  const matching = output.filter((line) => {
    if (line.quality && quality && normalized(line.quality) !== quality) return false;
    if (line.size && size && normalized(line.size) !== size) return false;
    if (line.resolution && resolution && normalized(line.resolution) !== resolution) return false;
    if (line.variant && selectedVariants.size && !selectedVariants.has(normalized(line.variant)!)) return false;
    return true;
  });
  if (matching.length) return matching;
  return output.filter((line) => !line.quality && !line.size && !line.resolution && !line.variant);
}

function dimensions(selection: ImagePriceSelection): { width: number; height: number } | null {
  const size = selection.size === 'custom'
    ? `${selection.customWidth}x${selection.customHeight}`
    : selection.size;
  const match = size?.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

function unitSummary(lines: ImagePriceLine[]): string {
  if (!lines.length) return 'Price unavailable';
  const image = lines.filter((line) => line.unit === 'image');
  if (image.length) return rangeLabel(image.map((line) => line.costUsd), '/image');
  const megapixel = lines.filter((line) => line.unit === 'megapixel');
  if (megapixel.length) return rangeLabel(megapixel.map((line) => line.costUsd), '/MP');
  const token = lines.filter((line) => line.unit === 'token');
  if (token.length) return rangeLabel(token.map((line) => line.costUsd * 1_000_000), '/M tokens');
  return 'Price unavailable';
}

function supplementalTooltip(lines: ImagePriceLine[], output: ImagePriceLine[]): string {
  const details: string[] = [`Applicable image output: ${unitSummary(output)}.`];
  const inputs = lines.filter((line) =>
    (line.billable === 'input_image' || line.billable === 'input_reference')
    && Number.isFinite(line.costUsd));
  if (inputs.length) details.push(`Reference-image input: ${unitSummary(inputs)}.`);
  const variants = [...new Set(output.map((line) => line.variant).filter(Boolean))];
  if (variants.length) details.push(`Provider tiers: ${variants.join(', ')}.`);
  const qualities = [...new Set(output.map((line) => line.quality).filter(Boolean))];
  if (qualities.length) details.push(`Qualities: ${qualities.join(', ')}.`);
  const sizes = [...new Set(output.map((line) => line.size).filter(Boolean))];
  if (sizes.length) details.push(`Sizes: ${sizes.join(', ')}.`);
  const routes = [...new Set(output.map((line) => line.providerRoute).filter(Boolean))];
  if (routes.length > 1) details.push(`Provider routes: ${routes.join(', ')}.`);
  details.push('Prompt tokens and reference-image input may add to the final charge.');
  return details.join(' ');
}

/** Small model-row label, intentionally based on output cost only. */
export function compactImagePriceLabel(lines: ImagePriceLine[] | undefined): string | null {
  const output = outputLines(lines ?? []);
  if (!output.length) return null;
  const candidates: Array<{ unit: string; multiplier: number; suffix: string }> = [
    { unit: 'image', multiplier: 1, suffix: '/image' },
    { unit: 'megapixel', multiplier: 1, suffix: '/MP' },
    { unit: 'token', multiplier: 1_000_000, suffix: '/M tokens' },
  ];
  for (const candidate of candidates) {
    const costs = output
      .filter((line) => line.unit === candidate.unit)
      .map((line) => line.costUsd * candidate.multiplier);
    if (!costs.length) continue;
    const min = Math.min(...costs);
    const variable = costs.some((cost) => cost !== min) || output.length > costs.length;
    return `${variable ? 'from ' : ''}${formatUsd(min)}${candidate.suffix}`;
  }
  return null;
}

/** Price shown below the active model's generation controls. */
export function imagePricePresentation(
  lines: ImagePriceLine[] | undefined,
  selection: ImagePriceSelection,
): ImagePricePresentation {
  const all = lines ?? [];
  const applicable = applicableOutputLines(all, selection);
  if (!applicable.length) {
    return {
      label: 'Price unavailable',
      tooltip: 'This provider does not expose a reliable price for the selected image settings.',
      available: false,
    };
  }
  const image = applicable.filter((line) => line.unit === 'image');
  if (image.length) {
    return {
      label: `Estimated output cost: ${rangeLabel(image.map((line) => line.costUsd), '/image')}`,
      tooltip: supplementalTooltip(all, image),
      available: true,
    };
  }
  const megapixel = applicable.filter((line) => line.unit === 'megapixel');
  if (megapixel.length) {
    const dims = dimensions(selection);
    if (dims) {
      const count = (dims.width * dims.height) / 1_000_000;
      return {
        label: `Estimated output cost: ${rangeLabel(megapixel.map((line) => line.costUsd * count), '/image')}`,
        tooltip: supplementalTooltip(all, megapixel),
        available: true,
      };
    }
    return {
      label: `Output rate: ${rangeLabel(megapixel.map((line) => line.costUsd), '/MP')}`,
      tooltip: supplementalTooltip(all, megapixel),
      available: true,
    };
  }
  const token = applicable.filter((line) => line.unit === 'token');
  if (token.length) {
    return {
      label: `Output rate: ${rangeLabel(token.map((line) => line.costUsd * 1_000_000), '/M tokens')}`,
      tooltip: supplementalTooltip(all, token),
      available: true,
    };
  }
  return {
    label: 'Price unavailable',
    tooltip: 'This provider reports pricing in a unit Scatter cannot estimate yet.',
    available: false,
  };
}
