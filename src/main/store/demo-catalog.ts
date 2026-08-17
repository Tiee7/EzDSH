/**
 * Bundled demo catalog for the store. When the remote curation API is
 * unreachable, `withDemoFallback` serves this catalog instead so every store
 * surface stays browsable and installable offline. Entries mirror real,
 * widely-used agent skills and MCP servers; skill payloads are genuine
 * SKILL.md instruction documents, and their manifest checksums are computed
 * from the same in-memory bytes the demo fetch serves, so the full
 * download → audit → confirm → install pipeline runs unchanged.
 *
 * @module demo-catalog
 */

import { createHash } from 'node:crypto'
import type { StoreCategory, StoreEntry, StoreFile, StoreKind, StoreListResult } from '../../shared/store.js'
import type { StoreClient, StoreListQuery } from './store-client.js'

/** URL prefix marking a file served from the bundled demo catalog. */
export const DEMO_FILE_URL_PREFIX = 'https://hub.ezdsh.com/demo-files/'

const DEMO_PAGE_SIZE = 24

// ---- Skill payloads ----

const BRAINSTORMING_SKILL = `---
name: brainstorming
description: Use before any creative work - features, components, behavior changes. Explores intent, requirements, and design through questions before implementation begins.
---

# Brainstorming

Creative work fails when requirements are assumed. This skill forces a design
conversation before any code is written.

## Process

1. **Restate the goal.** One or two sentences, in your own words. If you
   cannot restate it, you do not understand the task yet.
2. **Ask about intent, not implementation.** "What should this achieve?"
   beats "Should I use a queue here?"
3. **Surface constraints.** Performance, compatibility, deadlines, existing
   patterns. Write them down.
4. **Propose two or more approaches.** For each: what it costs, what it
   buys, where it breaks. No approach is free.
5. **Let the human choose.** Present the tradeoff table and stop. Do not
   start implementing until a direction is picked.

## Questions that work

- What problem does this solve for the user?
- What is the smallest version that delivers value?
- What must this NOT do?
- What breaks if this is used 100x more than expected?

## Anti-patterns

- Jumping to a framework or library before the shape of the problem is known.
- Presenting one option disguised as a decision.
- Infinite questioning: after the constraints are clear, move to design.
`

const SYSTEMATIC_DEBUGGING_SKILL = `---
name: systematic-debugging
description: Use when facing any bug, test failure, or unexpected behavior, before proposing fixes. Finds root causes through evidence instead of guess-and-check patching.
---

# Systematic Debugging

The first explanation for a bug is usually wrong. This skill replaces
hypothesis-flavored patching with evidence collection.

## Rules

1. **Reproduce first.** A bug you cannot reproduce on demand cannot be
   verified as fixed. Find the smallest reliable reproduction.
2. **Read the error.** The full message, the stack, the line numbers.
   Half of debugging is reading carefully.
3. **Bisect.** When did it last work? What changed between then and now?
   Commits, config, environment, data.
4. **Form ONE hypothesis at a time** and design the cheapest experiment
   that could disprove it.
5. **Never fix what you cannot explain.** If the fix works but you cannot
   say why, you have not found the root cause - you have hidden it.

## Logging over breakpoints for distributed code

Add temporary structured logs around the suspect region, run the
reproduction, and read the timeline. Remove the logs afterwards.

## Exit criteria

- The root cause is stated in one sentence.
- The reproduction fails before the fix and passes after.
- A regression test guards the exact failure mode.
`

