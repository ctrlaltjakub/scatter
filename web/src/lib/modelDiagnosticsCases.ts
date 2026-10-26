import type { ModelRole, Settings } from '@/store/types';
import type { ChatMessage, TaskVariant } from './promptBuilder';
import { buildMessages, buildFollowUpClassifierPrompt } from './promptBuilder';
import { effectivePrompt, substitute } from './promptDefaults';
import { chatFormattingPrompt } from './chatFormatting';
import { termSelectionPrompt } from './termSelectionPrompt';
import { applyTermSelection, markedTerms, stripTermMarkers } from './termMarking';
import { previewRequest, inspectTermPreviews } from './termPreviewCore';
import { GenerationResponseError, parseResponseJson, validateEncyclopedicOutput } from './generationValidation';
import { parseFactCheckFinding } from './factCheckCore';
import { languageInfo, languageDirection } from './languages';
import { factCheckMessages } from './factCheckRequest';

export interface ModelDiagnosticCase {
  id: string; label: string; role: ModelRole;
  kind: 'text' | 'vision' | 'search' | 'fact-check' | 'tools' | 'interactive' | 'image-generate' | 'image-edit';
  messages: ChatMessage[];
  /** Task allowance before scaling by the user's configured role limit. */
  tokens?: number;
  requests: number;
  validate?: (text: string) => void;
  modify?: boolean;
  repair?: boolean;
}
export const DIAGNOSTIC_TEXT = '**Triangle perimeter** is the **distance around** a triangle.\n\n- Calculation\n  - Addition: Add all three side lengths.\n  - Units: Use the same unit for every side.\n- Examples\n  - Equilateral triangle: Three equal sides give three times one side.\n  - Scalene triangle: Sides of 3, 4 and 5 cm give a perimeter of 12 cm.';
const context = { parent: { header: 'Triangle perimeter', body: DIAGNOSTIC_TEXT }, grandparent: null };
export function assertDiagnostic(condition: unknown, message: string): asserts condition {
  if (!condition) throw new GenerationResponseError('wrong_result', message, 'Retry once; if it repeats, check the system prompt or choose a stronger model.');
}
const prose = (text: string) => assertDiagnostic(!/^\s*(?:#{1,6} |[-*] |```)/m.test(text), 'The explanation used outline/code formatting instead of prose.');
const table = (text: string) => assertDiagnostic(/\|[^\n]+\|/.test(text) && /\|\s*:?-{3,}/.test(text), 'The requested Markdown table is missing or malformed.');

/** Small, fixed fixtures exercise production prompts without graph writes.
 * Root/regenerate and empty-node generation share one prompt and one test. */
export function modelDiagnosticCases(settings: Settings): ModelDiagnosticCase[] {
  const cases: ModelDiagnosticCase[] = [];
  const prompt = (key: Parameters<typeof effectivePrompt>[0], values: Record<string, string> = {}) => substitute(effectivePrompt(key, settings.customPrompts), values);
  const pair = (system: string, user: string): ChatMessage[] => [{ role: 'system', content: system }, { role: 'user', content: user }];
  const language = languageInfo(settings.generationLanguage);
  const languagePrompt = prompt('generationLanguage', { language: language.name, locale: language.locale, direction: languageDirection(language.id) === 'rtl' ? 'right-to-left' : 'left-to-right' });
  const waterNames = { en: /water/i, zh: /水/, es: /agua/i, fr: /eau/i, de: /wasser/i, pt: /água/i,
    it: /acqua/i, ja: /水/, ru: /вод[аыуеой]/i, ko: /물/, nl: /water/i, pl: /wod[ayęązie]/i,
    id: /air/i, sv: /vatten/i, ar: /ماء|الماء/, hi: /पानी|जल/, tr: /su/i, vi: /nước/i, cs: /vod[ayěou]/i, uk: /вод[аиуоюі]/i };
  cases.push({ id: 'generation-language', label: `Generation language · ${language.name}`, role: 'main', kind: 'text', requests: 1, tokens: 1200,
    messages: pair(languagePrompt, prompt('diagnosticGenerationLanguage')),
    validate: text => assertDiagnostic(waterNames[language.id].test(text), `The sample did not use the expected ${language.name} vocabulary. Check the selected language and Generation language system prompt.`) });
  const variants: [string, string, TaskVariant, 'outline' | 'prose' | 'table' | 'fragment'][] = [
    ['encyclopedic', 'Encyclopedic generation / regeneration', { kind: 'root', topic: 'Triangle perimeter' }, 'outline'],
    ['term-node', 'Node from a term', { kind: 'term-click', term: 'equilateral triangle' }, 'outline'],
    ['follow-up', 'Encyclopedic follow-up', { kind: 'follow-up', question: 'Explore polygon perimeter.' }, 'outline'],
    ['selected-follow-up', 'Follow-up on selected text', { kind: 'follow-up', question: 'What other units are used?', selectedText: 'same unit' }, 'outline'],
    ['explain', 'Explain generation / regeneration', { kind: 'explain', term: 'perimeter' }, 'prose'],
    ['modify', 'Modify an encyclopedic node', { kind: 'modify', previousBody: DIAGNOSTIC_TEXT, instruction: 'Change the example to sides of 5, 6 and 7 cm.' }, 'outline'],
    ['modify-explain', 'Modify an explanation', { kind: 'modify', previousBody: 'Perimeter is distance around a shape.', instruction: 'Add an everyday analogy.', freeText: true }, 'prose'],
    ['elaborate', 'Expand an encyclopedic node', { kind: 'elaborate', previousBody: DIAGNOSTIC_TEXT }, 'outline'],
    ['expand-section', 'Expand one section', { kind: 'expand-part', markedBody: DIAGNOSTIC_TEXT.replace('- Calculation\n  - Addition: Add all three side lengths.\n  - Units: Use the same unit for every side.', '<<<EXPAND>>>- Calculation\n  - Addition: Add all three side lengths.\n  - Units: Use the same unit for every side.<<<END>>>') }, 'fragment'],
    ['expand-explain', 'Expand an explanation', { kind: 'expand-part', mode: 'explain', markedBody: '<<<EXPAND>>>Perimeter is distance around a shape.<<<END>>>' }, 'prose'],
    ['pop-bullet', 'Node from a bullet', { kind: 'pop-rework', title: 'Calculating perimeter', bulletBody: '- Addition: Add all sides.\n- Units: Use consistent units.' }, 'outline'],
    ['structure-repair', 'Repair an outline', { kind: 'restructure', previousBody: DIAGNOSTIC_TEXT.replaceAll('  - ', '- ') }, 'outline'],
    ['selection-edit', 'Modify selected text', { kind: 'modify-selection', markedBody: 'Perimeter is <<<SELECTED>>>distance around a shape<<<END_SELECTED>>>.', selectedText: 'distance around a shape', instruction: 'Give a precise definition.', mode: 'explain' }, 'fragment'],
    ['answer', 'Answer node / Markdown table', { kind: 'answer', instruction: 'Compare perimeter and area in a two-row Markdown table.', informationChunking: false }, 'table'],
    ['answer-chunking', 'Answer with information chunking', { kind: 'answer', instruction: 'Compare perimeter and area in a two-row Markdown table.', informationChunking: true }, 'table'],
    ['fact-rewrite', 'Evidence-guided correction', { kind: 'fact-rewrite', previousBody: 'A 3, 4, 5 cm triangle has perimeter 11 cm.', evidenceReport: 'Incorrect: the sum is 12 cm.', sourceCatalog: '⟪E1⟫: 3+4+5 = 12.', freeText: true }, 'prose'],
  ];
  for (const [id, label, variant, shape] of variants) cases.push({ id, label, role: 'main', kind: 'text', requests: 1,
    messages: buildMessages({ variant, context: variant.kind === 'root' ? { parent: null, grandparent: null } : context, maxLevel1: 2 })
      .map(message => message.role === 'system' && ['root', 'term-click', 'follow-up', 'explain', 'answer'].includes(variant.kind)
        ? { ...message, content: message.content + '\n\n' + languagePrompt } : message),
    validate: text => {
      if (shape === 'outline') validateEncyclopedicOutput(text);
      if (shape === 'prose') prose(text);
      if (shape === 'table') table(text);
      if (id === 'fact-rewrite') assertDiagnostic(text.includes('12') && text.includes('⟪E1⟫'), 'The correction lost the fact or evidence marker.');
      assertDiagnostic(!/<<<(?:EXPAND|END|SELECTED)/.test(text), 'Internal selection markers leaked into the answer.');
    } });
  for (const chunking of [false, true]) cases.push({ id: `chat-${chunking}`, label: `Chat · ${chunking ? 'information chunking' : 'normal'}`, role: 'main', kind: 'text', requests: 1,
    messages: pair(prompt('chatBase') + '\n\n' + chatFormattingPrompt(chunking, settings.normalChatInstructions ?? '', settings.customPrompts) + '\n\n' + languagePrompt,
      'Compare area and perimeter in a compact Markdown table. Then give a Python function that adds three side lengths.'),
    validate: text => { table(text); assertDiagnostic(/```/.test(text), 'The requested code block is missing.'); } });
  const passages = '(SOURCE_1) Triangle perimeter is the sum of its three side lengths. A triangle with sides 3, 4 and 5 cm has perimeter 12 cm.';
  for (const policy of ['sourcePolicyOnly', 'sourcePolicyUse'] as const) cases.push({ id: policy, label: `Project sources · ${policy === 'sourcePolicyOnly' ? 'source-only' : 'supplementary'}`, role: 'main', kind: 'text', requests: 1,
    messages: pair(prompt('chatBase') + '\n' + prompt('sourceEvidence', { policy: prompt(policy), passages }), 'What is the perimeter of the example triangle? One sentence.'),
    validate: text => assertDiagnostic(text.includes('12') && text.includes('SOURCE_1'), 'The answer lost the source fact or citation marker.') });
  cases.push({ id: 'source-repair', label: 'Repair source citations', role: 'main', kind: 'text', requests: 1,
    messages: pair(prompt('sourceCitationRepair'), prompt('sourceCitationRepairTask', { body: 'The triangle has perimeter 12 cm.', evidence: passages })),
    validate: text => assertDiagnostic(text.includes('SOURCE_1'), 'The repaired answer omitted its source citation.') });

  const secondary = (id: string, label: string, system: string, user: string, tokens: number, validate?: (text: string) => void) =>
    cases.push({ id, label, role: 'secondary', kind: 'text', requests: 1, tokens, messages: pair(system, user), validate });
  // The bundled local-provider guide uses these same marking/preview paths.
  // Its static snapshot is separately validated by localModelGuideContent.test;
  // do not add redundant paid checks for an asset generated during maintenance.
  const terms = termSelectionPrompt(DIAGNOSTIC_TEXT, settings.customPrompts);
  secondary('terms', 'Mark / re-mark terms · including copied answers', terms.system, terms.user, 2000, text => {
    const body = applyTermSelection(DIAGNOSTIC_TEXT, text);
    assertDiagnostic(body && markedTerms(body).length > 0, 'Term selection returned invalid JSON or no usable terms. Check the secondary model, then retry Redo terms on the affected answer.');
    assertDiagnostic(body && stripTermMarkers(body) === stripTermMarkers(DIAGNOSTIC_TEXT), 'Term marking changed the source text instead of only marking terms.');
  });
  const previewTerms = ['perimeter', 'equilateral triangle'];
  const preview = previewRequest({ header: 'Triangle perimeter', body: DIAGNOSTIC_TEXT, language: language.id, createdAt: 1, generatedBy: 'root', contentType: 'encyclopedic' }, previewTerms);
  secondary('previews', 'Term previews', preview.system, preview.user, preview.maxOutputTokens, text => {
    const { issues } = inspectTermPreviews(text, previewTerms);
    assertDiagnostic(!Object.keys(issues).length, Object.entries(issues).map(([term, issue]) => `${term}: ${issue.reason}`).join(' '));
  });
  secondary('group-title', 'Group name', prompt('groupName') + '\n\n' + languagePrompt, JSON.stringify({ headers: ['Triangles', 'Circles', 'Polygon perimeter'] }), 256,
    text => assertDiagnostic(typeof parseResponseJson(text).name === 'string', 'The group-name response has no name field.'));
  secondary('chat-title', 'Chat / project title', prompt('chatTitle') + '\n\n' + languagePrompt, 'Question: How to find triangle perimeter? Answer: Add all three sides.', 256,
    text => assertDiagnostic(typeof parseResponseJson(text).chatTitle === 'string', 'The title response has no chatTitle field.'));
  const plainTitle = (text: string) => assertDiagnostic(text.trim().split(/\s+/).length <= 12 && !/[\n{}#*]/.test(text.trim()), 'The title/recommendation is not a short plain-text response.');
  secondary('image-title', 'Image-region title', prompt('imageQuestionTitle') + '\n\n' + languagePrompt, 'Question: What is this? Answer: The selected blue shape is a circle.', 512, plainTitle);
  secondary('recommend', 'Topic recommendations', prompt('recommendSystem') + '\n\n' + languagePrompt, prompt('recommendTask', { topics: 'Triangles\nPerimeter\nGeometry' }), 512, plainTitle);
  secondary('memory', 'Compact chat history', prompt('chatCompaction'), prompt('chatCompactionTask', { memory: '', transcript: 'User: My triangle has sides 3, 4, 5 cm. Assistant: Its perimeter is 12 cm. User: Remember my study code KESTREL-42.' }), 2400,
    text => assertDiagnostic(text.includes('KESTREL-42'), 'Compaction dropped the explicit study code.'));
  secondary('queries', 'Source-query alternatives', prompt('sourceQueryAlternates'), 'How do I calculate triangle perimeter?', 350,
    text => assertDiagnostic(Array.isArray(parseResponseJson(text).queries), 'Source-query alternatives are not an array.'));
  for (const [question, expected] of [['Compare perimeter and area in a table', 'chat'], ['Explain perimeter in simple terms', 'explain'], ['Explore polygons', 'explore']]) {
    secondary(`routing-${expected}`, `Follow-up routing · ${expected}`, buildFollowUpClassifierPrompt({ question: question!, context }), question!, 512,
      text => assertDiagnostic(text.trim().toLowerCase().replace(/[.`]/g, '') === expected, `The router did not select ${expected} for an explicit request.`));
  }
  for (const [id, question] of [
    ['selected-term', 'The user selected this exact passage: homeostasis. Their question is: What is this?'],
    ['image-region', 'The user selected a region of the parent image. Their question is: What is this?'],
  ]) {
    secondary(`routing-${id}`, `Follow-up routing · identify ${id === 'selected-term' ? 'a term' : 'an image region'}`,
      buildFollowUpClassifierPrompt({ question: question!, context }), question!, 512,
      text => assertDiagnostic(text.trim().toLowerCase().replace(/[.`]/g, '') === 'explore',
        'An identification question was not routed to an encyclopedic node. Retry the check; if it repeats, reset the follow-up classifier prompt or choose a stronger secondary model.'));
  }
  // Automatic discovery and the side-panel redo use the same AI plan/review;
  // direct catalog searches do not need a paid model-capability check.
  secondary('image-plan', 'Free-image search / redo · exact subject', prompt('imageDiscovery'), 'NODE HEADER: Influence of House of Leaves on culture\nNODE BODY: The novel House of Leaves by Mark Z. Danielewski influenced experimental fiction through its unusual typography and nested narratives.\nRESULT LIMIT: 24', 900,
    text => { const v = parseResponseJson(text); assertDiagnostic(v.action === 'search' && v.wikimediaQuery && v.openverseQuery && v.wikipediaQuery, 'The image-search plan omitted its action or search queries.');
      assertDiagnostic([v.wikimediaQuery, v.openverseQuery].every(query => /house of leaves/i.test(String(query))), 'The image search lost the named subject and broadened to loosely related imagery. Retry or reset the image-discovery prompt.'); });
  cases.push({ id: 'image-review', label: 'Free-image visual review', role: 'secondary', kind: 'vision', requests: 1, tokens: 900,
    messages: pair(prompt('imageDiscovery'), 'NODE: Triangle perimeter. RESULT LIMIT: 1. Candidate metadata: [{"candidateId":"fixture","title":"Triangle and circle"}].\n' + prompt('imageDiscoveryReview') + '\n' + prompt('imageDiscoveryFinish')),
    validate: text => { const v = parseResponseJson(text); assertDiagnostic(v.action === 'finish' && Array.isArray(v.selections), 'The image review has an invalid selection response.'); } });
  cases.push({ id: 'image-reject-unrelated', label: 'Free-image review · reject symbolic matches', role: 'secondary', kind: 'vision', requests: 1, tokens: 900,
    messages: pair(prompt('imageDiscovery'), 'NODE: Influence of House of Leaves, the novel by Mark Z. Danielewski, on culture. RESULT LIMIT: 24. Candidate metadata: [{"candidateId":"fixture","title":"Unrelated triangle and circle diagram"}].\n' + prompt('imageDiscoveryReview') + '\n' + prompt('imageDiscoveryFinish')),
    validate: text => { const v = parseResponseJson(text); assertDiagnostic(v.action === 'finish' && Array.isArray(v.selections) && v.selections.length === 0,
      'The reviewer accepted an unrelated image based on a symbolic connection. Retry; if repeated, use a stronger secondary vision model or reset the image-discovery prompts.'); } });
  for (const role of ['main', 'secondary'] as const) {
    cases.push({ id: 'vision', label: role === 'main' ? 'Image input / visual question' : 'Source-image transcription', role, kind: 'vision', requests: 1, tokens: 2000,
      messages: pair(role === 'secondary' ? prompt('sourceTranscription') : 'Read the supplied image carefully. Answer concisely.',
        role === 'secondary' ? prompt('sourceTranscriptionTask', { label: 'test fixture' }) : 'Name the two colored shapes and read the test code.'),
      validate: text => { assertDiagnostic(/ORBIT\s*27/i.test(text), 'The model did not read the code in the supplied image.'); if (role === 'main') assertDiagnostic(/circle/i.test(text) && /triangle/i.test(text), 'The model did not identify both shapes.'); } });
    cases.push({ id: 'search', label: 'Web search and source links', role, kind: 'search', requests: 2, tokens: 4000,
      messages: pair(prompt('nodeWebSearch'), 'Search once for the official NASA page explaining lunar eclipses. State one fact and cite the exact source URL.') });
  }
  for (const role of ['main', 'interactive'] as const) cases.push({ id: 'tools', label: 'Tool call and result round-trip', role, kind: 'tools', requests: 2,
    messages: pair(prompt('chatBase'), 'Retrieve my study code using search_conversation. Do not guess; it is not included in this message. Return the retrieved code.') });
  cases.push({ id: 'vision', label: 'Screenshot vision / visual readout', role: 'interactive', kind: 'vision', requests: 1, tokens: 2000,
    messages: pair('Inspect the supplied screenshot carefully. Report the actual visible content, not a guess.', 'Name the two colored shapes and read the test code.'),
    validate: text => assertDiagnostic(/ORBIT\s*27/i.test(text) && /circle/i.test(text) && /triangle/i.test(text),
      'The interactive model did not correctly read the image. Screenshot review requires vision; choose a vision-capable model or check image support on your server.') });
  for (const modify of [false, true]) cases.push({ id: modify ? 'interactive-edit' : 'interactive-create', label: modify ? 'Modify, test and visually review a program' : 'Plan, build, test and visually review a calculator', role: 'interactive', kind: 'interactive', requests: 6, modify,
    messages: pair(prompt('interactiveNodeBase'), prompt('interactiveNodeTask', {
      request: modify ? 'Change the existing counter #add button to add 2 instead of 1, clamp to a maximum of 10, and add #reset to return to 0. Keep the #count readout as a bare integer and preserve the visual identity. Let the height follow its content, remove unused outer space, and keep the program title only in <title>, since the node header displays it. Test initial, normal, boundary and reset outcomes.'
        : 'Build a compact Ohm’s-law calculator with native numeric inputs #voltage (default 12 volts) and #resistance (default 6 ohms), a #current readout containing only the numeric current (2 initially; put units beside it), a #reset button, and a small SVG circuit/current visualization. Recalculate immediately on input. 9 V / 3 ohms must show 3 A. Zero or negative resistance must show a clear error instead of infinity or a misleading current. Reset restores 12 V / 6 ohms. Use a compact single-column layout with 720 × 960 as starting bounds in scatter-viewport metadata; let the height follow its content rather than filling those bounds. Put the program title only in <title>; the body starts with controls and the visualization. Include an accent-filled control with --sc-on-primary text and an accent label with --sc-primary-text to exercise light/dark ink tokens. Keep it small and readable; verification measures and fits the surface.',
      context: '', color: '#60a5fa', mode: modify ? 'modify' : 'create',
    })) });
  cases.push({ id: 'interactive-repair', label: 'Continue a saved draft · one repair pass', role: 'interactive', kind: 'interactive', requests: 5, repair: true,
    messages: pair(prompt('interactiveNodeBase'), prompt('interactiveNodeTask', {
      request: 'Repair the supplied counter: #add should increase #count by one up to a maximum of 3; #reset must restore zero. Keep the existing layout and IDs. The state variable already changes, but the visible count stays at 0. Make a targeted fix, not a redesign. Test initial, normal, boundary and reset behavior.',
      context: '', color: '#60a5fa', mode: 'modify',
    }) + '\n\n' + prompt('interactiveNodeRepair', { error: '#count text: expected equals "1" after clicking #add, observed "0".' })) });
  cases.push({ id: 'image-generate', label: 'Generate an image', role: 'image', kind: 'image-generate', requests: 1, messages: [] },
    { id: 'image-edit', label: 'Edit an existing image', role: 'image', kind: 'image-edit', requests: 1, messages: [] });
  cases.push({ id: 'fact-check-search', label: 'Fact-check with live search evidence', role: 'main', kind: 'fact-check', requests: 1, tokens: 2400,
    messages: factCheckMessages({ header: 'Moon', body: 'The Moon orbits Earth.', createdAt: 1, generatedBy: 'manual', language: settings.generationLanguage },
      { id: 'sample', text: 'The Moon orbits Earth.', kind: 'sentence', stage: 'opening', order: 0, state: 'pending' }, settings.customPrompts) });
  cases.push({ id: 'fact-check-format', label: 'Fact-check evidence format', role: 'main', kind: 'text', requests: 1, tokens: 2400,
    messages: pair(prompt('factCheckContract', { unitId: 'sample' }),
      prompt('taskFactCheckUnit', { nodeHeader: 'Triangle perimeter', nodeBody: 'A 3, 4, 5 cm triangle has perimeter 12 cm.', sectionTitle: 'Opening prose', unitId: 'sample', unitText: 'A 3, 4, 5 cm triangle has perimeter 12 cm.' }) +
      '\nThis is a format-only test: no search evidence is available. Do not claim verification or invent sources. Return unverified with insufficient_evidence.'),
    validate: text => { const finding = parseFactCheckFinding(text, 'sample', []); assertDiagnostic(finding.verdict === 'unverified', 'The fact-checker claimed verification without evidence.'); } });
  return cases.map(test => test.kind === 'interactive' ? { ...test,
    messages: test.messages.map(message => message.role === 'system' ? { ...message, content: message.content + '\n\n' + languagePrompt } : message) } : test);
}
