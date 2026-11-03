# FlexServer Web

React 18/TypeScript dashboard and public pages, built with Vite. These instructions apply to `packages/web/` and supplement the [root instructions](../../AGENTS.md).

## Commands

Run from the repository root after `npm ci`:

```bash
npm run dev:web
npm run typecheck -w @vps-manager/web
npm test -- packages/web/src
npm run build:web
```

- Run the API in a separate terminal with `npm run dev`. Vite proxies `/api` to `http://localhost:3000`; use `VITE_API_TARGET` when a different development API is needed.
- `npm run build:web` writes into root `public/` with `emptyOutDir: true`. Keep hand-maintained files out of that output directory and edit frontend source instead of generated bundles.
- Keep the Vite `es2021` build target: terminal parser compatibility depends on it.

## Architecture and conventions

- `src/App.tsx` owns public routes and lazy-loads `DashboardApp`. Keep public pages independent of dashboard authentication and monitoring subscriptions.
- `src/DashboardApp.tsx` owns the authenticated console boundary. Preserve the `/api/auth/me` login gate.
- `src/context/DashboardContext.tsx` owns shared operational state and the `/api/monitoring/stream` SSE subscription. Reuse that flow rather than adding duplicate subscriptions for individual components.
- `src/context/VpsWorkspaceContext.tsx` owns host-scoped workspace state and navigation. Keep actions and responses scoped to the selected VPS.
- Use the `@/` alias for `src/`, existing `components/ui` primitives, and `cn` from `src/lib/utils.ts` for composed class names.
- Reuse `src/components/Brand.tsx` and `src/assets/brand/` for brand marks rather than creating alternate logos.

## UI changes

Before changing UI, read [DESIGN.md](../../DESIGN.md) and [MASTER.md](../../MASTER.md).

- Reuse semantic colors from `src/index.css` and `tailwind.config.js`; keep palette primitives and semantic aliases consistent.
- Preserve flat, square panels, hairline borders, and the restrained lime accent. Use Instrument Sans for interface text and Geist Mono/tabular numerals for telemetry.
- Use installed Radix primitives and existing components for keyboard interaction, focus, and accessible controls.
- Prefer the least visible text that still makes each action and state clear. Use concise labels and familiar icons; remove repeated status text and explanations that clutter the interface.
- Move supplementary detail into accessible tooltips when needed, available on keyboard focus as well as hover. Keep essential instructions, errors, and safety-critical consequences visible; give icon-only controls accessible names.
- The installed animation package is `motion`; use `motion/react` and respect reduced-motion preferences.

## Verification

- Component tests use Vitest, React Testing Library, and jsdom; root test discovery includes `src/**/*.test.tsx`. Reuse `src/test/setup.ts` for shared browser stubs.
- Test observable behavior such as login gates, selected-host transitions, loading/error states, and action confirmation rather than incidental markup or class strings.
- Exercise changed UI in a browser with the appropriate API mode. Check keyboard navigation, focus, narrow layouts, and live updates when relevant; jsdom cannot prove terminal rendering or layout.
- Browser journeys live in root `e2e/`; `npm run test:e2e` builds the application before running Playwright.