const TEST_DRIVEN_DEVELOPMENT_SKILL = `---
name: test-driven-development
description: Use when implementing any feature or bugfix, before writing implementation code. Red-green-refactor keeps design honest and defects shallow.
---

# Test-Driven Development

Write the test that fails first. If you cannot write the test, you do not
understand the requirement.

## The cycle

1. **Red.** Write one small test for behavior that does not exist yet.
   Run it. Watch it fail. A test that passes on the first run is testing
   nothing new - delete or weaken it until it fails.
2. **Green.** Write the simplest implementation that makes the test pass.
   Simple means ugly. Resist polish; the cycle is not done.
3. **Refactor.** With the suite green, clean up duplication and names.
   Run the tests after every small change.

## Discipline

- One behavior per test, named after the behavior.
- Test through the public interface, not private internals.
- If the red step reveals a design problem, stop coding and redesign.
- A bugfix starts with a test that reproduces the bug.

## When not to TDD

Exploratory spikes, throwaway prototypes, and pure visual styling. Say out
loud which one you are doing, and timebox it.
`

const WRITING_PLANS_SKILL = `---
name: writing-plans
description: Use when a task spans multiple steps or files, before touching code. Converts requirements into a sequenced, verifiable implementation plan.
---

# Writing Plans

A plan is a promise about order and verification. Written before
implementation, it survives context switches and enables review.

## Structure

1. **Context.** What exists today, in two sentences.
2. **Goal.** The observable change when done - what a user or test can see.
3. **Steps.** Ordered, each one independently verifiable:

   - Files touched and why.
   - The verification command for that step alone.

4. **Risks.** What each step can break, and how you will notice.
5. **Rollback.** The commit to return to if step N goes wrong.

## Rules

- Every step ends with something runnable: a test, a command, a check.
- If a step cannot be verified, it is two steps hiding as one.
- Plans are written to be executed by someone with less context than you.
- When reality diverges from the plan, update the plan first.
`

const VERIFICATION_BEFORE_COMPLETION_SKILL = `---
name: verification-before-completion
description: Use before claiming any work is complete, fixed, or passing. Evidence before assertions, always.
---

# Verification Before Completion

"I think it works" is a feeling. "The suite passes: 214 tests, 0 skipped,
command and output below" is a claim. Only the second ends a task.

## Checklist

1. **Run the real verification commands** - full suite, build, lint - not
   a subset you remember being green.
2. **Read the output.** All of it. Warnings count. Skipped tests count
   double: they are failures wearing a disguise.
3. **Check the edges you touched.** New file? It is committed. New
   dependency? It is installed, not just imported.
4. **Report with evidence.** Paste the command and the result summary.
   A success claim without output is a hypothesis.

## Language

- Before: "Done, tests pass."
- After: "Done. \`npm test\` → 48 passed, 0 failed (output above)."

If you cannot produce the evidence, the work is not done. Say so instead.
`

const CONVENTIONAL_COMMITS_SKILL = `---
name: conventional-commits
description: Use whenever creating a git commit. Enforces concise, imperative, conventional commit messages with a clean staging area.
---

# Conventional Commits

Commits are read a hundred times for every time they are written. Optimize
for the reader six months from now.

## Format

    <type>: <imperative summary, lowercase, no period>

    <optional body: why the change was made, wrapped at 72 columns>

## Types

- feat - new capability
- fix - defect repair
- refactor - behavior-preserving change
- test - test-only change
- docs - documentation only
- chore - tooling, deps, config
- perf - performance improvement

## Before committing

1. \`git status\` and \`git diff --staged\` - stage only what belongs to the
   change; never bundle unrelated files.
2. Never stage local credentials, tokens, or keys. If a secret reaches the
   index, stop and rotate it - history rewrites do not un-leak.
3. One logical change per commit. If the summary needs "and", split it.

## Summary test

Complete this sentence with the summary: "If applied, this commit will
<summary>." If it does not read as a sentence, rewrite it.
`

const TECHNICAL_DOCUMENTATION_SKILL = `---
name: technical-documentation
description: Use when writing or updating READMEs, API references, or tutorials. Turns engineering concepts into documents developers actually use.
---

# Technical Documentation

The reader is a competent developer with zero context on this codebase.
Write the document you would want to find at 2am during an incident.

## Order of a README

1. **What it is.** One sentence. No vision statements.
2. **Quick start.** Copy-paste commands that go from clone to running in
   under five minutes. Verify every command.
3. **Common tasks.** Build, test, deploy - the five things people do daily.
4. **Architecture, briefly.** A diagram and one paragraph per component.
5. **Troubleshooting.** Real errors, real fixes, phrased as the error
   message the reader will actually paste.

## Rules

- Every code block is tested. Untested examples rot silently.
- Link to canonical sources for fast-moving topics (see the MCP registry at
  https://github.com/modelcontextprotocol/servers) instead of copying
  details that drift.
- Document the why; the code already says the what.
- Delete outdated content on sight. Wrong docs are worse than none.
`

