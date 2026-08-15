# Repository Guidelines

## Project Structure & Module Organization

This is a Next.js 14 TypeScript application. App Router code lives in `src/app/`; shared UI belongs in `src/components/`; domain logic belongs in `src/lib/`. MCP gateway code is under `src/lib/mcp/`. Put Vitest suites in `tests/` and name them `*.test.ts` or `*.test.tsx`. Static assets live in `public/`, utilities in `scripts/`, and the standalone LLM service in `services/llm/`.

## Build, Test, and Development Commands

- `pnpm install` installs the Node 20+ workspace dependencies.
- `pnpm dev` starts the local site at `http://localhost:3003`.
- `pnpm build` creates the production build; `pnpm start` serves it.
- `pnpm test` runs all Vitest tests once; `pnpm test:watch` provides feedback while editing.
- `pnpm mcp:smoke` runs the focused MCP gateway and route smoke suites.
- `pnpm typecheck` runs strict TypeScript checks without emitting files.
- `pnpm lint` runs the configured Next.js lint checks.
- `./run.sh ship` runs setup, tests, build, smoke checks, and reporting.

## Coding Style & Naming Conventions

Use strict TypeScript, two-space indentation, semicolons, and single quotes, matching existing files. Prefer the `@/` alias for imports from `src/`. Name React components and their files in PascalCase (`BundleRequestForm.tsx`); use camelCase for functions and variables, and kebab-case for route directories. Keep route handlers thin and move reusable business logic into focused `src/lib/` modules. Avoid new runtime dependencies unless necessary.

## Testing Guidelines

Vitest runs in `jsdom` with shared setup from `tests/setup.ts`. Add regression tests for behavior changes, especially payment, wallet-auth, security, MCP transport, and feature-flag paths. Keep tests deterministic; gate tests requiring live services behind explicit environment variables. Before opening a PR, run `pnpm test`, `pnpm typecheck`, and `pnpm build`.

## Commit & Pull Request Guidelines

Recent history favors short, imperative subjects and Conventional Commit prefixes such as `feat:` and `fix:`. Keep unrelated changes separate. PRs should explain motivation and implementation, list validation commands, link relevant issues, and include screenshots for UI changes. Call out new environment variables, payment/network effects, feature flags, and deployment considerations.

## Security & Configuration

Copy `.env.example` to `.env.local`; never commit credentials or private keys. Preserve mock-mode defaults where possible. For Status Network transactions, always estimate immediately before sending with `linea_estimateGas`, include `from`, and handle both gasless and premium fee responses without hardcoded fees.
