# Open Apexpress

Standalone Windows app (Bun compiled executable) that deploys Docker containers on Distech ECLYPSE APEX controllers through the REST API v2 (`/api/rest/v2/services/containerization/...`).

- Runtime: Bun + TypeScript. UI: Preact via Bun HTML imports (`ui/index.html` imported by `src/server.ts`). No other framework.
- `bun test` (unit + integration against `src/mock/apex-mock.ts`), `bun check`, `bun run build` (dist/), `--self-test` on the built binary.
- UI e2e: `tests/e2e/ui.mjs` with Playwright (`node ui.mjs <url-with-token> <outdir>`).
- Recipes live in `src/recipes/catalog.ts`; every recipe must pass `lintContainer` (OPA rules) and deploy on the mock: the tests check all of them.
- All user-facing text exists in FR and EN (`L10n` objects, `ui/i18n.ts`).
- OPA rules observed in the field: host ports 50000-50999, ExposedPorts for published ports, Mounts not Binds, `CpusetCpus: "0"`, lowercase names, ARM64 images.
- The APEX response shapes are undocumented: keep parsing tolerant (`src/apex/client.ts`).
- Windows icon/metadata can only be embedded when compiling on Windows (CI job).
