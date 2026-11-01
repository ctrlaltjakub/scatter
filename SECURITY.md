# Dependency security notes

## Browser input boundaries

Imported documents, pasted HTML, Markdown, mathematical expressions and generated
interactive programs are untrusted input. Dependency updates must preserve the
editor schemas, sanitizer restrictions, URL checks and sandboxed iframe policies.
Do not replace these boundaries with a package-version check.

The November 2026 maintenance update patches the ProseMirror clipboard parser,
Mammoth's XML parser, DOMPurify and the framework/runtime dependencies. Regression
tests cover invalid clipboard attributes, the real editor schemas, rich paste
and undo/redo, multilingual Word extraction, bounded malformed documents and
untrusted mathematical commands.

## Deferred Tiptap 2 advisory

[GHSA-cp6q-959q-f8rh](https://github.com/advisories/GHSA-cp6q-959q-f8rh) affects
Tiptap 2's `mergeAttributes` helper. An untrusted attribute object containing an
own `__proto__` key can change the prototype of the helper's returned object.
This is a real library issue, but not global `Object.prototype` pollution by
itself.

The current editors construct content from text/Markdown and fixed schemas;
they do not import arbitrary Tiptap JSON or merge user-provided attribute maps.
No matching untrusted-object path was identified in the application. Boundary
tests exercise the app schemas and keep JSON-looking pasted content inert.

The coordinated Tiptap 3 migration is deferred to avoid changing editing and
history behavior in a dependency-maintenance release. The audit warning remains
visible; it is not suppressed. Reassess this decision before accepting arbitrary
editor JSON, adding extension attributes or changing HTML parsing. A future
migration must update all Tiptap packages together to a patched release and
retest both browser engines.

## Math renderer override

`rehype-katex` and `micromark-extension-math` still request the older KaTeX 0.16
line. The npm override resolves these copies to the app's patched direct KaTeX
version, keeping the renderer and loaded CSS aligned. This crosses the parents'
declared ranges intentionally; inline/block formulas, malformed formulas and
untrusted link/image commands have regression coverage. Recheck compatibility
when updating any of these packages and remove the override when the parents
adopt a patched line themselves.

## Build checks

Use `npm ci`, `npm run typecheck`, `npm test`, a production `/app` build and the
Chromium/Firefox browser checks before release. Inspect `npm audit --omit=dev`
by affected path and required conditions, not just the entry count. Never use
forced dependency downgrades or bypass the publication/credential hooks to make
an audit pass. The separately pinned landing demo needs its own rebuild when
the app's dependency lockfile changes.
