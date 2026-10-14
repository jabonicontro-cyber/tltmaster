# External design skills: provenance and Taviron overrides

Reviewed 2026-10-14 by reading every file (no code run). Installed as copies from a local clone, not through a
plugin marketplace or installer. Taviron's rules in `CLAUDE.md` win over any advice in these skills.

| Folder | Source (commit) | License | What was copied |
| --- | --- | --- | --- |
| `frontend-design/` | `anthropics/skills` `skills/frontend-design` (dbd4588) | Apache-2.0 (`LICENSE.txt`) | Whole folder (markdown only). |
| `ui-ux-pro-max/` | `nextlevelbuilder/ui-ux-pro-max-skill` `.claude/skills/ui-ux-pro-max` (7246805) | MIT (`LICENSE`) | `SKILL.md`, `references/`, `data/` and the offline search scripts (standard library only, no network). **Not** the plugin's other skills (`design/` generators read `~/.claude/.env` and call third-party image APIs) and **not** its npm CLI. |
| `ckw-design/` | `connerkward/ckw-design-skill` (c8de7c8) | MIT (`LICENSE`) | Markdown sub-skills and `design-spatial/scripts/layout-audit.js` (runs in the browser page, no network). |
| `impeccable/` | `pbakaus/impeccable` `.claude/skills/impeccable` (2f98774, skill v4.5.2) | Apache-2.0 (`LICENSE`, `NOTICE.md`) | `SKILL.md` (**modified**, marked at the top) and `reference/` minus `live`, `live-setup`, `generate`, `visualize`, `hooks`, `doctor`, `degraded/asset-producer`. **Not** `scripts/` (its launcher downloads a binary that sends telemetry, can call OpenAI image generation with the shell's `OPENAI_API_KEY`, and prints instructions that try to override the agent's own rules), **not** its hooks/settings, agents, plugin, CLI or browser extension. |
| `taste-skill/` | `Leonxlnx/taste-skill` `skills/taste-skill` (a60a36d) | MIT (`LICENSE`) | `SKILL.md` (note added at the top) and `references/`. **Not** its scripts (one downloads third-party images), library, installer or the other skills in that repo (image generation, Google Stitch, conflicting fonts and dependencies). Public marketing pages only. |

Not installed: `jakubkrehel/better-ui` and `jakubkrehel/variant` could not be fetched (private or not found).

## Overrides for this project

- **No external generation APIs.** Ignore any advice to call image-generation or LLM APIs for assets (ckw-design
  "Generate"). Models are called only through `src/server/ai/` (docs/AI.md); website imagery follows docs/SCREENSHOTS.md.
- **Always honor `prefers-reduced-motion`** (and reduced transparency / more contrast). The ckw-design "personal
  project" exception does not apply: Taviron is a multi-user product.
- **Brand and tokens first.** Palettes, font pairings and styles suggested by ui-ux-pro-max or frontend-design are
  inspiration for structure and hierarchy only. Colours come from the Taviron tokens (CLAUDE.md "Brand", "Light and dark
  mode"); red only for genuine critical states; no `dark:` variants.
- **No new dependencies or installers.** Do not run `npx shadcn`, the ui-ux-pro-max CLI, or a local static server from a
  skill's instructions; use the project's own dev server and Playwright setup.
- **impeccable:** never run `scripts/impeccable` or `npx impeccable` (they are not installed); its "go all out / bolder /
  overdrive" framing does not apply to internal screens, which stay calm. Do not write PRODUCT.md or DESIGN.md to the
  repository; CLAUDE.md and the theme tokens are the design context.
- **taste-skill:** keep Taviron's palette and type (the equivalent of `--keep palette,type`); no generated or downloaded
  imagery; no invented sample content; its motion minimum is advisory.
- ui-ux-pro-max `--persist` writes files under `design-system/`; write them to the scratchpad, never commit them.