interface DemoSkill {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly category: string
  readonly auditLevel: 'verified' | 'basic'
  readonly version: string
  readonly readme: string
  readonly content: string
}

const DEMO_SKILLS: readonly DemoSkill[] = [
  {
    id: 'brainstorming',
    name: 'Brainstorming',
    description: 'Explores intent, requirements, and design through questions before any creative work starts.',
    category: 'workflow',
    auditLevel: 'verified',
    version: '1.2.0',
    readme: 'Forces a design conversation before code: restate the goal, surface constraints, propose approaches with tradeoffs, and let the human choose.',
    content: BRAINSTORMING_SKILL
  },
  {
    id: 'systematic-debugging',
    name: 'Systematic Debugging',
    description: 'Finds root causes through evidence - reproduce, read, bisect - instead of guess-and-check patching.',
    category: 'quality',
    auditLevel: 'verified',
    version: '1.4.0',
    readme: 'Reproduce first, read the full error, bisect the change window, test one hypothesis at a time, and never ship a fix you cannot explain.',
    content: SYSTEMATIC_DEBUGGING_SKILL
  },
  {
    id: 'test-driven-development',
    name: 'Test-Driven Development',
    description: 'Red-green-refactor discipline for any feature or bugfix; keeps design honest and defects shallow.',
    category: 'quality',
    auditLevel: 'verified',
    version: '2.0.1',
    readme: 'Write the failing test, make it pass with the simplest code, refactor under a green suite. Includes when NOT to TDD.',
    content: TEST_DRIVEN_DEVELOPMENT_SKILL
  },
  {
    id: 'writing-plans',
    name: 'Writing Plans',
    description: 'Turns multi-step requirements into sequenced, individually verifiable implementation plans.',
    category: 'workflow',
    auditLevel: 'basic',
    version: '1.1.0',
    readme: 'Context, goal, steps with per-step verification commands, risks, and rollback. Written to be executed by someone with less context than you.',
    content: WRITING_PLANS_SKILL
  },
  {
    id: 'verification-before-completion',
    name: 'Verification Before Completion',
    description: 'Evidence before assertions: run the real commands, read all output, report with proof.',
    category: 'quality',
    auditLevel: 'basic',
    version: '1.0.2',
    readme: 'A task is done only when the claim ships with command output. Skipped tests count double.',
    content: VERIFICATION_BEFORE_COMPLETION_SKILL
  },
  {
    id: 'conventional-commits',
    name: 'Conventional Commits',
    description: 'Concise imperative commit messages, clean staging, and one logical change per commit.',
    category: 'git',
    auditLevel: 'verified',
    version: '1.3.0',
    readme: 'Type-prefixed summaries that complete "If applied, this commit will ...", with staging-area hygiene and secret-detection steps.',
    content: CONVENTIONAL_COMMITS_SKILL
  },
  {
    id: 'technical-documentation',
    name: 'Technical Documentation',
    description: 'READMEs, API references, and tutorials that go from clone to running in five minutes.',
    category: 'docs',
    auditLevel: 'basic',
    version: '1.0.0',
    readme: 'Quick-start-first structure, tested code blocks, links to canonical sources, and ruthless deletion of outdated content.',
    content: TECHNICAL_DOCUMENTATION_SKILL
  }
]

// ---- Preset payloads ----
//
// Compositions stay fully declarative: the audit engine blocks `!!js`
// expressions in store-installed presets, so platform conditionals and
// code-evaluated paths (the shipped presets' `disabled: !!js` rows and
// `customSkillDirs` hooks) are deliberately absent.

