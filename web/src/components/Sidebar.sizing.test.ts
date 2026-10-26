import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'app', 'globals.css'), 'utf8');
const sidebarSource = readFileSync(join(here, 'Sidebar.tsx'), 'utf8');
const navActionsSource = readFileSync(join(here, 'NavActions.tsx'), 'utf8');
const modelPickerSource = readFileSync(join(here, 'SidebarModelPicker.tsx'), 'utf8');
const canvasToolbarSource = readFileSync(join(here, 'canvas', 'CanvasToolbar.tsx'), 'utf8');
const settingsSource = readFileSync(join(here, 'SettingsModal.tsx'), 'utf8');
const settingsCss = readFileSync(join(here, '..', 'app', 'settings.css'), 'utf8');
const nodeBodySource = readFileSync(join(here, 'node', 'NodeBody.tsx'), 'utf8');
const pixelRulerSource = readFileSync(join(here, 'dev', 'PixelRuler.tsx'), 'utf8');
const pageSource = readFileSync(join(here, '..', 'app', 'page.tsx'), 'utf8');

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`rule not found: ${selector}`);
  return match[1]!;
}

describe('app sidebar sizing contract', () => {
  it('uses 14px Projects and Groups headings and rows', () => {
    expect(ruleBody('.sidebar-section-title')).toMatch(/font-size:\s*14px\s*;/);
    expect(ruleBody('.sidebar-row')).toMatch(/font-size:\s*14px\s*;/);
  });

  it('keeps shortcuts quiet at 11px without reserving toolbar space for tooltips', () => {
    const shortcuts = ruleBody('.sidebar-shortcuts');
    expect(shortcuts).toMatch(/font-size:\s*11px\s*;/);
    expect(shortcuts).toMatch(/line-height:\s*1\.35\s*;/);
    expect(shortcuts).toMatch(/font-family:\s*ui-monospace/);
    expect(shortcuts).not.toMatch(/font-weight:\s*700/);
    expect(shortcuts).not.toMatch(/color:\s*var\(--subtext1\)/);
    expect(ruleBody('.shortcut-keys')).toMatch(/color:\s*var\(--subtext0\)\s*;/);
    expect(ruleBody('.shortcut-hint')).toMatch(/color:\s*var\(--overlay1\)\s*;/);

    expect(sidebarSource).not.toContain('TooltipBar');
    expect(css).not.toContain('.tooltip-bar');
    expect(ruleBody('.app-control-tooltip')).toMatch(/width:\s*max-content/);
  });

  it('uses equal shortcut insets and bounded columns so long keys cannot displace hints', () => {
    expect(ruleBody('.sidebar-shortcuts')).toMatch(/padding-inline:\s*12px\s*;/);
    const row = ruleBody('.sidebar-shortcut');
    expect(row).toMatch(/display:\s*grid\s*;/);
    expect(row).toMatch(/grid-template-columns:\s*96px minmax\(0,\s*1fr\)\s*;/);
    expect(ruleBody('.shortcut-keys')).toMatch(/min-width:\s*0\s*;/);
    const keyPart = ruleBody('.shortcut-key-part');
    expect(keyPart).toMatch(/max-width:\s*100%\s*;/);
    expect(keyPart).toMatch(/overflow-wrap:\s*anywhere\s*;/);
  });

  it('reduces shortcut height without smaller text, clipping, or a smaller collapse target', () => {
    const shortcuts = ruleBody('.sidebar-shortcuts');
    expect(shortcuts).toMatch(/gap:\s*0\s*;/);
    expect(shortcuts).toMatch(/padding-block:\s*3px 5px\s*;/);
    expect(shortcuts).toMatch(/font-size:\s*11px\s*;/);
    expect(shortcuts).not.toMatch(/(?:^|\n)\s*(?:(?:max-)?height:|overflow:\s*hidden|(?:-\w+-)?line-clamp:)/);
    expect(ruleBody('.sidebar-shortcuts-title')).toMatch(/min-height:\s*28px\s*;/);
  });

  it('uses readable welcome-screen actions and minimum pager targets', () => {
    expect(ruleBody('.topic-recommend')).toMatch(/font-size:\s*14px\s*;/);
    expect(ruleBody('.recent-query')).toMatch(/font-size:\s*14px\s*;/);
    expect(ruleBody('.recent-clear')).toMatch(/font-size:\s*14px\s*;/);

    const pagerButton = ruleBody('.recent-pager button');
    expect(pagerButton).toMatch(/width:\s*24px\s*;/);
    expect(pagerButton).toMatch(/height:\s*24px\s*;/);
  });

  it('keeps node utility buttons compact while aligning their row with normal actions', () => {
    expect(ruleBody('.versions-row')).toMatch(/padding:\s*4px 0\s*;/);

    const utilityButton = ruleBody('.versions-row button');
    expect(utilityButton).toMatch(/width:\s*24px\s*;/);
    expect(utilityButton).toMatch(/height:\s*24px\s*;/);
  });

  it('uses readable onboarding model and provider text', () => {
    expect(ruleBody('.sc-model-item')).toMatch(/font-size:\s*14px\s*;/);
    expect(ruleBody('.welcome-provider-row')).toMatch(/font-size:\s*14px\s*;/);
    expect(ruleBody('.welcome-model-group-head')).toMatch(/font-size:\s*12px\s*;/);
  });

  it('uses readable image-editor controls and comfortable tool targets', () => {
    const tool = ruleBody('.ie-tool');
    expect(tool).toMatch(/width:\s*32px\s*;/);
    expect(tool).toMatch(/height:\s*32px\s*;/);
    expect(ruleBody('.ie-tool--label')).toMatch(/font-size:\s*14px\s*;/);
    expect(ruleBody('.ie-dd-btn')).toMatch(/font-size:\s*14px\s*;/);
    expect(ruleBody('.ie-dd-item-label')).toMatch(/font-size:\s*14px\s*;/);
    expect(ruleBody('.ie-dd-item-sub')).toMatch(/font-size:\s*12px\s*;/);
  });

  it('aligns search and sections to an 8px inset with a 4px vertical rhythm', () => {
    const searchWrap = ruleBody('.search-wrap');
    expect(searchWrap).toMatch(/padding:\s*8px 8px 4px\s*;/);
    expect(ruleBody('.search-input')).toMatch(/font-size:\s*14px\s*;/);
    expect(ruleBody('.search-input')).toMatch(/height:\s*32px\s*;/);
    expect(ruleBody('.search-icon')).toMatch(/left:\s*17px\s*;/);
    expect(ruleBody('.search-icon')).toMatch(/top:\s*24px\s*;/);
    const searchClear = ruleBody('.search-clear');
    expect(searchClear).toMatch(/right:\s*11px\s*;/);
    expect(searchClear).toMatch(/top:\s*24px\s*;/);
    expect(searchClear).toMatch(/width:\s*24px\s*;/);
    expect(searchClear).toMatch(/height:\s*24px\s*;/);

    const section = ruleBody('.sidebar-section');
    expect(section).toMatch(/padding:\s*0 8px 4px\s*;/);
    expect(section).toMatch(/gap:\s*4px\s*;/);
    expect(sidebarSource).not.toContain('sidebar-divider');
  });

  it('uses the approved sidebar metadata sizes', () => {
    expect(ruleBody('.search-results-caption')).toMatch(/font-size:\s*12px\s*;/);
    expect(ruleBody('.sc-modelpicker-btn')).toMatch(/font-size:\s*12px\s*;/);
    expect(ruleBody('.zoom-readout')).toMatch(/font-size:\s*12px\s*;/);
    expect(ruleBody('.sc-modelpicker-group-head')).toMatch(/font-size:\s*12px\s*;/);
  });

  it('raises every application 10px text rule to at least 11px', () => {
    expect(css).not.toMatch(/font-size:\s*10px\s*;/);
    expect(pixelRulerSource).not.toMatch(/fontSize:\s*10,/);
    expect(pixelRulerSource.match(/fontSize:\s*11,/g)).toHaveLength(2);
  });

  it('gives the New Project and New Group controls centered 24px targets', () => {
    const addButton = ruleBody('.sidebar-section-add');
    expect(addButton).toMatch(/width:\s*24px\s*;/);
    expect(addButton).toMatch(/height:\s*24px\s*;/);
    expect(addButton).toMatch(/padding:\s*0\s*;/);
    expect(addButton).toMatch(/justify-content:\s*center\s*;/);
  });

  it('uses a 16px plus glyph in both add controls', () => {
    expect(sidebarSource.match(/<Plus\s+size=\{16\}\s*\/>/g)).toHaveLength(2);
  });

  it('melds the expanded model and navigation rows into one compact panel', () => {
    const panel = ruleBody('.sidebar-control-panel');
    expect(panel).toMatch(/margin:\s*0\s*;/);
    expect(panel).toMatch(/flex-shrink:\s*0\s*;/);
    expect(panel).not.toMatch(/background:/);
    expect(panel).not.toMatch(/border(?:-radius)?:/);
    expect(panel).not.toMatch(/box-shadow:/);
    expect(panel).not.toMatch(/isolation:/);

    const footer = ruleBody('.sidebar-footer');
    expect(footer).toMatch(/padding:\s*4px 12px 6px\s*;/);
    expect(footer).toMatch(/gap:\s*8px\s*;/);

    const buttons = ruleBody('.sidebar-footer .icon-btn');
    expect(buttons).toMatch(/width:\s*24px\s*;/);
    expect(buttons).toMatch(/height:\s*24px\s*;/);
    expect(buttons).toMatch(/flex:\s*0 0 24px\s*;/);

    expect(sidebarSource).not.toContain('ZoomReadout');
    expect(sidebarSource).not.toContain('onOpenSettings={onOpenSettings} spaceFiller');
    expect(sidebarSource.indexOf('variant="toolbar"'))
      .toBeLessThan(sidebarSource.indexOf('className="sidebar-footer"'));
  });

  it('fills the source-control row with symmetric toolbar padding', () => {
    expect(css).toMatch(
      /\.sidebar-control-panel > \.source-controls,\s*\.canvas-topright > \.source-controls\s*\{\s*padding-inline:\s*6px\s*;/,
    );
    expect(css).toMatch(
      /\.sidebar-control-panel > \.source-controls \.source-mode-dropdown,\s*\.canvas-topright > \.source-controls \.source-mode-dropdown\s*\{\s*flex:\s*1 1 auto\s*;/,
    );
    expect(css).toMatch(
      /\.sidebar-control-panel > \.source-controls \.source-mode-trigger,\s*\.canvas-topright > \.source-controls \.source-mode-trigger\s*\{[^}]*width:\s*100%\s*;[^}]*justify-content:\s*space-between\s*;/,
    );
  });

  it('keeps source labels at the same size in the sidebar, fullscreen toolbar, and restoration shell', () => {
    const sourceLabelSizing = ruleBody(
      '.sidebar-control-panel > .source-controls,\n'
      + '.canvas-topright > .source-controls,\n'
      + '.project-restoration-sidebar .source-controls',
    );
    expect(sourceLabelSizing).toMatch(/font-size:\s*12px\s*;/);
  });

  it('uses the larger collapsed canvas-toolbar controls', () => {
    const toolbar = ruleBody('.canvas-toolbar');
    expect(toolbar).toMatch(/gap:\s*2px\s*;/);
    expect(toolbar).toMatch(/padding:\s*4px 1px\s*;/);

    const panel = ruleBody('.canvas-topright');
    expect(panel).toMatch(/width:\s*240px\s*;/);
    expect(panel).toMatch(/box-sizing:\s*border-box\s*;/);

    const buttons = ruleBody('.canvas-toolbar .icon-btn');
    expect(buttons).toMatch(/width:\s*32px\s*;/);
    expect(buttons).toMatch(/height:\s*32px\s*;/);
    expect(buttons).toMatch(/flex:\s*0 0 32px\s*;/);

    expect(canvasToolbarSource).not.toContain('ZoomReadout');
  });

  it('makes the collapse and reveal controls visually uniform', () => {
    for (const selector of ['.sidebar-toggle', '.sidebar-reveal-btn']) {
      const rule = ruleBody(selector);
      expect(rule).toMatch(/width:\s*32px\s*;/);
      expect(rule).toMatch(/height:\s*32px\s*;/);
      expect(rule).toMatch(/border-radius:\s*var\(--r-md\)\s*;/);
    }
    expect(ruleBody('.sidebar-toggle')).toMatch(/position:\s*static\s*;/);
    expect(ruleBody('.sidebar-toggle')).toMatch(/background:\s*transparent\s*;/);
    expect(sidebarSource.match(/<PanelLeft(?:Open|Close)\s+size=\{20\}\s*\/>/g)).toHaveLength(2);
    expect(pageSource).toMatch(/<PanelLeftOpen\s+size=\{20\}\s*\/>/);
  });

  it('uses the pixel font for a left-aligned Scatter wordmark', () => {
    const wordmark = ruleBody('.app-wordmark');
    expect(wordmark).toMatch(/font-family:\s*'Press Start 2P',\s*monospace\s*;/);
    expect(wordmark).toMatch(/justify-content:\s*flex-start\s*;/);
    expect(wordmark).toMatch(/font-size:\s*16px\s*;/);
    expect(wordmark).toMatch(/padding-block:\s*3\.2px\s*;/);
    expect(wordmark).toMatch(/transform:\s*translateY\(2px\)\s*;/);
  });

  it('strongly mutes disabled section chevrons without muting their labels', () => {
    expect(ruleBody('.sidebar-section-toggle[aria-disabled="true"] svg')).toMatch(/opacity:\s*0\.22\s*;/);
    expect(ruleBody('.sidebar-section-toggle[aria-disabled="true"]')).not.toMatch(/opacity\s*:/);
  });

  it('shows the blocked cursor only during an attempted disabled press', () => {
    expect(ruleBody(':disabled, [disabled], [aria-disabled="true"]'))
      .toMatch(/cursor:\s*var\(--cur-click\)\s*!important\s*;/);
    expect(ruleBody('html.sc-disabled-pressing, html.sc-disabled-pressing *'))
      .toMatch(/cursor:\s*var\(--cur-ban\)\s*!important\s*;/);
  });

  it('uses symmetric two-pixel scrollbar breathing room', () => {
    for (const selector of ['.sidebar-section-body', '.group-popover-existing']) {
      const rule = ruleBody(selector);
      expect(rule).toMatch(/padding-right:\s*2px\s*;/);
      expect(rule).toMatch(/margin-right:\s*-6px\s*;/);
      expect(rule).toMatch(/scrollbar-gutter:\s*stable\s*;/);
    }
  });

  it('gives sidebar add buttons the standard hover fill', () => {
    expect(ruleBody('.sidebar-section-add:hover')).toMatch(/background:\s*var\(--tint-3\)\s*;/);
  });

  it('shows colored borders only with the shared 4/6/8/9% dark highlight ladder', () => {
    expect(css).toMatch(/--tint-3:\s*color-mix\(in oklab,\s*var\(--text\)\s*5%/);
    expect(css).toMatch(/--tint-4:\s*color-mix\(in oklab,\s*var\(--text\)\s*7%/);
    expect(css).toMatch(
      /\[data-theme="mocha"\] button:where\(:not\(\.ref-chip\)[^{]+\{[^}]*outline:\s*none\s*;/s,
    );
    expect(css).toMatch(
      /button\.btn-primary,[\s\S]*?button\.te-modify-btn[\s\S]*?\)\s*\{[^}]*var\(--control-accent,\s*var\(--text\)\)\s*4%[^}]*outline:\s*1px/s,
    );
    expect(css).toMatch(
      /button:not\(:disabled\)[^{]+:is\(:hover,\s*:focus-visible\)\s*\{[^}]*var\(--control-accent,\s*var\(--text\)\)\s*6%[^}]*outline:\s*1px/s,
    );
    expect(css).toMatch(
      /\[data-theme="mocha"\] button:not\(\.ref-chip\)[^{]+:is\([\s\S]*?\)\s*,\s*\n\[data-theme="mocha"\] button:not\(:disabled\)[^{]+:active\s*\{[^}]*var\(--control-accent,\s*var\(--text\)\)\s*8%[^}]*outline:\s*2px/s,
    );
    expect(css).toMatch(
      /\[data-theme="mocha"\] :is\(\.sidebar-row\.has-accent,\s*\.group-popover-row\.has-accent\)\s*\{[^}]*var\(--row-accent\)\s*4%[^}]*outline:\s*1px solid[^}]*var\(--row-accent\)\s*50%/s,
    );
    // History entries deliberately have no colored rest state; their project
    // color appears only once that exact entry is hovered or keyboard-focused.
    expect(css).toMatch(
      /\[data-theme="mocha"\] \.recent-row\.has-accent:is\(:hover,\s*:focus-visible\)\s*\{[^}]*var\(--row-accent\)\s*6%[^}]*outline:\s*1px solid[^}]*var\(--row-accent\)\s*70%/s,
    );
    expect(css).toMatch(
      /\.active[\s\S]*?:hover\s*\{[^}]*var\(--control-accent,\s*var\(--text\)\)\s*9%/s,
    );
    expect(pageSource).toContain("'--control-accent': colorToCss(project.color)");

    // The original light-theme rules remain untouched.
    expect(ruleBody('.icon-btn:hover')).toMatch(/background:\s*var\(--tint-3\)/);
    expect(ruleBody('.sidebar-row.has-accent.active')).toMatch(/var\(--row-accent\)\s*30%/);
  });

  it('uses the approved toolbar and model-picker glyph sizes', () => {
    expect(navActionsSource.match(/size=\{16\}/g)).toHaveLength(7);
    expect(navActionsSource).not.toMatch(/size=\{14\}/);
    expect(modelPickerSource).toContain('<Globe size={16} />');
    // Crop unused SVG side bearings without shrinking the chevron's strokes.
    expect(modelPickerSource).toContain('<ChevronsUpDown viewBox="6 0 12 24" width={8} height={16} />');
    expect(ruleBody('.sc-language-trigger')).toMatch(/font-size:\s*13px\s*;/);
    expect(ruleBody('.sc-language-trigger-label')).toMatch(/transform:\s*translateY\(10%\)\s*;/);
    expect(ruleBody('.sc-modelpicker-label')).toMatch(/word-spacing:\s*-0\.5ch\s*;/);
    expect(navActionsSource).toContain('<ThemeToggleButton />');
    expect(navActionsSource.indexOf('<ThemeToggleButton />'))
      .toBeLessThan(navActionsSource.indexOf('data-testid="settings-gear"'));

    const webSearch = ruleBody('.sc-modelpicker-websearch');
    expect(webSearch).toMatch(/width:\s*32px\s*;/);
    expect(webSearch).toMatch(/height:\s*32px\s*;/);
  });

  it('uses the approved Settings and standard button typography', () => {
    expect(ruleBody('.btn')).toMatch(/font-size:\s*14px\s*;/);
    expect(ruleBody('.modal-tab')).toMatch(/font-size:\s*14px\s*;/);
    expect(ruleBody('.field-help')).toMatch(/font-size:\s*12px\s*;/);
    expect(ruleBody('.suggest-pill')).toMatch(/font-size:\s*14px\s*;/);

    const modelRow = ruleBody('.modal .sc-model-item');
    expect(modelRow).toMatch(/font-size:\s*14px\s*;/);
    expect(modelRow).toMatch(/min-height:\s*32px\s*;/);
  });

  it('gives Settings controls the approved target sizes', () => {
    const close = ruleBody('.modal-header .icon-btn');
    expect(close).toMatch(/width:\s*32px\s*;/);
    expect(close).toMatch(/height:\s*32px\s*;/);

    const direction = ruleBody('.accent-dir-toggle button');
    expect(direction).toMatch(/min-width:\s*24px\s*;/);
    expect(direction).toMatch(/height:\s*24px\s*;/);
    expect(direction).toMatch(/font-size:\s*14px\s*;/);

    const pill = ruleBody('.kbd-pill');
    expect(pill).toMatch(/min-height:\s*24px\s*;/);
    expect(pill).toMatch(/font-size:\s*14px\s*;/);

    const pillButton = ruleBody('.kbd-pill-btn');
    expect(pillButton).toMatch(/min-width:\s*24px\s*;/);
    expect(pillButton).toMatch(/min-height:\s*24px\s*;/);

    const shortcutAction = ruleBody('.shortcut-action-btn');
    expect(shortcutAction).toMatch(/min-width:\s*24px\s*;/);
    expect(shortcutAction).toMatch(/min-height:\s*24px\s*;/);
    expect(shortcutAction).toMatch(/font-size:\s*14px\s*;/);
  });

  it('uses readable Settings glyphs without changing unrelated icons', () => {
    expect(settingsSource.match(/<X\s+size=\{16\}\s*\/>/g)).toHaveLength(1);
    const shortcuts = settingsSource.slice(settingsSource.indexOf('function ShortcutsTab'), settingsSource.indexOf('function DataTab'));
    expect(shortcuts.match(/<(?:Pencil|X|Plus|RotateCcw)\s+size=\{14\}\s*\/>/g)).toHaveLength(4);
    expect(settingsSource).toMatch(/style=\{\{ width: 48, flexShrink: 0 \}\}/);
    expect(settingsCss).toMatch(/\.settings-modal \.field-help\s*\{[^}]*font-size:\s*12px/);
    // Compact font metadata and diagnostic status labels intentionally use
    // 10px; the field/help/control sizes are asserted individually above.
    expect(settingsCss).not.toMatch(/font-size:\s*[0-9]px/);
  });

  it('uses 12px generation error and retry text', () => {
    expect(ruleBody('.node-generation-error')).toMatch(/font-size:\s*12px\s*;/);
    expect(ruleBody('.node-generation-error button')).toMatch(/font:\s*inherit\s*;/);
    expect(nodeBodySource).not.toMatch(/fontSize:\s*11,/);
  });
});
