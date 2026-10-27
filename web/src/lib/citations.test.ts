import { describe, expect, test } from 'vitest';
import {
  buildSources, sourceDomain, placeCitationMarkers, placeCitationMarkersExact,
  extractInlineCitations, hasIncompleteCitationTail, placeVisibleCitationMarkers,
  placeCitationMarkersFromBareUrls, placeCitationMarkersFromLabels,
  placeCitationMarkersFromLinks, normalizeUrl,
  placeCitationMarkersReliable, renumberCitations, marker, stripUnbackedCitationLabels,
} from './citations';
import type { NodeSource } from '@/store/types';
import { LANGUAGES } from './languages';

const src = (n: number, url: string): NodeSource => ({ n, url });

describe('sourceDomain', () => {
  test('uses the title for a Google grounding redirect URL', () => {
    expect(sourceDomain('https://vertexaisearch.cloud.google.com/grounding-api-redirect/ABC', 'pcmag.com')).toBe('pcmag.com');
  });
  test('derives the hostname for a normal URL, stripping www', () => {
    expect(sourceDomain('https://www.example.com/a/b')).toBe('example.com');
  });
  test('falls back to the title when the URL is unparseable', () => {
    expect(sourceDomain('not a url', 'wiki')).toBe('wiki');
  });
});

describe('buildSources', () => {
  test('dedupes by url and numbers in first-seen order', () => {
    const s = buildSources([
      { url: 'https://a.com/1', title: 'a.com' },
      { url: 'https://b.com/2', title: 'b.com' },
      { url: 'https://a.com/1', title: 'a.com' }, // dup
    ]);
    expect(s.map((x) => [x.n, x.domain])).toEqual([[1, 'a.com'], [2, 'b.com']]);
  });
});

