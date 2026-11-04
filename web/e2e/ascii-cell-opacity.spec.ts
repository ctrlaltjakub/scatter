import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { PASS_A_FRAGMENT_SRC, PASS_B_FRAGMENT_SRC, VERTEX_SRC } from '../src/lib/asciiAura/gl/shaders';

// Deliberately frozen oracles: both implementations must produce the same
// pixels, including all intermediate cooling frames. No real project or API.
const referenceA = readFileSync('e2e/fixtures/ascii-state-reference.glsl', 'utf8');
const referenceB = readFileSync('e2e/fixtures/ascii-composite-reference.glsl', 'utf8');

test('cached cell opacity is pixel-identical to the previous renderer', async ({ page }, info) => {
  test.setTimeout(120_000);
  const result = await page.evaluate(async ({ aSource, bSource, vertex, referenceA, referenceB, benchmark }) => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: true })!;
    if (!gl) throw new Error('WebGL2 is required');
    const renderer = gl.getExtension('WEBGL_debug_renderer_info');
    function program(source: string) {
      const p = gl.createProgram()!;
      for (const [type, text] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, source]] as const) {
        const shader = gl.createShader(type)!;
        gl.shaderSource(shader, text); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader)!);
        gl.attachShader(p, shader); gl.deleteShader(shader);
      }
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)!);
      return p;
    }
    const old = { a: program(referenceA), b: program(referenceB) };
    const next = { a: program(aSource), b: program(bSource) };
    gl.bindVertexArray(gl.createVertexArray()); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const textures: WebGLTexture[] = [], fbos: WebGLFramebuffer[] = [];
    function texture(w: number, h: number, data: Uint8Array | Float32Array | null, rg = false) {
      const t = gl.createTexture()!; textures.push(t); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, data instanceof Float32Array ? gl.RGBA32F : rg ? gl.RG8 : gl.RGBA8,
        w, h, 0, rg ? gl.RG : gl.RGBA, data instanceof Float32Array ? gl.FLOAT : gl.UNSIGNED_BYTE, data);
      return t;
    }
    const bind = (p: WebGLProgram, name: string, unit: number, t: WebGLTexture) => {
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(gl.getUniformLocation(p, name), unit);
    };
    const f = (p: WebGLProgram, name: string, value: number) => gl.uniform1f(gl.getUniformLocation(p, name), value);
    const i = (p: WebGLProgram, name: string, value: number) => gl.uniform1i(gl.getUniformLocation(p, name), value);
    const stats: { dpr: number; orb: boolean; frames: number; pixelDifferences: number; stateDifferences: number }[] = [];
    const times: { dpr: number; before: number; after: number }[] = [];
    for (const dpr of [1, 1.25, 2]) for (const orb of [false, true]) {
      // Uneven dimensions exercise partial cells at the right/bottom edges.
      const width = Math.round(641*dpr), height = Math.round(391*dpr), pitch = Math.round(9*dpr);
      canvas.width = width; canvas.height = height;
      const cols = Math.ceil(width/pitch), rows = Math.ceil(height/pitch), cssPitch = pitch/dpr;
      function target() {
        const state = texture(cols, rows, null), history = texture(cols, rows, null, true);
        const fbo = gl.createFramebuffer()!; fbos.push(fbo); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, state, 0);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, history, 0);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Incomplete target');
        return { state, history, fbo };
      }
      const oldTargets = [target(), target()], nextTargets = [target(), target()];
      const records = new Float32Array(100*16);
      const recordTex = texture(400, 1, records);
      const overlayBytes = new Uint8Array(cols*rows*4);
      for (let n = 0; n < cols*rows; n++) {
        if (n%13 === 0) {
          overlayBytes[n*4] = 20+n%130;
          overlayBytes[n*4+2] = n%4;
          overlayBytes[n*4+3] = [0, 255, 254, 252][n%4]!;
        }
        overlayBytes[n*4+1] = n%7 === 0 ? n%9 : 0;
      }
      const overlay = texture(cols, rows, overlayBytes);
      // Synthetic atlas includes transparent and antialiased ink in every
      // glyph. It catches wrong glyph selection/coverage, not just alpha.
      const atlasBytes = new Uint8Array(256*pitch*pitch*4);
      for (let n=0; n<atlasBytes.length/4; n++) atlasBytes[n*4+3] = [0, 51, 128, 204, 255][(n*7+Math.floor(n/(256*pitch)))%5]!;
      const atlas = texture(256*pitch, pitch, atlasBytes);
      const palette = new Float32Array(32*4);
      for(let n=0;n<32;n++) palette.set([.2+n%3*.25, .3, .8-n%3*.2, .55+n%3*.1],n*4);
      const statusColors = palette.slice(0,32);
      let frame = 0, pixelDifferences = 0, stateDifferences = 0;
      function draw(pair: typeof old, targets: ReturnType<typeof target>[], phase: number, read = true) {
        const write = targets[frame%2]!, previous = targets[1-frame%2]!;
        const zoom = [.15, .35, .75, 1, 2.3][Math.floor(phase/4)%5]!;
        const panX = phase*1.75-23.2, panY = phase*.47+11.3;
        gl.bindFramebuffer(gl.FRAMEBUFFER, write.fbo); gl.viewport(0,0,cols,rows); gl.useProgram(pair.a);
        bind(pair.a,'uRecords',0,recordTex); bind(pair.a,'uPrevState',1,previous.state); bind(pair.a,'uPrevOpacityHistory',2,previous.history);
        i(pair.a,'uRecordCount',phase%6 === 5 ? 0 : orb ? 2 : 100); i(pair.a,'uResetHistory',phase%4===0?1:0);
        i(pair.a,'uPointOpacityTrails',orb?1:0); f(pair.a,'uDtMs',[0,8.33,16.67,100][phase%4]!);
        f(pair.a,'uCoolRate',orb?4:20); f(pair.a,'uCellCssPx',cssPitch);
        gl.uniform3f(gl.getUniformLocation(pair.a,'uViewport'),panX,panY,zoom);
        gl.drawArrays(gl.TRIANGLES,0,3);
        const state = new Uint8Array(cols*rows*4);
        if(read) {gl.readBuffer(gl.COLOR_ATTACHMENT0); gl.readPixels(0,0,cols,rows,gl.RGBA,gl.UNSIGNED_BYTE,state);}
        gl.bindFramebuffer(gl.FRAMEBUFFER,null); gl.viewport(0,0,width,height); gl.useProgram(pair.b);
        bind(pair.b,'uCellState',0,write.state); bind(pair.b,'uRecords',1,recordTex); bind(pair.b,'uAtlas',2,atlas);
        bind(pair.b,'uOverlay',3,overlay); bind(pair.b,'uOpacityHistory',4,write.history);
        i(pair.b,'uPointOpacityTrails',orb?1:0); i(pair.b,'uPaletteCount',4);
        gl.uniform4fv(gl.getUniformLocation(pair.b,'uPalette[0]'),palette.slice(0,16));
        gl.uniform4fv(gl.getUniformLocation(pair.b,'uStatusColors[0]'),statusColors);
        gl.uniform4f(gl.getUniformLocation(pair.b,'uNeutral'),.6,.6,.6,phase%2?.65:1);
        f(pair.b,'uAlphaBoost',phase%2?.1:0); f(pair.b,'uOpacity',[0,.5,1,2][phase%4]!);
        f(pair.b,'uLabelOpacity',[1,2,.5,0][phase%4]!); f(pair.b,'uDeviceCellPx',pitch); f(pair.b,'uCellCssPx',cssPitch);
        f(pair.b,'uCanvasHpx',height); gl.uniform2i(gl.getUniformLocation(pair.b,'uCellsMax'),cols-1,rows-1);
        gl.uniform3f(gl.getUniformLocation(pair.b,'uViewport'),panX,panY,zoom);
        gl.drawArrays(gl.TRIANGLES,0,3);
        const pixels = new Uint8Array(read?width*height*4:4);
        gl.readPixels(0,0,read?width:1,read?height:1,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
        return { pixels, state };
      }
      for (let phase=0;phase<20;phase++,frame++) {
        for(let n=0;n<100;n++) {
          const point = orb && n<2, ghost = !point && n%7===0;
          records.set([point?200+n*120+phase*3:n%10*130+phase*2, point?240:Math.floor(n/10)*90,
            point?0:90,point?0:60,ghost?0:300,n%2,.65+n%3*.1,ghost?1:n%4+n/65536,
            .2+n%3*.25,.6,.8-n%3*.2,ghost?2:phase%3===0?1:0,phase*17,ghost?300:-1,-1,-1],n*16);
        }
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,recordTex);
        gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,400,1,gl.RGBA,gl.FLOAT,records);
        const before = draw(old,oldTargets,phase), after = draw(next,nextTargets,phase);
        for(let n=0;n<before.pixels.length;n++) if(before.pixels[n]!==after.pixels[n]) pixelDifferences++;
        for(let n=0;n<before.state.length;n++) if(before.state[n] !== (n%4===0?after.state[n]!&15:after.state[n])) stateDifferences++;
      }
      stats.push({dpr,orb,frames:frame,pixelDifferences,stateDifferences});
      if(benchmark && !orb && dpr!==1.25) {
        // Interleaved warmed samples include both passes and a synchronous
        // one-pixel readback. This measures this renderer, not whole-app FPS.
        const before: number[]=[], after: number[]=[];
        for(let n=0;n<18;n++) for(const which of n%2?[next,old]:[old,next]) {
          const start=performance.now(); draw(which,which===old?oldTargets:nextTargets,2,false);
          const elapsed=performance.now()-start;
          if(n>=4) (which===old?before:after).push(elapsed);
        }
        const median=(v:number[])=>v.sort((a,b)=>a-b)[Math.floor(v.length/2)]!;
        times.push({dpr,before:median(before),after:median(after)});
      }
      for(const t of textures.splice(0)) gl.deleteTexture(t);
      for(const fbo of fbos.splice(0)) gl.deleteFramebuffer(fbo);
    }
    const error=gl.getError();
    const gpu=renderer?gl.getParameter(renderer.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return {stats,times,error,gpu};
  }, {aSource:PASS_A_FRAGMENT_SRC,bSource:PASS_B_FRAGMENT_SRC,vertex:VERTEX_SRC,referenceA,referenceB,
    benchmark:process.env.SCATTER_ASCII_BENCH==='1'});
  await info.attach('renderer-parity-and-timing', {body:JSON.stringify(result,null,2),contentType:'application/json'});
  console.log(JSON.stringify(result));
  expect(result.error).toBe(0);
  for(const sample of result.stats) {
    expect(sample.pixelDifferences,JSON.stringify(sample)).toBe(0);
    expect(sample.stateDifferences,JSON.stringify(sample)).toBe(0);
  }
});