const DEEP_RESEARCH_COMPOSITION = `# The \`deep-research\` agent preset: a web-first research agent built on the
# standard toolset. Search and fetch are always on, and the persona installs a
# research methodology: query design, source triangulation, synthesis.
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: |
      You are a research agent operating in Deep Research mode, powered by {{model}}. Your working directory is {{cwd}}.

      You investigate questions with the live web: design queries, read multiple independent sources, and synthesize findings the reader can act on. Every claim in your output traces to a fetched source; distinguish what sources say, what you inferred, and what remains unknown or contested.

      Work in passes. SCOPING: restate the question, name the decision it serves, and list what an answer must cover. SEARCH: branch queries by sub-question, entity name, and language; prefer official documentation, standards, primary data, and recent reporting over aggregators that merely restate. READ: fetch the promising results; skip paywall summaries and content farms instead of guessing from snippets. TRIANGULATE: a load-bearing claim needs at least two independent sources; record where they disagree. SYNTHESIZE: write for the stated audience - a direct answer first, then evidence, then open questions.

      Never fabricate links, quotes, numbers, or dates. If a page could not be fetched, say so and drop the claim rather than keeping it on memory alone. Track the access date of every source. Save the deliverable under research/ in the workspace: report.md plus sources.md (URL, title, access date, one-line verdict per source).
- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
  config:
    sampleOverCapGlobResults: false
- id: tool-todo
  name: '@deepseek-ai/dsh-tool-todo'
  config:
    allowParallelInProgress: true
- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetch: true
    searchTimeoutMs: 60000
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config:
        thresholdChars: 8192
        headChars: 4096
        tailChars: 1024
`

const CODE_REVIEW_COMPOSITION = `# The \`code-review\` agent preset: a read-only reviewer built on the standard
# toolset. The persona installs a review discipline: inspect the real diff,
# review by risk category, no drive-by refactors. The deliverable is the review.
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: |
      You are a code review agent operating in Code Review mode, powered by {{model}}. Your working directory is {{cwd}}.

      You review changes and codebases, and you do not modify them. Never edit files, run formatters or code generators, commit, or push. Read-only inspection commands (status, diff, log, show, grep, tests that do not rewrite tracked files) are your instruments.

      Ground every finding in the actual code. Read the diff hunk by hunk with its surrounding context; open the callers and the tests a change touches before judging it. Findings cite file and line, quote the relevant code, and say what breaks and under what input - not that something could be improved.

      Review by risk, in order: correctness (does the change do what it claims, edge cases, error paths, concurrency), security (injection, authz, secrets, untrusted input), then maintainability and tests. Flag what a test should have covered. Separate severity - block (must fix before merge), warn (should fix, named consequence), note (optional) - and keep style opinions out unless they hide real defects.

      Acknowledge what you did not review and why. End with a verdict: approve, approve with comments, or request changes, each with its one-paragraph justification.
- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
  config:
    sampleOverCapGlobResults: false
- id: tool-todo
  name: '@deepseek-ai/dsh-tool-todo'
  config:
    allowParallelInProgress: true
- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetch: true
    searchTimeoutMs: 60000
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config:
        thresholdChars: 8192
        headChars: 4096
        tailChars: 1024
`