describe('inline citation recovery and incomplete-tail protection', () => {
  test.each(LANGUAGES)('preserves authored source lines while normalizing citations in $name', ({ sample }) => {
    const sources = [src(1, 'https://a.example'), src(2, 'https://b.example')];
    const body = `${sample} [source](https://a.example)\n([source](https://b.example))\n\n${sample} [source](https://b.example)`;
    const expected = `${sample}⟦1⟧\n⟦2⟧\n\n${sample}⟦2⟧`;
    expect(placeCitationMarkersFromLinks(body, sources)).toBe(expected);
    expect(placeCitationMarkersReliable(body, [], sources, 'sources-only')).toBe(expected);
    expect(placeVisibleCitationMarkers(body, sources.map(({ url }) => ({ url })))).toBe(expected);
  });
  test('does not remove newline boundaries inside citation wrappers', () => {
    expect(placeCitationMarkersReliable('First claim.\n<cite>\n[1]\n</cite>\nSecond claim.', [], [src(1, 'https://a.example')], 'sources-only'))
      .toBe('First claim.\n\n⟦1⟧\n\nSecond claim.');
  });
  test.each(['<cite>[3]</cite>[4][5]', '\\<cite>[3]\\</cite>[4][5]', '&lt;cite&gt;[3]&lt;/cite&gt;[4][5]'])(
    'normalizes citation wrappers without exposing HTML: %s', (markup) => {
      const sources = [3, 4, 5].map(n => src(n, `https://source.example/${n}`));
      const citations = sources.map(source => ({ url: source.url }));
      expect(placeCitationMarkersReliable(`A supported claim ${markup}.`, citations, sources))
        .toBe('A supported claim⟦3⟧⟦4⟧⟦5⟧.');
      expect(stripUnbackedCitationLabels(`A supported claim ${markup}.`)).toBe('A supported claim.');
    },
  );
  test('normalizes a cite-wrapped source link during streaming and final placement', () => {
    const body = 'A claim <cite>[source](https://a.example/p)</cite>.';
    const citations = extractInlineCitations(body);
    expect(placeVisibleCitationMarkers(body, citations)).toBe('A claim⟦1⟧.');
    expect(placeCitationMarkersReliable(body, citations, buildSources(citations))).toBe('A claim⟦1⟧.');
    expect(stripUnbackedCitationLabels(body)).toBe('A claim.');
  });
  test('does not alter legitimate cite prose or raw source offsets', () => {
    const body = 'The HTML element <cite>Book title</cite> names a work. A sourced fact.';
    const endIndex = body.length - 1;
    expect(placeCitationMarkersReliable(body, [{ url: 'https://a.example', startIndex: endIndex - 4, endIndex }], [src(1, 'https://a.example')]))
      .toBe(body.slice(0, endIndex) + '⟦1⟧.');
  });
  test('does not turn unknown numbers inside a cite wrapper into invented sources', () => {
    expect(placeCitationMarkersReliable('A claim <cite>[3]</cite>[4][5].', [], [src(3, 'https://a.example')]))
      .toBe('A claim⟦3⟧.');
    expect(placeCitationMarkersReliable('A claim <cite>[3, 4]</cite>.', [], [src(3, 'https://a.example')]))
      .toBe('A claim⟦3⟧.');
  });
  test('preserves cite markup in code examples and substantive cite prose', () => {
    for (const body of ['Example: `<cite>⟦1⟧</cite>`.', '```html\n<cite>⟦1⟧</cite>\n```', 'Read <cite>Example book</cite>.']) {
      expect(placeVisibleCitationMarkers(body, [])).toBe(body);
    }
  });
  test('leaves later raw annotation offsets correct when removing an earlier wrapper', () => {
    const body = 'First fact <cite></cite>. Second fact.';
    expect(placeCitationMarkersReliable(body, [{ url: 'https://a.example', startIndex: body.indexOf('Second'), endIndex: body.length - 1 }], [src(1, 'https://a.example')]))
      .toBe('First fact. Second fact⟦1⟧.');
  });
  test('recovers complete markdown and bracketed URL citations when annotations are absent', () => {
    const citations = extractInlineCitations(
      'First [source](https://a.example/p). Second [https://b.example/q].',
    );
    expect(citations.map((citation) => citation.url)).toEqual([
      'https://a.example/p',
      'https://b.example/q',
    ]);
  });

  test('recognizes both native Gemini cut-off citation forms despite finish_reason stop', () => {
    const full = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/ABCDEFGHIJK';
    const citation = [{ url: full }];
    expect(hasIncompleteCitationTail(
      'Pacific basin [source](https://vertexaisearch.cloud.google.com/grounding-api-redirect/ABC',
      citation,
    )).toBe(true);
    expect(hasIncompleteCitationTail(
      'Pacific basin [https://vertexaisearch.cloud.google.com/grounding-api-redirect/ABC',
      citation,
    )).toBe(true);
  });

  test('never exposes a partial provider URL during streaming', () => {
    const full = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/ABCDEFGHIJK';
    expect(placeVisibleCitationMarkers(
      'Pacific basin [source](https://vertexaisearch.cloud.google.com/grounding-api-redirect/ABC',
      [{ url: full }],
    )).toBe('Pacific basin');
  });

  test('turns Exa-style bracketed absolute URLs into source markers', () => {
    const url = 'https://repository.library.noaa.gov/view/noaa/21547';
    expect(placeCitationMarkersFromLabels(
      `A supported claim [${url}].`,
      [src(1, url)],
    )).toBe('A supported claim⟦1⟧.');
  });
});

