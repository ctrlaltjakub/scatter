import { readFileSync } from 'node:fs';

const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || (process.env.VERCEL ? '/app' : '');
const channel = process.env.NEXT_PUBLIC_RELEASE_CHANNEL
  || (process.env.VERCEL_GIT_COMMIT_REF && process.env.VERCEL_GIT_COMMIT_REF !== 'main' ? 'beta' : 'stable');

/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath,
  env: { NEXT_PUBLIC_BASE_PATH: basePath, NEXT_PUBLIC_RELEASE_CHANNEL: channel, NEXT_PUBLIC_APP_VERSION: version },
  async headers() {
    return [{ source: '/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }] }];
  },
  async redirects() {
    return basePath ? [{ source: '/', destination: basePath, basePath: false, permanent: false }] : [];
  },
  // Isolate verification servers/builds without disturbing a running dev app.
  distDir: process.env.SCATTER_DIST_DIR || '.next',
  reactStrictMode: true,
  experimental: {
    // Allow worker imports from src/
  },
  webpack: (config, { isServer }) => {
    // Transformers.js exposes a Node binary entry whenever webpack resolves
    // packages under Node conditions—even when that import ultimately belongs
    // to a client component. Scatter's source embeddings are browser-only, so
    // pin this package to its WebAssembly/WebGPU build and keep native ONNX
    // binaries out of both the Vercel server graph and the client bundle.
    config.resolve.alias['@huggingface/transformers$'] = new URL(
      './node_modules/@huggingface/transformers/dist/transformers.web.js',
      import.meta.url,
    ).pathname;
    // Next 14's minifier cannot parse the worker-bundled `.mjs` build emitted
    // by this very new ONNX Runtime release. The equivalent external-WASM UMD
    // build has no `import.meta` worker wrapper and is safe for the browser.
    config.resolve.alias['onnxruntime-web/webgpu$'] = new URL(
      './node_modules/onnxruntime-web/dist/ort.webgpu.min.js',
      import.meta.url,
    ).pathname;
    if (isServer) {
      // konva's Node entry (lib/index-node.js) requires the optional `canvas`
      // npm package, which we don't ship — the image editor is client-only
      // (dynamic ssr:false), so the server bundle must treat it as external
      // instead of trying to resolve it. Standard react-konva + Next recipe.
      config.externals = [...config.externals, { canvas: 'commonjs canvas' }];
    }
    return config;
  },
};

export default nextConfig;