const DATA_ANALYSIS_COMPOSITION = `# The \`data-analysis\` agent preset: an analysis agent built on the standard
# toolset. The persona installs a probe-first, reproducible analysis
# methodology over shell and filesystem tools.
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: |
      You are a data analysis agent operating in Data Analysis mode, powered by {{model}}. Your working directory is {{cwd}}.

      You answer questions with data: probe before assuming, profile before modeling, and show the evidence behind every number you report. The reader must be able to re-run your steps and get the same result.

      Begin by pinning the question and its decision, the metric definitions, and the population in scope. Then probe: which interpreter and packages exist (python3 and pandas availability, versions), where the data lives, its size and format. Profile every dataset before using it - row counts, schemas, types, null rates, duplicates, ranges, and the anomalies that would silently distort an answer. Never overwrite source data; write derived files under analysis/.

      Keep work reproducible: prefer scripted steps over interactive one-liners when a transformation matters, name intermediate artifacts, and record versions with the result. When results look surprising, suspect the pipeline first - a join key that is not unique, a filter that dropped half the rows, a unit mismatch - before believing the finding.

      Quantify uncertainty the data supports and no further: state sample sizes, note missingness and selection effects, and refuse conclusions the data cannot carry. Report honestly - no signal in this data is an answer. Deliverables under analysis/: the answer with its evidence, the scripts or command trail, generated figures, and a short README stating how to reproduce.
- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
  config:
    sampleOverCapGlobResults: false
- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'
- id: tool-todo
  name: '@deepseek-ai/dsh-tool-todo'
  config:
    allowParallelInProgress: true
- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetch: true
    searchTimeoutMs: 60000
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config:
        thresholdChars: 8192
        headChars: 4096
        tailChars: 1024
`

interface DemoPreset {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly category: string
  readonly auditLevel: 'verified' | 'basic'
  readonly version: string
  readonly readme: string
  readonly composition: string
  readonly meta: string
}

const DEMO_PRESETS: readonly DemoPreset[] = [
  {
    id: 'deep-research',
    name: '深度研究模式 (Deep Research)',
    description: '面向开放问题的联网研究 Agent：多源检索、交叉验证、可溯源的综合报告。',
    category: 'modes',
    auditLevel: 'verified',
    version: '1.0.0',
    readme: 'Installs the deep-research agent preset into the local roster. Search and fetch stay on; the persona drives scoping, query design, source triangulation, and a report-plus-source-list deliverable. Appears in the runtime mode picker immediately after install.',
    composition: DEEP_RESEARCH_COMPOSITION,
    meta: 'name: 深度研究模式\ndescription: 面向开放问题的联网研究 Agent：多源检索、交叉验证、可溯源的综合报告。\norder: 6\n'
  },
  {
    id: 'code-review',
    name: '代码审查模式 (Code Review)',
    description: '只读的代码审查 Agent：基于真实 diff 按正确性、安全性与可维护性分级给出可执行的审查结论。',
    category: 'modes',
    auditLevel: 'verified',
    version: '1.0.0',
    readme: 'Installs the code-review agent preset into the local roster. A read-only review contract (no edits, no commits), findings grounded in cited file and line with severity block/warn/note, and a verdict-first report. Appears in the runtime mode picker immediately after install.',
    composition: CODE_REVIEW_COMPOSITION,
    meta: 'name: 代码审查模式\ndescription: 只读的代码审查 Agent：基于真实 diff 按正确性、安全性与可维护性分级给出可执行的审查结论。\norder: 7\n'
  },
  {
    id: 'data-analysis',
    name: '数据分析模式 (Data Analysis)',
    description: '探查优先、可复现的数据分析 Agent：环境与数据画像、脚本化清洗、图表与结论报告。',
    category: 'modes',
    auditLevel: 'verified',
    version: '1.0.0',
    readme: 'Installs the data-analysis agent preset into the local roster. Probe the toolchain and profile datasets before transforming, keep steps scripted and reproducible under analysis/, and calibrate confidence to what the data carries. Appears in the runtime mode picker immediately after install.',
    composition: DATA_ANALYSIS_COMPOSITION,
    meta: 'name: 数据分析模式\ndescription: 探查优先、可复现的数据分析 Agent：环境与数据画像、脚本化清洗、图表与结论报告。\norder: 8\n'
  }
]

interface DemoMcp {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly category: string
  readonly auditLevel: 'verified' | 'basic'
  readonly version: string
  readonly readme: string
  readonly mcp: {
    readonly transport: 'stdio' | 'streamable-http'
    readonly serverName: string
    readonly command?: string
    readonly args?: readonly string[]
    readonly url?: string
  }
}

