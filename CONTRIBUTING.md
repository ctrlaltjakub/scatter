# Development

Use **Node.js 24** and run `npm ci` in `web`. Installation enables local
**secret and publication checks** for commits and pushes.

Work on **`beta`**. **`main`** is the stable release branch; releases advance it
to a tested beta commit without maintaining a separate codebase.

Before submitting a change, run:

```sh
node --test scripts/check-secrets.test.mjs scripts/publication-policy.test.mjs
cd web
npx tsc --noEmit
npm test
npm run build
```

Keep credentials in **ignored local files or environment variables**. Never
commit settings exports containing credentials, personal projects, browser
captures, agent instructions, or private notes. Use **synthetic fixtures** in
tests. The publication guard intentionally allows only application source,
runtime assets, tests, build tooling, and public documentation.

Local development uses **`/`**. Hosted builds use **`/app`**; set
`NEXT_PUBLIC_BASE_PATH=/app` to test that layout locally. Non-main Vercel
builds use the **beta** channel and a separate cloud-sync namespace.

The project is **source available under PolyForm Noncommercial 1.0.0**.
Read [the license](LICENSE.md) before redistributing or using it commercially.
