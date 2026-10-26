'use client';

/** Isolated, non-persistent browser QA fixture. No real provider requests and
 * no project/settings writes. Production builds render no fixture. */
import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { Canvas } from '@/components/canvas/Canvas';
import ChatTableViewer from '@/components/chat/ChatTableViewer';
import { useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useModelCatalogStore } from '@/store/useModelCatalogStore';
import { useChatRuntimeStore } from '@/store/useChatRuntimeStore';
import { useChatTableStore } from '@/store/useChatTableStore';
import { useCitationPanelStore } from '@/store/useCitationPanelStore';
import { createChatNode, chatInitialBodyHeight, appendChatAnswer, updateChatAnswer, conversationPath } from '@/lib/chat/model';
import { activateChatAnswer } from '@/lib/chat/actions';
import { applyThemePreference } from '@/lib/theme';
import { createSandboxProject } from '@/lib/sandboxProject';
import { exitReading, handleReadingArrow, isReadingArrow, activateReadingReference } from '@/lib/readingController';
import type { Project } from '@/store/types';
import { extractFactCheckUnits, factCheckBodyFingerprint } from '@/lib/factCheckCore';
import TextEditorOverlay from '@/components/editor/TextEditorOverlay';
import { useEditorStore } from '@/store/useEditorStore';
import { useImageEditorStore } from '@/store/useImageEditorStore';
import type { ScatterNode } from '@/store/types';
import { prepareChatAttachments } from '@/lib/chat/attachments';
import { getChatDraft } from '@/store/useChatRuntimeStore';
import { watchFocusedTermPreviews } from '@/lib/termPreviews';
import { TERM_PREVIEW_SYSTEM } from '@/lib/termPreviewPrompt';

// Match the app boundary: Konva is a browser-only editor, including in QA.
const ImageEditorOverlay = dynamic(() => import('@/components/imageEditor/ImageEditorOverlay'), { ssr: false });

const URL = 'https://chat-fixture.invalid/v1/chat/completions';
const poem = ['In the Caverns of the Deep,', 'Where the ancient Titans sleep,', 'Spoke the Healer of the Soul', 'To the Furnace of the Whole.', '', '*Jung:*', '“Mighty Sovereign, fierce and blind,', 'Dwelling boundless in the Mind,', 'Thou hast blown the starry Gale,', 'Crushed poor Job beneath Thy hail!', 'Dost Thou roar from Whirlwinds high', 'Just to mock a mortal’s sigh?', 'Art Thou Good, or art Thou Dread,', 'Walking on the quick and dead?”'].map((line, i, lines) => line && lines[i + 1] ? line + '\\' : line).join('\n');
const answer = `**[[Working memory]]** holds information briefly. It helps us use the information in the current task.\n\n## A comparison\n\n| System | Purpose | A practical example | What changes with practice | Important limitation |\n| --- | --- | --- | --- | --- |\n| Working memory | Hold active information. | Remember a number while calculating. | Familiar groups become easier to handle. | Capacity remains limited. |\n| Long-term memory | Preserve learned information. | Remember familiar words and concepts. | Retrieval becomes more fluent. | Recall can be incomplete. |\n\n- **Chunking** groups related information. It does not create unlimited capacity.\n- A useful comparison focuses on the same properties.\n\nA final sentence after the table. ⟦1⟧`;

