import { expect, test } from '@playwright/test';
import JSZip from 'jszip';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

test('downloads the canvas from Settings and runs its offline HTML at the authored viewport', async ({ page, context }, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/sandbox');
  await page.locator('.node[data-node-id]').first().waitFor();
  await page.evaluate(() => {
    const w = window as any;
    w.webpackChunk_N_E.push([['obsidian-fixture'], {}, (req: any) => {
      const store = (Object.values(req.c) as any[]).find(m => m.exports?.useGraphStore).exports.useGraphStore;
      const { project } = store.getState();
      const root = { ...project.nodes[project.rootNodeId], versions:[{ header:'Overview', body:'Opening paragraph.\n\n- First chapter\n  - Term: A definition.\n  - Also: Another point.',
        contentType:'encyclopedic', generatedBy:'manual', createdAt:1, sources:[{n:1,url:'https://example.org'}] }], currentVersionIndex:0 };
      const program = { ...root, id:'program', type:'interactive', position:{x:680,y:0}, versions:[{
        header:'Offline program', body:'A counter.', generatedBy:'interactive', contentType:'interactive', createdAt:1,
        interactive:{ html:"<!doctype html><html><head></head><body><button onclick=\"this.textContent=innerWidth+' by '+innerHeight\">Measure</button></body></html>",
          viewportWidth:640, viewportHeight:360, request:'A counter.' },
      }] };
      const turns = ['First question?', 'Last question?'].map((question,i) => ({ turnId:'turn'+i, question, state:'complete', informationChunking:false, contextPath:[], title:question }));
      const chat = { ...root,id:'chat',type:'chat',position:{x:0,y:440},versions:turns.map((chat,i)=>({
        header:'Answer',body:'Text for '+chat.question,createdAt:i+1,generatedBy:'chat',contentType:'chat',chat,
      })),chat:{title:'Conversation',informationChunking:false,parentSnapshots:{},compactions:[],
        turns:turns.map((t,i)=>({id:t.turnId,selectedVersionCreatedAt:i+1,versionCreatedAts:[i+1]}))} };
      store.setState({ project:{ ...project, name:'Export fixture', nodes:{ [root.id]:root, program,chat },
        arrows:{ a:{id:'a', fromNodeId:root.id,toNodeId:'program',kind:'auto'} } } });
    }]);
  });
  // The developer sandbox overlays its recorder on the sidebar's bottom row.
  await page.getByTestId('settings-gear').first().press('Enter');
  const settings = page.getByRole('dialog', {name:'Settings'});
  await settings.getByRole('button',{name:'Backup and local data',exact:true}).click();
  for (const width of [1440,1024,800]) {
    await page.setViewportSize({width,height:960});
    const controls = settings.getByRole('group',{name:'Settings backup actions'});
    const bounds = (await controls.boundingBox())!;
    for (const button of await controls.getByRole('button').all()) {
      const b = (await button.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(bounds.x - 1);
      expect(b.x + b.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
    }
  }
  const saving = page.waitForEvent('download');
  await settings.getByRole('button',{name:'Export to Obsidian Canvas'}).click();
  const download = await saving;
  expect(download.suggestedFilename()).toBe('Export fixture.obsidian.zip');
  await download.saveAs(info.outputPath('fixture.zip'));
  const zip = await JSZip.loadAsync(await readFile(info.outputPath('fixture.zip')));
  const file = Object.keys(zip.files).find(p => p.endsWith('.html'))!;
  const offline = info.outputPath('offline.html');
  await writeFile(offline, await zip.file(file)!.async('string'));
  const viewer = await context.newPage();
  const externalRequests: string[] = [];
  await viewer.route(/^https?:/, route => { externalRequests.push(route.request().url()); return route.abort(); });
  await viewer.setViewportSize({width:1900,height:1000});
  await viewer.goto(pathToFileURL(offline).href);
  const frame = viewer.locator('iframe'), button = frame.contentFrame().getByRole('button');
  await button.click();
  await expect(button).toHaveText('640 by 360');
  expect(await frame.boundingBox()).toMatchObject({width:640,height:360});
  await viewer.setViewportSize({width:320,height:500});
  await expect.poll(async () => (await frame.boundingBox())!.width).toBe(320);
  expect((await frame.boundingBox())!.height).toBe(180);
  await button.click();
  await expect(button).toHaveText('640 by 360');
  expect(await frame.getAttribute('sandbox')).toBe('allow-scripts');
  expect(externalRequests).toEqual([]);
});