describe('placeCitationMarkers', () => {
  test('places a marker at the end of the matched cited text', () => {
    const body = 'The sky is blue because of Rayleigh scattering. Water is wet.';
    const out = placeCitationMarkers(body, [{ n: 1, citedText: 'because of Rayleigh scattering' }]);
    expect(out).toContain('Rayleigh scattering⟦1⟧');
  });

  test('matches even after the chip pass wrapped a term in [[…]]', () => {
    // The final body has [[Rayleigh scattering]] but the cited text does not.
    const body = 'The sky is blue because of [[Rayleigh scattering]]. Water is wet.';
    const out = placeCitationMarkers(body, [{ n: 2, citedText: 'blue because of Rayleigh scattering' }]);
    expect(out).toContain(']]⟦2⟧');
  });

  test('one marker per source even if cited twice', () => {
    const body = 'Cats purr. Cats also knead.';
    const out = placeCitationMarkers(body, [
      { n: 1, citedText: 'Cats purr' },
      { n: 1, citedText: 'Cats also knead' },
    ]);
    expect(out.match(/⟦1⟧/g)?.length).toBe(1);
  });

  test('appends a trailing cluster for citations it cannot locate', () => {
    const body = 'A short node body.';
    const out = placeCitationMarkers(body, [{ n: 3, citedText: 'nothing that appears here at all' }]);
    expect(out.endsWith(marker(3))).toBe(true);
  });

  test('multiple placements keep offsets valid (right-to-left insert)', () => {
    const body = 'First fact here. Second fact there.';
    const out = placeCitationMarkers(body, [
      { n: 1, citedText: 'First fact here' },
      { n: 2, citedText: 'Second fact there' },
    ]);
    expect(out).toContain('First fact here⟦1⟧');
    expect(out).toContain('Second fact there⟦2⟧');
  });
});

describe('placeCitationMarkersExact', () => {
  test('inserts at the exact end offset', () => {
    const body = 'The sky is blue. Water is wet.';
    // end offset 15 = right after "blue"
    const out = placeCitationMarkersExact(body, [{ n: 1, endIndex: 15 }]);
    expect(out).toBe('The sky is blue⟦1⟧. Water is wet.');
  });
  test('clamps out-of-range offsets and dedupes by n', () => {
    const body = 'Short.';
    const out = placeCitationMarkersExact(body, [
      { n: 1, endIndex: 999 },
      { n: 1, endIndex: 0 }, // dup n ignored
    ]);
    expect(out).toBe('Short.⟦1⟧');
  });
  test('multiple offsets stay valid (right-to-left insert); ties render ascending', () => {
    const body = 'AAAA BBBB';
    const out = placeCitationMarkersExact(body, [
      { n: 2, endIndex: 9 },
      { n: 1, endIndex: 4 },
      { n: 3, endIndex: 4 }, // tie with n:1 at pos 4
    ]);
    expect(out).toBe('AAAA⟦1⟧⟦3⟧ BBBB⟦2⟧');
  });
});

describe('normalizeUrl', () => {
  test('lowercases host, drops www and a trailing slash', () => {
    expect(normalizeUrl('https://www.Example.com/a/')).toBe('example.com/a');
  });
  test('is stable for an already-normal url', () => {
    expect(normalizeUrl('https://example.com/a')).toBe('example.com/a');
  });
  test('keeps the query string (distinguishes pages)', () => {
    expect(normalizeUrl('https://x.com/p?id=7')).toBe('x.com/p?id=7');
  });
});

