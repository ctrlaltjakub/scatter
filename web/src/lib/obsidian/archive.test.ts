// @vitest-environment node
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { posix } from 'node:path';
import type { NodeVersion, Project, ScatterNode } from '@/store/types';
import { buildObsidianArchive } from './archive';
import { termPreviewFingerprint } from '../termPreviewCore';

const ver = (header: string, body: string, extra: Partial<NodeVersion> = {}): NodeVersion =>
  ({ createdAt: 1, generatedBy: 'manual', header, body, ...extra });
const card = (id: string, v: NodeVersion): ScatterNode => ({
  id, type: 'manual-empty', position: { x: -315.4, y: 76.6 }, versions: [v], frozen: true,
  currentVersionIndex: 0, renderedHeight: 352,
});
const project = (...nodes: ScatterNode[]): Project => ({
  id: 'fixture', name: '知識', createdAt: 0, updatedAt: 0, rootNodeId: nodes[0]!.id,
  nodes: Object.fromEntries(nodes.map(n => [n.id, n])), groups: { g: { id:'g', name:'Second', color:'#abcd00', gravitate:false } },
  arrows: {}, viewport:{ x:0, y:0, zoom:1 }, selection:[], color:'#abc',
});
async function unpack(p: Project, asset: (id:string) => Promise<Blob|null> = async () => null) {
  const result = await buildObsidianArchive(p, asset);
  const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
  const path = Object.keys(zip.files).find(n => n.endsWith('.canvas'))!;
  const canvas = JSON.parse(await zip.file(path)!.async('string'));
  const note = (id: string) => {
    const card = canvas.nodes.find((n: { id: string }) => n.id === id);
    expect(card.type).toBe('text');
    const relative = decodeURIComponent(/^!\[\]\(<(\.\/Notes\/.+\.md)>\)$/.exec(card.text)![1]!);
    return zip.file(posix.join(posix.dirname(path), relative))!.async('string');
  };
  return { result, zip, canvas, note, path };
}
describe('Obsidian vault export', () => {
  it('resolves every note from its canvas, including after extraction into a wrapper or opening the project as a vault', async () => {
    const p = project(card('a', ver('Étude (日本語)', 'First note')), card('b', ver('Étude (日本語)', 'Second note')));
    const { zip, canvas, path } = await unpack(p);
    const folder = posix.dirname(path) + '/';
    for (const parent of ['', 'Project.obsidian/', 'Courses/Week 1/Renamed/']) {
      const extracted = new Set(Object.keys(zip.files).map(name => parent + name.slice(folder.length)));
      const canvasPath = parent + posix.basename(path);
      for (const card of canvas.nodes) {
        expect(card.type).toBe('text');
        expect(card).not.toHaveProperty('file');
        const ref = /^!\[\]\(<(\.\/Notes\/.+\.md)>\)$/.exec(card.text)![1]!;
        expect(extracted.has(posix.join(posix.dirname(canvasPath), decodeURIComponent(ref)))).toBe(true);
      }
    }
  });
  it('preserves arrangement, exact colors, directions, fold states and real term targets across languages', async () => {
    const v = ver('عنوان', '日本語 [[日本語]] और [[वर्ण]] and [[plain]].\n\n- 第一章\n  - Échelle: Mesure.\n  - رقم: تفسير.', { width:560, sources:[{ n:4, url:'https://example.org/a' }] });
    v.termPreviews = { fingerprint:termPreviewFingerprint(v), entries:{ 'वर्ण':'A written character.' } };
    const a = card('a',v), b = card('b',ver('日本語','A note.'));
    b.position.x = 955; b.groupId = 'g';
    const p = project(a,b); p.arrows.ab = { id:'ab',fromNodeId:'a',toNodeId:'b',kind:'auto',label:'日本語' };
    const { canvas, note, zip } = await unpack(p);
    expect(canvas.nodes[0]).toMatchObject({ id:'a',x:-315,y:77,width:560,height:352,color:'#aabbcc' });
    expect(canvas.nodes[1].color).toBe('#abcd00');
    expect(canvas.edges[0]).toMatchObject({ fromNode:'a', toNode:'b', fromSide:'right',toEnd:'arrow',color:'#aabbcc' });
    const md = await note('a');
    expect(md).toContain('[日本語](<./' + encodeURIComponent('日本語') + '.md>)');
    expect(md).toMatch(/\[वर्ण\]\(<\.\.\/Previews\/.+\.md#\^term-1>\)/);
    expect(md).toContain('and plain.'); expect(md).toContain('> [!abstract]- 第一章');
    expect(md).toContain('> [!cite]- Sources'); expect(md).toContain('⟦4⟧');
    expect(Object.keys(zip.files).some(n => n.includes('/Previews/') && n.endsWith('.md'))).toBe(true);
  });
  it('exports only selected answers; last question open, all sources at the bottom, code not rewritten', async () => {
    const a = card('chat',ver('unused',''));
    const answer = (id: string, at:number, body:string) => ver('Answer', body, {
      createdAt:at, chat:{ turnId:id, question:'Question ' + id, state:'complete', contextPath:[], title:'', informationChunking:false },
    });
    a.versions = [answer('one',1,'First'),answer('one',2,'Hidden alternative'),answer('two',3,'Second with ' + String.fromCharCode(96) + '[[literal]]' + String.fromCharCode(96))];
    a.versions[0]!.sources = [{n:1,url:'https://example.org'}];
    a.chat = {title:'Conversation', informationChunking:true, parentSnapshots:{},compactions:[],
      turns:[{id:'one',versionCreatedAts:[1,2],selectedVersionCreatedAt:1},{id:'two',versionCreatedAts:[3],selectedVersionCreatedAt:3}] };
    const {note} = await unpack(project(a)); const md = await note('chat');
    expect(md).toContain('- > [!question]- Question one'); expect(md).toContain('- > [!question]+ Question two');
    expect(md).toContain('> - **Answer**'); expect(md).toContain('[[literal]]'); expect(md).not.toContain('Hidden alternative');
    expect(md.indexOf('[!cite]-')).toBeGreaterThan(md.indexOf('[!question]+'));
  });
  it('packs real bytes once, links hosted media, and never writes an unsafe path', async () => {
    const m = {source:'asset',kind:'image',assetId:'ok', mime:'image/gif',fileName:'../../CON.gif'} as const;
    const a = card('a', ver('../CON','',{ media:m })), b = card('b',ver('../CON','',{media:m}));
    const c = card('c',ver('源','',{media:{source:'asset',kind:'image',assetId:'missing',url:'https://example.org/photo.png'}}));
    const d = card('d',ver('Video','',{media:{source:'embed',kind:'embed',provider:'youtube',embedId:'video-one'}}));
    const { result, canvas, zip, note } = await unpack(project(a,b,c,d), async id => id === 'ok' ? new Blob(['GIF89a']) : null);
    expect(result.missingMedia).toBe(1);
    expect(new Set(canvas.nodes.map((n:{ text:string }) => n.text)).size).toBe(4);
    const gifs = Object.keys(zip.files).filter(k => k.endsWith('.gif')); expect(gifs).toHaveLength(1);
    expect(await zip.file(gifs[0]!)!.async('string')).toBe('GIF89a');
    expect(Object.keys(zip.files).some(k => k.split('/').includes('..'))).toBe(false);
    expect(await note('c')).toContain('https://example.org/photo.png');
    expect(await note('d')).toContain('![](<https://www.youtube.com/watch?v=video-one>)');
  });
  it('keeps source originals or extracted text, without exporting private indexes', async () => {
    const p = project(card('a', ver('Study','Intro')));
    const revision = {id:'r',createdAt:0,status:'ready' as const,contentAssetId:'text',keywordIndexAssetId:'private-index',
      index:{formatVersion:1,embeddingModel:'model',embeddingRevision:'r',dimensions:1}};
    const base = { id:'local',title:'Local reading',kind:'pdf' as const,createdAt:0,checked:true,contentHash:'h',activeRevisionId:'r' };
    p.sourceLibrary = { mode:'use',order:['local','text'],sources:{
      local:{...base,revisions:{r:{ ...revision,originalAssetId:'pdf' }}},
      text:{...base,id:'text',title:'Research',kind:'text',revisions:{r:revision}},
    }};
    const doc = JSON.stringify({schemaVersion:1,revisionId:'r',title:'Research',blocks:[{id:'b',text:'Extracted passage.'}],chunks:[]});
    const output = await buildObsidianArchive(p, async()=>null, {readSource:async id=>{
      if (id === 'pdf') return new Blob(['PDF bytes']);
      if (id === 'text') return new Blob([doc]);
      throw Error('Tried to read an index: ' + id);
    }});
    const zip = await JSZip.loadAsync(await output.blob.arrayBuffer());
    const content = (suffix: string) => zip.file(Object.keys(zip.files).find(f=>f.endsWith('/' + suffix))!)!.async('string');
    expect(await content('Sources/Local reading.pdf')).toBe('PDF bytes');
    expect(await content('Sources/Research.md')).toBe('Extracted passage.');
    expect(await content('Notes/Study.md')).toContain('> [!cite]- Sources');
    expect(await content('Notes/Study.md')).toContain('../Sources/Local%20reading.pdf');
  });
});
