import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ResilientFreeImage } from './ResilientFreeImage';

const result = {
  source: 'openverse' as const,
  sourceId: 'image-id',
  thumbnailUrl: 'https://stale.example/thumb.jpg',
  originalUrl: 'https://provider.example/original.jpg',
  caption: 'Visual map',
  license: 'CC BY 4.0',
  creditLine: 'Creator',
};

describe('ResilientFreeImage', () => {
  it('advances from a stale saved thumbnail to the current Openverse proxy', () => {
    const { getByRole } = render(<ResilientFreeImage result={result} alt="Visual map" />);
    const image = getByRole('img');
    expect(image).toHaveAttribute('src', result.thumbnailUrl);

    fireEvent.error(image);
    expect(getByRole('img')).toHaveAttribute(
      'src',
      'https://api.openverse.org/v1/images/image-id/thumb/',
    );
  });
});