describe('placeCitationMarkersFromLinks', () => {
  test('returns null when the body has no markdown links (offset fallback)', () => {
    expect(placeCitationMarkersFromLinks('Plain body, no links here.', [src(1, 'https://a.com')])).toBe(null);
  });

  test('paren-wrapped cluster at paragraph end → glued markers after the word', () => {
    const body = 'Energy markets matter ([a.com](https://a.com/x), [b.com](https://b.com/y)).';
    const out = placeCitationMarkersFromLinks(body, [src(1, 'https://a.com/x'), src(2, 'https://b.com/y')]);
    expect(out).toBe('Energy markets matter⟦1⟧⟦2⟧.');
  });

  test('semicolon-separated per-sentence clusters → a marker run at each sentence end', () => {
    const body = 'Iran attacked ships ([a.com](https://a.com/x); [b.com](https://b.com/y)). '
      + 'Ukraine launched drones ([c.com](https://c.com/z)).';
    const out = placeCitationMarkersFromLinks(body, [
      src(1, 'https://a.com/x'), src(2, 'https://b.com/y'), src(3, 'https://c.com/z'),
    ]);
    expect(out).toBe('Iran attacked ships⟦1⟧⟦2⟧. Ukraine launched drones⟦3⟧.');
  });

  test('bare (unparenthesized) comma-separated links collapse and glue', () => {
    const body = 'Fact [a.com](https://a.com/x), [b.com](https://b.com/y).';
    const out = placeCitationMarkersFromLinks(body, [src(1, 'https://a.com/x'), src(2, 'https://b.com/y')]);
    expect(out).toBe('Fact⟦1⟧⟦2⟧.');
  });

  test('unknown-URL links are stripped, known become markers, no raw link text left', () => {
    const body = 'Fact one ([a.com](https://a.com/x)). Fact two ([weird.com](https://weird.com/q)).';
    const out = placeCitationMarkersFromLinks(body, [src(1, 'https://a.com/x')]);
    expect(out).toBe('Fact one⟦1⟧. Fact two.');
    expect(out).not.toContain('](');
  });

  test('matches sources by normalized URL (www / trailing slash / query)', () => {
    const body = 'A fact [example.com](https://example.com/article) and more ([news](https://news.site/p?id=7)).';
    const out = placeCitationMarkersFromLinks(body, [
      src(1, 'https://www.example.com/article/'), src(2, 'https://news.site/p?id=7'),
    ]);
    expect(out).toBe('A fact⟦1⟧ and more⟦2⟧.');
  });

  test('leaves ordinary parentheticals (with non-marker text) untouched', () => {
    const body = 'A fact (see the appendix) with a source [a.com](https://a.com/x).';
    const out = placeCitationMarkersFromLinks(body, [src(1, 'https://a.com/x')]);
    expect(out).toBe('A fact (see the appendix) with a source⟦1⟧.');
  });

  // Real captured GLM-5.2:online output (paragraph tail + a bullet), where the
  // annotation offsets were all (0,0) and GLM clustered its five markdown links
  // at the end of the opening paragraph. Markers must land there, glued, with no
  // raw link text surviving.
  test('real GLM output: five-link cluster lands at the paragraph end', () => {
    const body = 'These attacks threaten the fragile ceasefire, underscoring the strait\'s critical '
      + 'role in **global energy markets** ('
      + '[axios.com](https://www.axios.com/2026/07/07/iran-resumes-hormuz-attacks-us-officials), '
      + '[aljazeera.com](https://www.aljazeera.com/news/2026/7/7/tanker-on-fire-off-coast-of-oman-after-being-hit-by-projectile), '
      + '[businesstimes.com.sg](https://www.businesstimes.com.sg/international/global/qatari-lng-ship-struck-strait-hormuz-testing-us-talks), '
      + '[gcaptain.com](https://gcaptain.com/tanker-struck-by-projectile-near-hormuz-sparking-fire/), '
      + '[northernpublicradio.org](https://www.northernpublicradio.org/2026-07-07/tanker-set-ablaze-after-being-struck-by-projectile-in-strait-of-hormuz)).\n\n'
      + '- Background and Context';
    const sources = [
      src(1, 'https://www.axios.com/2026/07/07/iran-resumes-hormuz-attacks-us-officials'),
      src(2, 'https://www.aljazeera.com/news/2026/7/7/tanker-on-fire-off-coast-of-oman-after-being-hit-by-projectile'),
      src(3, 'https://www.businesstimes.com.sg/international/global/qatari-lng-ship-struck-strait-hormuz-testing-us-talks'),
      src(4, 'https://gcaptain.com/tanker-struck-by-projectile-near-hormuz-sparking-fire/'),
      src(5, 'https://www.northernpublicradio.org/2026-07-07/tanker-set-ablaze-after-being-struck-by-projectile-in-strait-of-hormuz'),
    ];
    const out = placeCitationMarkersFromLinks(body, sources)!;
    expect(out).toContain('**global energy markets**⟦1⟧⟦2⟧⟦3⟧⟦4⟧⟦5⟧.');
    expect(out).not.toContain('](');           // no raw markdown links left
    expect(out).toContain('\n\n- Background and Context'); // bullets untouched
    expect(out.indexOf('⟦1⟧')).toBeGreaterThan(40); // NOT clustered at the front
  });
});

