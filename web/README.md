# Scatter — Web

The Next.js browser client. See the [project README](../README.md) for features,
provider setup, privacy information and licensing.

## Local development

Run from this `web/` directory using Node.js 22.13+ (22.x) or 24.x:

```bash
npm ci
npm run dev
```

Open [localhost:3000](http://localhost:3000) and complete onboarding. Use quick
setup with OpenRouter or add provider connections and choose models yourself.
Enter model-provider API keys in the app to store them on your device by default,
separate from the deployment. Requests go directly from your browser to your
chosen provider, never through our servers. There is no app backend that holds
your keys or collects your prompts, answers or canvas activity. Keep keys out of
public environment variables. See [privacy and data](../README.md#privacy-and-data)
for sync and export choices.

## Tests

- Types: `npm run typecheck`
- Unit: `npm test`
- E2E: `npm run e2e`
- Interactive browser compatibility: `npm run test:interactive-browsers`

`dev` and `build` explicitly use webpack. Keep the Transformers.js browser
alias and `transpilePackages` setting together: Next otherwise externalizes
that package and traces its native inference dependencies into the server.
Browser embeddings still run in a Web Worker. Media does not use Next's image
optimizer, which is disabled.

The project `.npmrc` skips ONNX Runtime's optional native GPU binary downloads.
Those CUDA/TensorRT files are not used by browser inference; the browser model
and WebAssembly assets remain available. Other dependency install scripts and
the publication/credential hooks still run normally.
Vercel also sets the supported `ONNXRUNTIME_NODE_INSTALL=skip` environment
variable explicitly, so deployment does not depend on npm's custom-config support.

The optional embedding-worker smoke test downloads the public, quantized model
and runs local inference; it makes no paid model requests. With a dev server
running, use `SCATTER_LIVE_IMAGE_SEARCH=1 SCATTER_EMBEDDING_SMOKE=1
PW_BASE_URL=http://localhost:3000 npx playwright test e2e/embedding-worker.spec.ts
--browser=chromium --workers=1` (also run with `--browser=firefox`).

See [dependency security notes](../SECURITY.md) for the remaining conditional
editor advisory and the math-renderer override.

## Optional Google Drive synchronization

Scatter keeps projects local by default. To make the Google Drive option in
Settings → Synchronization usable for a deployment:

1. Enable the Google Drive API in a Google Cloud project.
2. Create an OAuth 2.0 **Web application** client.
3. Add the development and production site origins to its authorized
   JavaScript origins. Google matches an origin exactly, including its port;
   wildcards such as `http://localhost:*` are not supported. Scatter's shared
   client registers these production and common local origins:

   - `https://scatter.study` and `https://www.scatter.study`
   - `http://localhost:3000` and `http://127.0.0.1:3000`
   - `http://localhost:3001` and `http://127.0.0.1:3001`
   - `http://localhost:4173` and `http://127.0.0.1:4173`
   - `http://localhost:5173` and `http://127.0.0.1:5173`
   - `http://localhost:8080` and `http://127.0.0.1:8080`

   A self-hosted instance on another origin needs its own Google OAuth client
   or must have that exact origin added to the deployment's client.
4. `scatter.study` and the local origins listed above automatically use
   Scatter's shared public OAuth client ID. A self-hosted deployment on another
   origin must set `NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID` to its own client ID in
   `.env.local` and in the deployment environment. OAuth client IDs are public
   identifiers; access remains restricted by Google's exact-origin allowlist.

Project synchronization requests only the `drive.appdata` scope. Files travel
directly from your browser to the app's hidden data folder in your Google Drive,
not through our servers. Model-provider API keys stay stored on your device by
default and are included in sync only if you explicitly enable key
synchronization. Cloud snapshots are not encrypted by the app; access is managed
through your chosen sync service.

The optional **Google Drive source picker** works automatically on
`scatter.study` and the local origins listed above. Its shared browser key is
restricted to Google Picker API and those exact websites. A self-hosted
deployment on another origin must enable Google Picker API in its own Cloud
project, set `NEXT_PUBLIC_GOOGLE_PICKER_API_KEY` to a browser- and
API-restricted key, and set `NEXT_PUBLIC_GOOGLE_DRIVE_APP_ID` to that Cloud
project number. Scatter requests the separate `drive.file` scope only when the
user presses **Google Drive** in Add sources, and can read only files explicitly
chosen through that picker; ordinary project sync remains `drive.appdata`-only.

## License

The app's original code is licensed under the
[PolyForm Noncommercial License 1.0.0](../LICENSE.md).
It permits use, modification, and redistribution for the purposes defined in
the license. Commercial uses outside those permissions require separate
permission from the relevant copyright holders.

This is a **source-available** license, not an open-source license.
Third-party components and assets retain their own licenses.