const DEMO_MCPS: readonly DemoMcp[] = [
  {
    id: 'context7',
    name: 'Context7',
    description: 'Up-to-date documentation for any library, injected into context on demand.',
    category: 'tools',
    auditLevel: 'verified',
    version: '1.9.2',
    readme: 'Resolves "resolve-library-id" and "get-library-docs" tools against fresh upstream docs, so answers stop citing APIs that were removed two majors ago.',
    mcp: { transport: 'streamable-http', serverName: 'context7', url: 'https://mcp.context7.com/mcp' }
  },
  {
    id: 'playwright',
    name: 'Playwright',
    description: 'Drives a real browser: navigate, click, fill, screenshot, assert on live pages.',
    category: 'tools',
    auditLevel: 'verified',
    version: '1.53.0',
    readme: 'Gives the agent an accessibility-tree view of pages and the full Playwright action set. Ideal for verifying web UIs end to end.',
    mcp: { transport: 'stdio', serverName: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp@latest'] }
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    description: 'Structured, revisable chain-of-thought scratchpad for multi-step reasoning.',
    category: 'tools',
    auditLevel: 'basic',
    version: '0.11.0',
    readme: 'One thought per call, with branches and revisions, so long reasoning chains stay inspectable instead of hidden in a single completion.',
    mcp: { transport: 'stdio', serverName: 'sequential-thinking', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] }
  }
]

// ---- Catalog assembly ----

function demoFile(id: string, path: string, content: string): StoreFile {
  return {
    path,
    url: `${DEMO_FILE_URL_PREFIX}${id}/${path}`,
    sha256: createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex'),
    kind: 'text'
  }
}

const SKILL_ENTRIES: readonly StoreEntry[] = DEMO_SKILLS.map((skill) => ({
  id: skill.id,
  kind: 'skill' as const,
  name: skill.name,
  description: skill.description,
  category: skill.category,
  auditLevel: skill.auditLevel,
  version: skill.version,
  readme: skill.readme,
  files: [demoFile(skill.id, `${skill.id}/SKILL.md`, skill.content)]
}))

const MCP_ENTRIES: readonly StoreEntry[] = DEMO_MCPS.map((server) => ({
  id: server.id,
  kind: 'mcp' as const,
  name: server.name,
  description: server.description,
  category: server.category,
  auditLevel: server.auditLevel,
  version: server.version,
  readme: server.readme,
  mcp: server.mcp
}))

/** Every file of a demo preset bundle, content kept for the in-memory fetch. */
const PRESET_FILE_ROWS: readonly (readonly { id: string; path: string; content: string }[])[] = DEMO_PRESETS.map((preset) => [
  { id: preset.id, path: `${preset.id}/agent.cordis.yml`, content: preset.composition },
  { id: preset.id, path: `${preset.id}/preset.yml`, content: preset.meta }
])

const PRESET_ENTRIES: readonly StoreEntry[] = PRESET_FILE_ROWS.map((rows, index) => {
  const preset = DEMO_PRESETS[index]
  return {
    id: preset.id,
    kind: 'preset' as const,
    name: preset.name,
    description: preset.description,
    category: preset.category,
    auditLevel: preset.auditLevel,
    version: preset.version,
    readme: preset.readme,
    files: rows.map((row) => demoFile(row.id, row.path, row.content))
  }
})

const ENTRIES_BY_KIND: Record<StoreKind, readonly StoreEntry[]> = {
  skill: SKILL_ENTRIES,
  preset: PRESET_ENTRIES,
  mcp: MCP_ENTRIES
}

const ENTRY_BY_KEY = new Map<string, StoreEntry>()
for (const entry of [...SKILL_ENTRIES, ...PRESET_ENTRIES, ...MCP_ENTRIES]) {
  ENTRY_BY_KEY.set(`${entry.kind}:${entry.id}`, entry)
}

