import { describe, expect, it } from 'vitest';
import type { ImagePriceLine } from '@/providers/types';
import {
  compactImagePriceLabel,
  documentedOpenAIImagePricing,
  imagePricePresentation,
} from './imagePricing';

describe('image pricing presentation', () => {
  it('uses the documented GPT Image 2 quality and size price', () => {
    const pricing = documentedOpenAIImagePricing('gpt-image-2');
    expect(compactImagePriceLabel(pricing)).toBe('from $0.005/image');
    expect(imagePricePresentation(pricing, {
      quality: 'high', size: '1536x1024',
    }).label).toBe('Estimated output cost: $0.165/image');
  });

  it('does not assign the GPT Image 2 table to unknown aliases', () => {
    expect(documentedOpenAIImagePricing('gpt-5.4-image-2')).toBeUndefined();
    expect(imagePricePresentation(documentedOpenAIImagePricing('gpt-image-1-mini'), {
      quality: 'high', size: '1536x1024',
    }).label).toBe('Estimated output cost: $0.052/image');
  });

  it('shows a routed range and filters matching resolution variants', () => {
    const pricing: ImagePriceLine[] = [
      { billable: 'output_image', unit: 'image', costUsd: 0.04, variant: '2k' },
      { billable: 'output_image', unit: 'image', costUsd: 0.05, variant: '2K' },
      { billable: 'output_image', unit: 'image', costUsd: 0.09, variant: '4k' },
    ];
    expect(imagePricePresentation(pricing, { resolution: '2K' }).label)
      .toBe('Estimated output cost: $0.04–$0.05/image');
  });

  it('converts per-megapixel output rates only when exact dimensions are known', () => {
    const pricing: ImagePriceLine[] = [
      { billable: 'output_image', unit: 'megapixel', costUsd: 0.03 },
    ];
    expect(imagePricePresentation(pricing, { resolution: '2K' }).label)
      .toBe('Output rate: $0.03/MP');
    expect(imagePricePresentation(pricing, { size: '1000x2000' }).label)
      .toBe('Estimated output cost: $0.06/image');
  });

  it('discloses reference-image pricing and never invents missing prices', () => {
    const pricing: ImagePriceLine[] = [
      { billable: 'output_image', unit: 'image', costUsd: 0.04 },
      { billable: 'input_reference', unit: 'megapixel', costUsd: 0.015 },
    ];
    expect(imagePricePresentation(pricing, {}).tooltip).toMatch(/Reference-image input: \$0\.015\/MP/);
    expect(imagePricePresentation(undefined, {})).toMatchObject({
      label: 'Price unavailable', available: false,
    });
  });
});
