# Skills index

These are **vendored copies of the shared Gaia engineering skill set**, not skills authored for this project. The same nine directories appear byte-identical in `fa.lifeos` and `crusaders.mainframe`, and mirrors of varying vintage live under `.github/skills/` in several repos. Nothing reconciles any of them against upstream, so treat a disagreement between a skill here and the FrostAura root policy as drift in *this* copy.

**These copies are a stale generation.** Upstream — `Labs/projects/ai.toolkit.gaia/plugins/engineering/skills/` — has renamed every one of these `gaia-*` skills to `fa-*`. Consuming the plugin is the maintained path; this directory is a snapshot with no update mechanism. Do not hand-edit a skill here as though it were locally authored; fix it upstream or record the divergence. The portfolio-wide verdict on whether these copies should exist at all is in `Technologies/MEMORY.md`.

| Skill | Use it when |
| --- | --- |
| `gaia-process` | Routing a request through intake → architecture → planning → engineering → testing → release. Start here. |
| `gaia-architecture` | System structure, boundaries, interfaces or documented behaviour is changing. |
| `gaia-planning` | Turning a current architecture into a branch-aware plan with gates and proof expectations. |
| `gaia-engineering` | Implementing a planned branch against existing repo conventions. |
| `gaia-testing` | Unit, integration, regression and evidence review before a release call. |
| `gaia-ui-engineering` | Building or refactoring React UI — shadcn/ui composition and semantic Tailwind tokens. |
| `gaia-default-tech-stack` | The stack is unspecified, or an existing codebase is being standardised onto the mandate. |
| `gaia-agents` | Adding or revising an agent definition in `.claude/agents/` (mirror to `.github/agents/`). |
| `gaia-skills` | Adding or revising a `SKILL.md` — including the ones in this directory. |
| `references/` | Shared reference material the skills above link into. Not a skill; do not invoke it. |

**Precedence.** The project `CLAUDE.md` outranks anything here on project-specific rules, and FrostAura root policy outranks both. A skill that no longer matches how work is actually done in this repo gets fixed or deleted — see the Upkeep section of the project `CLAUDE.md`.