const DEMO_FILE_BY_URL = new Map<string, string>()
for (const skill of DEMO_SKILLS) {
  DEMO_FILE_BY_URL.set(`${DEMO_FILE_URL_PREFIX}${skill.id}/${skill.id}/SKILL.md`, skill.content)
}
for (const rows of PRESET_FILE_ROWS) {
  for (const row of rows) {
    DEMO_FILE_BY_URL.set(`${DEMO_FILE_URL_PREFIX}${row.id}/${row.path}`, row.content)
  }
}

/** Raw bundled entries of one kind — the always-available baseline catalog. */
export function demoEntries(kind: StoreKind): readonly StoreEntry[] {
  return ENTRIES_BY_KIND[kind] ?? []
}

/** Demo category list spanning all surfaces. */
export function demoCategories(): StoreCategory[] {
  return [
    { id: 'workflow', name: 'Workflow' },
    { id: 'quality', name: 'Code Quality' },
    { id: 'docs', name: 'Documentation' },
    { id: 'git', name: 'Git' },
    { id: 'modes', name: 'Agent Modes' },
    { id: 'tools', name: 'Tools (MCP)' }
  ]
}

/** Serve one demo catalog page, filtered like the remote list endpoint. */
export function demoList(kind: StoreKind, query: StoreListQuery = {}): StoreListResult {
  const search = query.search?.trim().toLowerCase() ?? ''
  let entries = ENTRIES_BY_KIND[kind] ?? []
  if (query.category !== undefined && query.category !== '') {
    entries = entries.filter((entry) => entry.category === query.category)
  }
  if (search !== '') {
    entries = entries.filter((entry) =>
      `${entry.id} ${entry.name} ${entry.description}`.toLowerCase().includes(search))
  }
  const page = Math.max(1, query.page ?? 1)
  const pageCount = Math.max(1, Math.ceil(entries.length / DEMO_PAGE_SIZE))
  const slice = entries.slice((page - 1) * DEMO_PAGE_SIZE, page * DEMO_PAGE_SIZE)
  return { entries: slice, page, pageCount, source: 'demo' }
}

/** Fetch one demo entry; rejects for unknown ids like the remote endpoint. */
export async function demoEntry(kind: StoreKind, id: string): Promise<StoreEntry> {
  const entry = ENTRY_BY_KEY.get(`${kind}:${id}`)
  if (entry === undefined) {
    throw new Error(`Demo catalog has no entry for ${kind}/${id}`)
  }
  return entry
}

/**
 * Fetch implementation that serves demo file URLs from memory and delegates
 * everything else to the wrapped implementation. Wired into the store
 * service so the demo catalog installs through the normal, checksum-verified
 * download pipeline without network access.
 */
export function createDemoFetch(baseFetch: typeof fetch = fetch): typeof fetch {
  return (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL ? input.toString() : input.url
    const content = url === undefined ? undefined : DEMO_FILE_BY_URL.get(url)
    if (content !== undefined) {
      return Promise.resolve(new Response(content, { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8' } }))
    }
    if (url !== undefined && url.startsWith(DEMO_FILE_URL_PREFIX)) {
      return Promise.resolve(new Response('Not found', { status: 404 }))
    }
    return baseFetch(input, init)
  }
}

/**
 * Wrap a store client so catalog calls fall back to the bundled demo catalog
 * when the remote curation API is unreachable. Demo responses carry
 * `source: 'demo'` so the renderer can label them.
 */
export function withDemoFallback(client: Pick<StoreClient, 'list' | 'entry' | 'categories'>): Pick<StoreClient, 'list' | 'entry' | 'categories'> {
  return {
    async list(kind: StoreKind, query: StoreListQuery = {}): Promise<StoreListResult> {
      try {
        return await client.list(kind, query)
      } catch {
        return demoList(kind, query)
      }
    },
    async entry(kind: StoreKind, id: string): Promise<StoreEntry> {
      try {
        return await client.entry(kind, id)
      } catch {
        return demoEntry(kind, id)
      }
    },
    async categories(): Promise<StoreCategory[]> {
      try {
        return await client.categories()
      } catch {
        return demoCategories()
      }
    }
  }
}