describe('placeCitationMarkersFromLabels', () => {
  test('replaces Gemini bare domain labels with Scatter keys and restores sentence spacing', () => {
    const body = 'European weather shifts [met.ie].The late winter can turn colder [wordpress.com].';
    const out = placeCitationMarkersFromLabels(body, [
      src(1, 'https://met.ie/forecast'),
      src(2, 'https://wordpress.com/research'),
    ]);
    expect(out).toBe('European weather shifts⟦1⟧. The late winter can turn colder⟦2⟧.');
  });

  test('normalizes provider numeric labels only when they refer to returned sources', () => {
    const body = 'First claim [1, 2]. A literal range [7-9] remains.';
    const out = placeCitationMarkersFromLabels(body, [
      src(1, 'https://a.com'), src(2, 'https://b.com'),
    ]);
    expect(out).toBe('First claim⟦1⟧⟦2⟧. A literal range [7-9] remains.');
  });

  test('leaves ordinary bracketed prose and unknown domains untouched', () => {
    const body = 'The [Atlantic sector] differs from [unknown.example].';
    expect(placeCitationMarkersFromLabels(body, [src(1, 'https://met.ie')])).toBe(null);
  });
});

describe('placeCitationMarkersFromBareUrls', () => {
  test('replaces exact structured Google grounding redirects and no other URL', () => {
    const first = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQE1RGDAg0zcigRyLHWAGRQ4fj5259nNPZEDyk1JQctb6vxGHHQifyjF4Km28ay13X-M0C-TNrX3A81xlCaS4Npc7QRScEftHzwKuk9D2cBK8ZHeTbYBvD3orjG1dAmESvFMOgsNFi7tiOyPtp73NbINg064L__iUt5jJbb8u2uqcHknbBtCgjuvMJ1tPrpln0jyFgkr13VSYg==';
    const second = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEGhLd4Z5bsxEAJ7OgzBg2kUWNLNxPxILashGl6T6TX37DKQm_xonUF6flPOuSXWIlFJemmtiON-BoUQ_UlDeygDVkXwzxDgGtYdLf-9OJ-n';
    const body = `Pacific basin ${first}.\n\nNorth Atlantic Oscillation ${second}. Visit https://example.org normally.`;
    const out = placeCitationMarkersFromBareUrls(body, [src(1, first), src(2, second)]);
    expect(out).toBe(
      'Pacific basin⟦1⟧.\n\nNorth Atlantic Oscillation⟦2⟧. Visit https://example.org normally.',
    );
  });

  test('collapses wrappers around a known bare source URL', () => {
    expect(placeCitationMarkersFromBareUrls(
      'One claim (<https://a.com/source>), then another.',
      [src(1, 'https://a.com/source')],
    )).toBe('One claim⟦1⟧, then another.');
  });
});

describe('stripUnbackedCitationLabels', () => {
  test('removes unsupported numeric, domain, and markdown-link citations without joining sentences', () => {
    expect(stripUnbackedCitationLabels(
      'First claim [1].Second [met.ie].Third [source](https://example.com/page).',
    )).toBe('First claim. Second. Third.');
  });

  test('preserves ordinary bracketed prose', () => {
    const body = 'Values in [the Atlantic sector] remain relevant.';
    expect(stripUnbackedCitationLabels(body)).toBe(body);
  });
});