function fixtureProject(): Project {
  const base = createSandboxProject();
  let chat = createChatNode({ id: 'chat-fixture', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 650 });
  for (let i = 0; i < 4; i++) {
    chat = appendChatAnswer(chat, { turnId: `turn-${i}`, createdAt: i + 2,
      question: ['How does working memory differ from long-term memory?', 'Could you explain this normally, without chunking?', 'What practical example can I try?', 'Summarize the important limits.'][i]!,
      metadata: { informationChunking: i !== 1 } });
    chat = updateChatAnswer(chat, { turnId: `turn-${i}`, versionCreatedAt: i + 2 },
      { body: i === 0 ? answer : `This is a ${i === 1 ? 'normal Markdown' : '**chunked**'} answer. It discusses **[[Working memory]]** without changing the earlier answers.\n\n${'A longer paragraph helps test natural scrolling within a turn. It should remain comfortable to read.\n\n'.repeat(i === 2 ? 9 : 2)}`,
        sources: i === 0 ? [{ n: 1, url: 'https://en.wikipedia.org/wiki/Working_memory', title: 'Working memory', domain: 'en.wikipedia.org' }] : undefined },
      { state: 'complete', title: ['Memory systems', 'A normal answer', 'Practical example', 'Limits'][i]!, outlineParentTurnId: i === 2 ? 'turn-1' : undefined });
  }
  chat = appendChatAnswer(chat, { turnId: 'turn-3', createdAt: 6, question: 'Summarize the limits in other words.', replaceLatest: true });
  chat = updateChatAnswer(chat, { turnId: 'turn-3', versionCreatedAt: 6 }, { body: 'An alternative conclusion keeps the earlier paired question available.' }, { state: 'complete', title: 'An alternative conclusion' });
  chat = { ...chat, frozen: true, generating: false, streamingText: false, generatingVersionIndex: undefined,
    currentVersionIndex: 1, chat: { ...chat.chat!, title: 'Memory and learning' } };
  const first = chat.versions[1]!;
  first.body = first.body.replace('Hold active information.', 'Hold active information. ⟦1⟧');
  first.factCheck = { complete: { schemaVersion: 1, bodyFingerprint: factCheckBodyFingerprint(first),
    versionCreatedAt: first.createdAt, providerId: 'fixture', model: 'fixture', startedAt: 1, completedAt: 2,
    complete: true, failedUnitIds: [], units: extractFactCheckUnits(first).map((unit) => ({ ...unit, state: 'complete',
      finding: { verdict: 'unverified', unverifiedReason: 'insufficient_evidence',
        explanation: 'Simulated evidence review for browser testing; no factual verdict is asserted.', evidence: [] } })) } };
  const text: ScatterNode = { id: 'text-fixture', type: 'term-click', frozen: true,
    position: { x: -1600, y: 0 }, currentVersionIndex: 11,
    versions: Array.from({ length: 24 }, (_, i) => ({ header: 'A text editor with many versions',
      body: 'A short opening paragraph.\n\n- First section\n  - Detail: A complete explanation.\n- Second section\n  - Detail: Another complete explanation.',
      createdAt: 100 + i, generatedBy: 'term-click', width: 540, bodyMaxHeight: 260 })) };
  const image: ScatterNode = { id: 'image-fixture', type: 'media', frozen: true,
    position: { x: -2400, y: 0 }, currentVersionIndex: 11,
    versions: Array.from({ length: 24 }, (_, i) => ({ header: 'Image editor crop fixture', body: '', createdAt: 200 + i,
      generatedBy: 'media', contentType: 'media', media: { kind: 'image', source: 'link',
        url: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640"><rect width="960" height="640" fill="#82b17e"/><circle cx="480" cy="320" r="200" fill="#eee"/><path d="M0 0L960 640M960 0L0 640" stroke="#444" stroke-width="4"/></svg>')}` } })) };
  return { ...base, id: 'chat-fixture-project', name: 'Chat QA fixture', rootNodeId: chat.id,
    nodes: { [chat.id]: chat, [text.id]: text, [image.id]: image }, groups: {}, arrows: {}, selection: [chat.id], color: '#82b17e',
    viewport: { x: 265, y: 55, zoom: 0.75 } };
}

export default function ChatSandboxPage() {
  const [ready, setReady] = useState(false);
  const [dark, setDark] = useState(true);
  const [requests, setRequests] = useState(0);
  const [imageStatus, setImageStatus] = useState('');
  const table = useChatTableStore((s) => s.target);
  const textEditor = useEditorStore((s) => s.open);
  const imageEditor = useImageEditorStore((s) => s.open);
  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return;
    const settings = useSettingsStore.getState();
    const graph = useGraphStore.getState();
    const fetchOriginal = window.fetch;
    const previousTheme = document.documentElement.dataset.themePreference;
    useSettingsStore.setState({ hydrated: true, providers: [{ id: 'chat-fixture-provider', preset: 'custom', apiKey: 'fixture-not-a-secret', baseUrl: 'https://chat-fixture.invalid/v1', enabledModels: ['chat-fixture-model'] }],
      activeModelRef: { providerId: 'chat-fixture-provider', model: 'chat-fixture-model' }, secondaryUseSameModel: true,
      webSearch: false, outputTokenCap: 1800, followUpEnterSends: true, customPrompts: {} });
    useModelCatalogStore.getState().setCatalog('chat-fixture-provider', [{ id: 'chat-fixture-model', name: 'Fixture vision + tools', contextLength: 32000, caps: { vision: true, tools: true, textOutput: true } }]);
    window.fetch = async (input, init) => {
      if (String(input) !== URL) return fetchOriginal(input, init);
      setRequests((n) => n + 1);
      const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }[] };
      const visionParts = body.messages.flatMap((message) => typeof message.content === 'string' ? [] : message.content)
        .filter((part) => part.type === 'image_url');
      if (visionParts.length) setImageStatus(visionParts.every((part) => part.image_url?.url.startsWith('data:image/png;base64,'))
        ? `Vision input verified: ${visionParts.length} PNG` : 'ERROR: image input type was lost');
      const system = String(body.messages.find((m) => m.role === 'system')?.content ?? '');
      const latest = body.messages.at(-1)?.content ?? '';
      const text = system === TERM_PREVIEW_SYSTEM ? JSON.stringify({ previews: JSON.parse(String(latest)).terms.map(({ id }: { id: number }) => ({ id,
        parts: ['Working memory is a ', 'temporary mental store', ' that keeps ', 'information available', ' for the task at hand.'] })) })
        : system.includes('REQUIRED RESPONSE FORMAT') ? '{"terms":["Titans"]}'
        : system.includes('short topical title') ? JSON.stringify({ chatTitle: 'Memory and learning' })
          : system.includes('working memory for a learning chat') ? 'The user discussed memory systems and their limitations.'
            : `A fresh answer to your question. **[[Working memory]]** has limits.\n\n${answer}`;
      const encoder = new TextEncoder();
      let timer: ReturnType<typeof setTimeout>;
      const stream = new ReadableStream({ start(controller) {
        let at = 0;
        const tick = () => {
          if (init?.signal?.aborted) { controller.error(new DOMException('Stopped', 'AbortError')); return; }
          if (at >= text.length) { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); return; }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(at, at + 35) } }] })}\n\n`));
          at += 35; timer = setTimeout(tick, system.includes('Scatter’s') ? 80 : 55);
        }; timer = setTimeout(tick, 500);
      }, cancel() { clearTimeout(timer); } });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    };
    const project = fixtureProject();
    useGraphStore.setState({ project, activeProjectId: project.id });
    useGraphStore.temporal.getState().clear();
    useChatRuntimeStore.setState({ views: {}, drafts: {} });
    activateChatAnswer('chat-fixture', conversationPath(project.nodes['chat-fixture']!)[0]!);
    useChatRuntimeStore.getState().view('chat-fixture', { atBottom: false, scrollTop: 0 });
    const stopPreviews = watchFocusedTermPreviews();
    setReady(true);
    return () => { stopPreviews(); window.fetch = fetchOriginal; useEditorStore.getState().close(); useImageEditorStore.getState().close();
      useGraphStore.setState({ project: graph.project, activeProjectId: graph.activeProjectId });
      useSettingsStore.setState(settings); useCitationPanelStore.getState().close(); useChatTableStore.getState().close(); exitReading();
      applyThemePreference(previousTheme === 'light' ? 'light' : previousTheme === 'dark' ? 'dark' : 'system'); };
  }, []);
  useEffect(() => { if (process.env.NODE_ENV !== 'production') applyThemePreference(dark ? 'dark' : 'light'); }, [dark]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented || (event.target as HTMLElement).closest('input,textarea,[contenteditable="true"]')) return;
      const selected = useGraphStore.getState().project?.selection[0];
      if (isReadingArrow(event.key) && selected) { event.preventDefault(); handleReadingArrow(event.key, selected); }
      else if (event.key === 'Enter' && activateReadingReference(event.ctrlKey || event.metaKey)) event.preventDefault();
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  if (process.env.NODE_ENV === 'production' || !ready) return null;
  return <main style={{ position: 'fixed', inset: 0 }}>
    {!table && !textEditor && !imageEditor && <div style={{ position: 'fixed', top: 8, left: 8, zIndex: 30, display: 'flex', gap: 12, fontSize: 12 }}>
      <button type="button" onClick={() => setDark(!dark)}>{dark ? 'Use light theme' : 'Use dark theme'}</button>
      <span>Chat QA fixture · simulated requests: {requests} · isolated test data {imageStatus}</span>
      {[0.1, 0.25].map((zoom) => <button key={zoom} type="button" onClick={() => {
        const graph = useGraphStore.getState();
        graph.setSelection([]);
        graph.setViewport({ x: 80 + 2400 * zoom, y: 160, zoom });
      }}>Test {zoom * 100}% overview</button>)}
      <button type="button" onClick={() => {
        exitReading(); const graph = useGraphStore.getState(); const node = graph.project!.nodes['chat-fixture']!;
        graph.updateNode(node.id, updateChatAnswer(node, { turnId: 'turn-0', versionCreatedAt: 2 }, { body: poem, factCheck: undefined }, { informationChunking: false }));
        activateChatAnswer(node.id, { turnId: 'turn-0', versionCreatedAt: 2 }); useChatRuntimeStore.getState().jumpTo(node.id, 'turn-0');
      }}>Test poem breaks</button>
      <button type="button" onClick={() => { void (async () => {
        const projectId = 'chat-fixture-project'; const nodeId = 'chat-fixture';
        const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='), (c) => c.charCodeAt(0));
        const documents = Array.from({ length: 4 }, (_, i) => new File([`Document fixture ${i + 1}: working memory has limits.`], `A long descriptive document filename ${i + 1} for the attachment strip.txt`, { type: 'text/plain' }));
        const attachments = await prepareChatAttachments(projectId, [...documents, new File([bytes], 'Small image.png', { type: 'image/png' })], new AbortController().signal);
        useChatRuntimeStore.getState().setDraft(projectId, nodeId, { ...getChatDraft(projectId, nodeId), text: 'Explain these attachments', attachments });
      })(); }}>Stage attachment fixtures</button>
      <button type="button" onClick={() => {
        exitReading();
        const graph = useGraphStore.getState(); const node = graph.project!.nodes['chat-fixture']!;
        const next = updateChatAnswer(node, { turnId: 'turn-0', versionCreatedAt: 2 }, {
          body: 'For Carl Jung, God is not primarily defined as a metaphysical being residing in heaven, nor as an illusion or wish-fulfillment (as Sigmund Freud argued). Instead, Jung approached God as an **[[empirical, psychological reality]]** deeply woven into the human psyche⟦1⟧⟦2⟧⟦3⟧⟦4⟧⟦5⟧.\n\nJung made a strict distinction between **[[metaphysical claims]]** about the objective existence of God (which he maintained science cannot prove or disprove) and the **[[God-image (*imago Dei*)]]**, which is an observable, potent force within the unconscious.\n\nSeveral core principles explain how Jung understood God:',
          factCheck: undefined,
        }, { informationChunking: false });
        graph.updateNode(node.id, next); activateChatAnswer(node.id, { turnId: 'turn-0', versionCreatedAt: 2 });
        useChatRuntimeStore.getState().jumpTo(node.id, 'turn-0');
      }}>Test formatted term</button>
      <button type="button" onClick={() => useEditorStore.getState().openEditor('text-fixture')}>Test text editor</button>
      <button type="button" onClick={() => {
        exitReading(); setImageStatus(''); const graph = useGraphStore.getState();
        const base = fixtureProject();
        const template = base.nodes['text-fixture']!;
        const node = (id: string, x: number, frozen: boolean): ScatterNode => ({
          ...template, id, frozen, type: id === 'reference-left' ? 'root' : 'term-click',
          position: { x, y: id === 'reference-left' ? 0 : 260 }, currentVersionIndex: 0,
          versions: [{ ...template.versions[0]!, header: id === 'reference-left' ? 'Referenced topic' : 'Drag this reference away',
            body: 'This dotted relationship is a visual reference, not a structural parent.\n\n- **Reference**\n  - Behavior: No attraction or drag-away pinning.', width: 330, bodyMaxHeight: 150,
            imageRecommendations: { schemaVersion: 2, bodyFingerprint: 'fixture', providerId: 'fixture', model: 'fixture', searchedAt: 1, resultLimit: 5, sourceOutcomes: [], results: [] } }],
        });
        const left = node('reference-left', 0, true), right = node('reference-right', 800, false);
        graph.setProject({ ...base, id: `dotted-reference-fixture-${Date.now()}`, rootNodeId: left.id,
          nodes: { [left.id]: left, [right.id]: right }, selection: [right.id],
          arrows: { reference: { id: 'reference', fromNodeId: left.id, toNodeId: right.id, kind: 'dotted', gravitates: true } },
          viewport: { x: 40, y: 120, zoom: .8 } });
      }}>Test dotted reference</button>
      <button type="button" onClick={() => {
        exitReading(); const graph = useGraphStore.getState();
        const source = graph.project!.nodes['chat-fixture']!.versions[1]!;
        const body = Array.from({ length: 18 }, (_, i) => `## Section ${i + 1}: a long answer\n\n${answer}\n\n${i % 3 === 0 ? poem + '\n\n' : ''}End of section ${i + 1}.`).join('\n\n');
        const node: ScatterNode = { id: 'overflow-fixture', type: 'follow-up', frozen: true,
          position: { x: 0, y: 850 }, currentVersionIndex: 0,
          versions: [{ ...source, contentType: 'answer', body, header: 'A long answer with fading edges',
            factCheck: undefined, imageRecommendations: undefined, wikimediaImages: undefined,
            chat: { ...source.chat!, turnId: 'overflow', informationChunking: false }, width: 611, bodyMaxHeight: 400 }] };
        graph.addNode(node); graph.setSelection([node.id]); graph.requestPanTo(node.id);
      }}>Test answer overflow</button>
      <button type="button" onClick={() => useImageEditorStore.getState().openImageEditor('image-fixture')}>Test image editor</button>
      <button type="button" onClick={() => {
        exitReading();
        const graph = useGraphStore.getState(); const node = graph.project!.nodes['chat-fixture']!;
        const next = updateChatAnswer(node, { turnId: 'turn-0', versionCreatedAt: 2 }, {
          body: '| First cell | Second cell |\n|---|---|\n| **A deliberately long bold phrase wraps across several visual lines in this cell so the ruler must finish these lines before moving across.** | This adjacent cell also contains several sentences. Only its own current line should be highlighted. Another sentence makes the wrapping visible. |\n| The next row begins here. | The final cell ends here. |',
          factCheck: undefined,
        });
        graph.updateNode(node.id, next); activateChatAnswer(node.id, { turnId: 'turn-0', versionCreatedAt: 2 });
        useChatRuntimeStore.getState().jumpTo(node.id, 'turn-0');
      }}>Test wrapped table</button>
      <button type="button" onClick={() => { const graph = useGraphStore.getState(); const node = createChatNode({ id: 'empty-chat', createdAt: 900,
        position: { x: 800, y: 0 }, bodyHeight: chatInitialBodyHeight(window.innerHeight), parentNodeId: 'text-fixture' });
        graph.addNode(node); graph.setSelection([node.id]); graph.requestPanTo(node.id); }}>Test empty chat</button>
      <button type="button" onClick={() => { const graph = useGraphStore.getState(); const node = graph.project!.nodes['chat-fixture']!;
        graph.updateNode(node.id, { versions: node.versions.map((version) => ({ ...version, width: 764, bodyMaxHeight: 1200 })) });
        graph.setSelection([node.id]); graph.requestPanTo(node.id); }}>Test tall chat fit</button>
      <button type="button" onClick={() => { const graph = useGraphStore.getState(); const node = graph.project!.nodes['text-fixture']!;
        graph.updateNode(node.id, { generationError: 'This model is rate limited. Please try again shortly.',
          versions: node.versions.map((version) => ({ ...version, bodyMaxHeight: 60 })) });
        graph.setSelection(['text-fixture']); graph.requestPanTo('text-fixture'); }}>Test rate-limit notice</button>
    </div>}
    <Canvas sidebarCollapsed={false} onOpenSettings={() => {}} onReferenceClick={() => {}}
      onAskFollowUp={() => {}} onModify={() => {}} />
    <ChatTableViewer />
    <TextEditorOverlay />
    <ImageEditorOverlay />
  </main>;
}
