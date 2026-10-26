import { describe, it, expect, afterEach } from 'vitest';
import { collectSearchRanges, matchingBulletIndices } from './searchHighlight';
import { parseBody } from './bulletParse';

/* Regression: the left-margin bullet MARKER (data-driven, sees collapsed
 * detail) must agree with the in-text HIGHLIGHT (DOM-driven, on visible
 * text). When a bullet is fully expanded the two should flag the same
 * bullets — otherwise a marker appears on a bullet that highlights nothing
 * when you open it. Previously the marker matched each bullet in isolation
 * and over-matched (e.g. "zebra" / "cycle" / "lactic"). */

const BODY =
  'Intro paragraph about cellular biology metabolism and energy production overall.\n\n' +
  '- Glycolysis pathway overview\n' +
  '  - Step one: glucose phosphorylation occurs very early in the process\n' +
  '  - Step two: fructose bisphosphate forms next after isomerization happens\n' +
  '- Krebs cycle details\n' +
  '  - Citrate: forms from acetyl coenzyme a joining oxaloacetate molecules\n' +
  '  - Succinate: an important intermediate found within the cycle itself\n' +
  '- Electron transport chain\n' +
  '  - Complex one: nadh dehydrogenase pumps protons across the membrane\n' +
  '  - Complex four: cytochrome c oxidase performs the final electron step\n' +
  '- Fermentation routes summary\n' +
  '  - Lactic acid: builds up in muscle cells under heavy exertion load\n' +
  '  - Ethanol path: produces zebraword inside yeast cells during anaerobics';

// AdaptiveBullets-like VISIBLE DOM, all bullets fully expanded.
function buildDom(body: string): HTMLElement {
  const parsed = parseBody(body)!;
  const root = document.createElement('div');
  root.dataset.nodeId = 'n1';
  const nb = document.createElement('div');
  nb.className = 'node-body';
  const ft = document.createElement('div');
  ft.className = 'sc-ab-freetext';
  ft.textContent = parsed.freeText;
  nb.appendChild(ft);
  const ul = document.createElement('ul');
  ul.className = 'sc-ab-list';
  parsed.bullets.forEach((b, i) => {
    const li = document.createElement('li');
    li.className = 'sc-ab-item';
    li.dataset.scAnchor = `b-${i}`;
    li.innerHTML =
      `<div class="sc-ab-title"><span class="sc-ab-bullet-mark">•</span><span class="sc-ab-title-text">${b.title}</span></div>` +
      b.children
        .map(
          (c) =>
            `<div class="sc-ab-described"><span class="sc-ab-child-mark">•</span><span class="sc-ab-name">${c.name}</span><span class="sc-ab-sep">: </span><span class="sc-ab-desc">${c.desc}</span></div>`,
        )
        .join('');
    ul.appendChild(li);
  });
  nb.appendChild(ul);
  root.appendChild(nb);
  document.body.appendChild(root);
  return root;
}

function highlightedBullets(root: HTMLElement, q: string): number[] {
  const set = new Set<number>();
  for (const r of collectSearchRanges(root, q)) {
    const el = r.startContainer.parentElement?.closest('.sc-ab-item[data-sc-anchor]') as HTMLElement | null;
    if (el?.dataset.scAnchor) set.add(Number(el.dataset.scAnchor.slice(2)));
  }
  return [...set].sort((a, b) => a - b);
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('marker ⟺ highlight consistency (expanded bullets)', () => {
  const queries = [
    'zebraword', 'zebra', 'ethanol', 'fermentation', 'glucose', 'phosphorylation',
    'cytochrome', 'complex', 'cycle', 'glycol', 'oxidase', 'isomer',
    'membrane', 'anaerobic', 'lactic', 'transport',
  ];

  for (const q of queries) {
    it(`"${q}": marker bullets == highlighted bullets`, () => {
      const root = buildDom(BODY);
      expect(matchingBulletIndices(BODY, q)).toEqual(highlightedBullets(root, q));
    });
  }
});