describe('placeCitationMarkersReliable', () => {
  test('uses valid provider offsets when no inline links are present', () => {
    const body = 'Opening fact.\n\n- Details';
    const citations = [{ url: 'https://a.com', endIndex: 12 }];
    expect(placeCitationMarkersReliable(body, citations, [src(1, 'https://a.com')])).toBe(
      'Opening fact⟦1⟧.\n\n- Details',
    );
  });

  test('does not append a second key when a structured citation also appears as a bare domain label', () => {
    const body = 'El Niño influences Europe [met.ie].The effect is indirect [yale.edu].';
    const citations = [
      { url: 'https://met.ie/climate/el-nino', title: 'met.ie', startIndex: 27, endIndex: 35 },
      { url: 'https://yale.edu/climate', title: 'yale.edu', startIndex: 59, endIndex: 69 },
    ];
    expect(placeCitationMarkersReliable(body, citations, [
      src(1, 'https://met.ie/climate/el-nino'),
      src(2, 'https://yale.edu/climate'),
    ])).toBe('El Niño influences Europe⟦1⟧. The effect is indirect⟦2⟧.');
  });

  test('uses an annotated bracket span even when a Google redirect title cannot identify its visible label', () => {
    const body = 'European weather shifts [met.ie].The next sentence starts here.';
    const labelStart = body.indexOf('[met.ie]');
    const citations = [{
      url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/opaque',
      title: 'European Seasonal Forecast — Met Éireann',
      startIndex: labelStart,
      endIndex: labelStart + '[met.ie]'.length,
    }];
    const sources = buildSources(citations);
    expect(sources[0]?.domain).toBe('European Seasonal Forecast — Met Éireann');
    expect(placeCitationMarkersReliable(body, citations, sources)).toBe(
      'European weather shifts⟦1⟧. The next sentence starts here.',
    );
  });

  test('never inserts a citation-label offset into the middle of a word', () => {
    const body = 'Opening overview.\n\n- Effects\n  - Agriculture: Mediterranean crops can be affected.';
    const middleOfWord = body.indexOf('Mediterranean') + 2;
    const citations = [{
      url: 'https://example.com/source',
      title: 'Example source',
      startIndex: middleOfWord - 1,
      endIndex: middleOfWord,
      offsetKind: 'citation-label' as const,
    }];
    const out = placeCitationMarkersReliable(body, citations, buildSources(citations));
    expect(out).toBe('Opening overview⟦1⟧.\n\n- Effects\n  - Agriculture: Mediterranean crops can be affected.');
    expect(out).not.toContain('Me⟦1⟧diterranean');
  });

  test('falls back the entire OpenRouter citation cluster instead of placing it before the next bullet', () => {
    const body = 'Opening overview.\n\n- Mechanisms\n  - First: supported claim.\n  - Second: another claim.';
    const nextBullet = body.indexOf('  - Second');
    const citations = [1, 2, 3, 4].map((n) => ({
      url: `https://source${n}.example/page`,
      title: `Source ${n}`,
      startIndex: nextBullet - 1,
      endIndex: nextBullet,
      offsetKind: 'citation-label' as const,
    }));
    const out = placeCitationMarkersReliable(body, citations, buildSources(citations));
    expect(out).toBe(
      'Opening overview⟦1⟧⟦2⟧⟦3⟧⟦4⟧.\n\n- Mechanisms\n  - First: supported claim.\n  - Second: another claim.',
    );
  });

  test('normalizes the exact bare Gemini redirects from the reported European-weather output', () => {
    const first = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQE1RGDAg0zcigRyLHWAGRQ4fj5259nNPZEDyk1JQctb6vxGHHQifyjF4Km28ay13X-M0C-TNrX3A81xlCaS4Npc7QRScEftHzwKuk9D2cBK8ZHeTbYBvD3orjG1dAmESvFMOgsNFi7tiOyPtp73NbINg064L__iUt5jJbb8u2uqcHknbBtCgjuvMJ1tPrpln0jyFgkr13VSYg==';
    const second = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEGhLd4Z5bsxEAJ7OgzBg2kUWNLNxPxILashGl6T6TX37DKQm_xonUF6flPOuSXWIlFJemmtiON-BoUQ_UlDeygDVkXwzxDgGtYdLf-9OJ-n';
    const body = `El Niño has **indirect effects** in the **Pacific basin** ${first}.\n\n`
      + `These **teleconnections** involve the **North Atlantic Oscillation** ${second}.`;
    const citations = [first, second].map((url, index) => ({
      url,
      title: index ? 'North Atlantic source' : 'Pacific source',
      startIndex: 20 + index,
      endIndex: 21 + index,
      offsetKind: 'citation-label' as const,
    }));
    const sources = buildSources(citations);
    const placed = placeCitationMarkersReliable(body, citations, sources);
    const normalized = renumberCitations(placed, sources);
    expect(normalized.body).toBe(
      'El Niño has **indirect effects** in the **Pacific basin**⟦1⟧.\n\n'
      + 'These **teleconnections** involve the **North Atlantic Oscillation**⟦2⟧.',
    );
    expect(normalized.body).not.toContain('vertexaisearch');
    expect(normalized.sources).toHaveLength(2);
  });

  test('keeps GLM inline links in place and puts only unplaceable sources at the opening paragraph end', () => {
    const body = 'Opening summary.\n\n- First: supported [a.com](https://a.com/x).\n- Second: uncited.';
    const citations = [
      { url: 'https://a.com/x', startIndex: 0, endIndex: 0 },
      { url: 'https://b.com/y', startIndex: 0, endIndex: 0 },
    ];
    const out = placeCitationMarkersReliable(body, citations, [
      src(1, 'https://a.com/x'), src(2, 'https://b.com/y'),
    ]);
    expect(out).toBe('Opening summary⟦2⟧.\n\n- First: supported⟦1⟧.\n- Second: uncited.');
  });

  test('puts unplaceable partial-rewrite sources at the fragment end', () => {
    const body = '  - Result: rewritten detail.';
    const citations = [{ url: 'https://a.com', startIndex: 0, endIndex: 0 }];
    expect(placeCitationMarkersReliable(body, citations, [src(1, 'https://a.com')], 'fragment-end')).toBe(
      '  - Result: rewritten detail.⟦1⟧',
    );
  });

  test('uses the blank-line boundary rather than an incidental line wrap inside the opening paragraph', () => {
    const body = 'Opening first sentence.\nOpening second sentence.\n\n- Details';
    const citations = [{ url: 'https://a.com', startIndex: 0, endIndex: 0 }];
    expect(placeCitationMarkersReliable(body, citations, [src(1, 'https://a.com')])).toBe(
      'Opening first sentence.\nOpening second sentence⟦1⟧.\n\n- Details',
    );
  });
});

describe('renumberCitations', () => {
  const src = (n: number, dom: string): NodeSource => ({ n, url: `https://${dom}`, domain: dom });
  test('remaps non-contiguous survivors to 1..k in reading order', () => {
    const body = 'first⟦3⟧ then⟦1⟧ last';
    const sources = [src(1, 'a.com'), src(3, 'c.com')];
    const out = renumberCitations(body, sources);
    expect(out.body).toBe('first⟦1⟧ then⟦2⟧ last');
    expect(out.sources.map((s) => [s.n, s.domain])).toEqual([[1, 'c.com'], [2, 'a.com']]);
  });
  test('drops orphan markers with no source and prunes unused sources', () => {
    const body = 'kept⟦2⟧ orphan⟦9⟧';
    const sources = [src(2, 'b.com'), src(5, 'unused.com')];
    const out = renumberCitations(body, sources);
    expect(out.body).toBe('kept⟦1⟧ orphan');
    expect(out.sources).toEqual([{ n: 1, url: 'https://b.com', domain: 'b.com' }]);
  });
});
