# Bourdieu Perspective Skill and Eight-Person Roundtable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a source-traceable Pierre Bourdieu perspective Skill with the Nuwa workflow and add Bourdieu as the eighth permanent speaker in the production thought roundtable.

**Architecture:** The full research and reasoning artifact lives in `/Users/llin/Desktop/.agents/skills/bourdieu-perspective/`. A reviewed short projection is written to `references/roundtable-prompt.md` and then embedded in the existing static `public/roundtable/index.html`; the shared Node backend, database, billing price, context limit, and 24-call cap remain unchanged.

**Tech Stack:** Markdown Skill artifacts, Nuwa research scripts, Node.js `node:test`, inline browser JavaScript, static HTML, Nginx, systemd, SSH/SCP.

## Global Constraints

- Keep all eight speakers: Marx, Wang Yangming, Zhuangzi, Foucault, Buffett, Lu Xun, the education researcher, and Bourdieu.
- Rename all user-visible “七人谈/七人圆桌/七位思想者” copy to the corresponding eight-person copy.
- Keep one complete topic at 50 Shixing points.
- Keep `ROUNDTABLE_SPEAK_CAP = 24`, `MAX_CONTEXT_CHARS = 8000`, and `MAX_DEBATE_ROUNDS = 2` unchanged.
- Do not modify `server.js`, `db.js`, payment configuration, model configuration, or the overall visual language.
- Never use Zhihu, WeChat Official Account articles, Baidu Baike, Baidu Zhidao, or unattributable quote collections as research evidence.
- Distinguish Bourdieu's own words, external interpretation, and researcher inference in every research file.
- Do not fabricate Bourdieu quotations; roundtable output is a framework-based simulation, not historical speech.
- Preserve all unrelated local changes in the dirty worktree.
- Do not deploy before the Nuwa research, synthesis, validation, and user review gates pass.

---

### Task 1: Create the self-contained Nuwa Skill workspace

**Files:**
- Create: `/Users/llin/Desktop/.agents/skills/bourdieu-perspective/scripts/download_subtitles.sh`
- Create: `/Users/llin/Desktop/.agents/skills/bourdieu-perspective/scripts/srt_to_transcript.py`
- Create: `/Users/llin/Desktop/.agents/skills/bourdieu-perspective/scripts/merge_research.py`
- Create: `/Users/llin/Desktop/.agents/skills/bourdieu-perspective/scripts/quality_check.py`
- Create directories: `/Users/llin/Desktop/.agents/skills/bourdieu-perspective/references/research/`
- Create directories: `/Users/llin/Desktop/.agents/skills/bourdieu-perspective/references/sources/{books,transcripts,articles}/`

**Interfaces:**
- Consumes: Nuwa scripts under `/Users/llin/Desktop/.agents/skills/huashu-nuwa/scripts/`.
- Produces: A self-contained Skill directory that Tasks 2-4 populate and validate.

- [ ] **Step 1: Create the directory tree**

```bash
mkdir -p /Users/llin/Desktop/.agents/skills/bourdieu-perspective/scripts
mkdir -p /Users/llin/Desktop/.agents/skills/bourdieu-perspective/references/research
mkdir -p /Users/llin/Desktop/.agents/skills/bourdieu-perspective/references/sources/books
mkdir -p /Users/llin/Desktop/.agents/skills/bourdieu-perspective/references/sources/transcripts
mkdir -p /Users/llin/Desktop/.agents/skills/bourdieu-perspective/references/sources/articles
```

- [ ] **Step 2: Reuse the Nuwa helper scripts unchanged**

```bash
cp /Users/llin/Desktop/.agents/skills/huashu-nuwa/scripts/download_subtitles.sh /Users/llin/Desktop/.agents/skills/bourdieu-perspective/scripts/
cp /Users/llin/Desktop/.agents/skills/huashu-nuwa/scripts/srt_to_transcript.py /Users/llin/Desktop/.agents/skills/bourdieu-perspective/scripts/
cp /Users/llin/Desktop/.agents/skills/huashu-nuwa/scripts/merge_research.py /Users/llin/Desktop/.agents/skills/bourdieu-perspective/scripts/
cp /Users/llin/Desktop/.agents/skills/huashu-nuwa/scripts/quality_check.py /Users/llin/Desktop/.agents/skills/bourdieu-perspective/scripts/
chmod +x /Users/llin/Desktop/.agents/skills/bourdieu-perspective/scripts/download_subtitles.sh
```

- [ ] **Step 3: Verify the scaffold and script hashes**

Run:

```bash
find /Users/llin/Desktop/.agents/skills/bourdieu-perspective -maxdepth 4 -type d -o -type f | sort
shasum -a 256 /Users/llin/Desktop/.agents/skills/huashu-nuwa/scripts/* /Users/llin/Desktop/.agents/skills/bourdieu-perspective/scripts/*
```

Expected: all five required directories and four scripts exist; each copied script hash matches its Nuwa source.

---

### Task 2: Complete six-dimensional primary-source research

**Files:**
- Create: `/Users/llin/Desktop/.agents/skills/bourdieu-perspective/references/research/01-writings.md`
- Create: `/Users/llin/Desktop/.agents/skills/bourdieu-perspective/references/research/02-conversations.md`
- Create: `/Users/llin/Desktop/.agents/skills/bourdieu-perspective/references/research/03-expression-dna.md`
- Create: `/Users/llin/Desktop/.agents/skills/bourdieu-perspective/references/research/04-external-views.md`
- Create: `/Users/llin/Desktop/.agents/skills/bourdieu-perspective/references/research/05-decisions.md`
- Create: `/Users/llin/Desktop/.agents/skills/bourdieu-perspective/references/research/06-timeline.md`
- Create: `/Users/llin/Desktop/.agents/skills/bourdieu-perspective/references/research/review-summary.md`

**Interfaces:**
- Consumes: Internet search and page-reading tools; Nuwa source policy; no local Bourdieu corpus was supplied by the user.
- Produces: Six independently sourced research files plus a machine-generated review summary for the Phase 1.5 user gate.

- [ ] **Step 1: Dispatch six independent research workers in parallel**

Use one worker per exact scope:

```text
01-writings: Map Bourdieu's books, papers, recurring concepts, and changes across Algeria, practice theory, education/culture, academia, public intervention, and reflexive sociology. Prioritize original texts and stable scholarly editions.

02-conversations: Find long interviews, lectures, documentary transcripts, and question-and-answer material. Extract how he responds under challenge, defines terms orally, changes level of abstraction, refuses premises, and qualifies certainty.

03-expression-dna: Sample at least 20 attributable primary-source paragraphs across books, lectures, and interviews. Measure sentence length, question ratio, analogy density, first-person usage, certainty markers, transitions, jargon introduction, and recurring relational formulations.

04-external-views: Collect serious scholarly interpretation and criticism, including sympathetic and adversarial readings. Cover determinism/reproduction, concept elasticity, class/gender/race limits, reflexivity, prose difficulty, and comparison with Marx, Weber, Durkheim, Foucault, and Lahire.

05-decisions: Reconstruct consequential intellectual and public choices: Algerian fieldwork, break with structuralism, founding Actes de la recherche en sciences sociales, Collège de France work, collective research practice, 1995 public intervention, Raisons d'agir, and reflexive scrutiny of academia/media.

06-timeline: Build a dated timeline from 1930 to 2002, connecting biography, institutions, fieldwork, publications, conceptual transitions, collaborations, and public interventions. Historical materials are stable; do not invent a recent-dynamics section.
```

Every worker must use the same five section headings below. The first heading names the assigned dimension explicitly, such as `# Writings and systematic work` or `# Long conversations and lectures`.

```markdown
## Source register
| ID | Type | Primary/secondary | Citation | URL | Accessed | Confidence |

## Attributable findings
Each finding cites source IDs and labels it as “Bourdieu”, “external view”, or “inference”.

## Contradictions and uncertainty
Retain unresolved conflicts and explain what evidence would resolve them.

## Candidate implications
List possible models or style rules without treating them as final synthesis.
```

- [ ] **Step 2: Enforce the minimum evidence mix**

Run:

```bash
rg -n "Primary|一手|Bourdieu|布尔迪厄|https?://" /Users/llin/Desktop/.agents/skills/bourdieu-perspective/references/research/0*.md
rg -n "知乎|weixin\.qq\.com|百度百科|baike\.baidu|百度知道" /Users/llin/Desktop/.agents/skills/bourdieu-perspective/references/research/0*.md
```

Expected: each file has attributable URLs and explicit source types; the blacklist scan returns no evidence entries.

- [ ] **Step 3: Generate the Nuwa Phase 1.5 summary**

Run:

```bash
python3 /Users/llin/Desktop/.agents/skills/bourdieu-perspective/scripts/merge_research.py /Users/llin/Desktop/.agents/skills/bourdieu-perspective
```

Expected: stdout reports all six files, source counts, primary/secondary balance, key findings, contradictions, and missing dimensions. Use `apply_patch` to create `review-summary.md` with that exact output and no additional claims.

- [ ] **Step 4: Stop for the Nuwa Phase 1.5 user review gate**

Present the source-count table, one key finding per dimension, contradictions, weak dimensions, and blacklisted-source scan result. Do not begin synthesis until the user approves or requests supplementary research.

---

### Task 3: Synthesize Bourdieu's operational thinking framework

**Files:**
- Create: `/Users/llin/Desktop/.agents/skills/bourdieu-perspective/references/synthesis.md`
- Create: `/Users/llin/Desktop/.agents/skills/bourdieu-perspective/references/roundtable-prompt.md`

**Interfaces:**
- Consumes: the six approved research files and `/Users/llin/Desktop/.agents/skills/huashu-nuwa/references/extraction-framework.md`.
- Produces: the exact model set and the reviewed roundtable prompt consumed by Tasks 4 and 6.

- [ ] **Step 1: Build a candidate-model evidence matrix**

For every candidate, create a named subsection and record five labeled fields: cross-domain evidence with at least two source-ID-backed domains; one new-question generative test; an exclusivity test explaining what is distinctly Bourdieusian; one classification chosen from core model, decision heuristic, or reject; and a concrete failure condition.

Evaluate habitus, field, capital conversion, reproduction, symbolic violence/misrecognition, distinction, strategy without a strategist, and reflexive sociology. Keep only 3-7 candidates that pass all three core-model tests.

- [ ] **Step 2: Extract operational rules and tensions**

Add to `references/synthesis.md`:

```markdown
## Decision heuristics
5-10 “if X, inspect Y” rules, each with a source-backed case.

## Expression DNA
Measured sentence/style findings converted into executable response rules.

## Core tensions
At least two unresolved tensions, including structure/reproduction versus change and scientific autonomy versus public intervention.

## Honest boundaries
At least three specific limits, including deterministic readings, abstraction/jargon, and context limits across gender/race/colonial settings where the evidence warrants them.
```

- [ ] **Step 3: Write the exact roundtable projection**

`references/roundtable-prompt.md` must be a complete prompt ready to paste inside a JavaScript template literal. It must contain identity, speech style, 4-6 validated lenses, interactions with Marx/Foucault/the education researcher, honest boundaries, mention rules, and the existing 200-350 Chinese-character target. It must not contain Markdown fences, backticks, fabricated quotations, or source footnotes.

- [ ] **Step 4: Stop for the Nuwa Phase 2.5 user review gate**

Present the final model names, heuristic count, three expression traits, at least two tensions, honest boundaries, and the complete short roundtable projection. Do not build `SKILL.md` until the user approves.

---

### Task 4: Build, validate, and refine the Bourdieu Skill

**Files:**
- Create: `/Users/llin/Desktop/.agents/skills/bourdieu-perspective/SKILL.md`
- Create: `/Users/llin/Desktop/.agents/skills/bourdieu-perspective/references/validation.md`
- Create: `/Users/llin/Desktop/.agents/skills/bourdieu-perspective/references/refinement.md`

**Interfaces:**
- Consumes: approved `references/synthesis.md`, `references/roundtable-prompt.md`, the six research files, and the Nuwa Skill template.
- Produces: the final reusable Skill and validation evidence; Task 6 consumes the unchanged approved roundtable prompt.

- [ ] **Step 1: Build `SKILL.md` from the Nuwa template**

Include frontmatter triggers in Chinese and English, one-time simulation disclaimer, exit-role behavior, historical identity card, 3-7 models, 5-10 heuristics, expression DNA, timeline, values and anti-patterns, intellectual genealogy, source register, and at least three honest boundaries. Replace the template's living-person “latest dynamics” field with a clearly dated “思想定稿与身后影响边界” section.

- [ ] **Step 2: Add the Bourdieu-specific Agentic Protocol**

The protocol must classify factual/framework/mixed questions, require current research for factual questions, and route research through these dimensions:

```text
1. Field and positions: actors, stakes, entry rules, dominant/dominated positions.
2. Capital structure: economic, cultural, social, and symbolic capital; conversion rates and barriers.
3. Habitus and trajectories: embodied dispositions, family/school history, plausible versus unthinkable choices.
4. Classification and misrecognition: who defines legitimate taste, merit, expertise, and neutrality.
5. Reflexive check: the analyst's own institutional position, categories, incentives, and blind spots.
```

- [ ] **Step 3: Run the automated Nuwa quality check**

Run:

```bash
python3 /Users/llin/Desktop/.agents/skills/bourdieu-perspective/scripts/quality_check.py /Users/llin/Desktop/.agents/skills/bourdieu-perspective/SKILL.md
```

Expected: PASS for 3-7 models, model limits, expression DNA, honest boundaries, internal tensions, and primary-source ratio above 50%.

- [ ] **Step 4: Run three independent validation classes**

Record inputs, outputs, source comparison, and verdicts in `references/validation.md`:

```text
Known-position tests:
- Why do formally equal schools reproduce unequal outcomes?
- Is taste merely personal preference?
- Why must sociology analyze the sociologist?

Edge test:
- How might Bourdieu analyze algorithmic recommendation in education while clearly marking inference?

Voice test:
- Analyze “努力就一定能改变命运” in 100-180 Chinese characters without generic AI encouragement or quotation collage.
```

Expected: known tests align with primary evidence, the edge test marks inference and uncertainty, and the voice test is recognizable through relational analysis rather than jargon density.

- [ ] **Step 5: Run the Nuwa dual-review refinement**

One reviewer evaluates workflow clarity, boundaries, checkpoints, and dry runs. A second reviewer evaluates triggers, role rules, routing, failure prevention, and missing information. Apply non-conflicting improvements and record the before/after text and reasons in `references/refinement.md`.

- [ ] **Step 6: Stop for the final Nuwa validation gate**

Show the quality-check result, known/edge/voice verdicts, and refinement summary. Do not modify the product page until the user approves the finished Skill and roundtable projection.

---

### Task 5: Write and verify failing roundtable page tests

**Files:**
- Create: `tests/roundtable-page.test.js`
- Test: `tests/roundtable-page.test.js`

**Interfaces:**
- Consumes: the approved product design and the helper API specified below.
- Produces: failing tests that define the exact eight-person and mention-routing contract for Task 6.

- [ ] **Step 1: Create the test file with the expected public contract**

```javascript
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const file = path.join(__dirname, '..', 'public', 'roundtable', 'index.html');
const html = fs.readFileSync(file, 'utf8');

function inlineScript() {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1].trim())
    .find(source => source.includes('const CHARACTERS ='));
}

function characterRuntime() {
  const source = inlineScript();
  const start = source.indexOf('const CHARACTERS =');
  const end = source.indexOf('// ═══════ 状态管理');
  const isolated = source.slice(start, end) +
    '\nthis.runtime = { CHARACTERS, mentionRegex, mentionTargetId };';
  const context = {};
  vm.runInNewContext(isolated, context);
  return context.runtime;
}

test('roundtable presents eight thinkers including Bourdieu', () => {
  assert.match(html, /思想圆桌 · 八人谈/);
  assert.match(html, /八人圆桌 · 跨时空对话/);
  assert.match(html, /八位思想者已就座/);
  assert.doesNotMatch(html, /七人谈|七人圆桌|七位思想者/);
  assert.equal((html.match(/class="char-card"/g) || []).length, 8);
  assert.match(html, /data-id="bourdieu"/);
  assert.match(html, /data-at="bourdieu"/);
});

test('character runtime exposes eight stable ids and Bourdieu aliases', () => {
  const { CHARACTERS } = characterRuntime();
  assert.deepEqual(
    Object.keys(CHARACTERS),
    ['marx', 'wangyangming', 'zhuangzi', 'foucault', 'buffett', 'luxun', 'edu', 'bourdieu']
  );
  assert.equal(CHARACTERS.bourdieu.name, '皮埃尔·布尔迪厄');
  assert.ok(CHARACTERS.bourdieu.prompt.includes('场域'));
  assert.ok(CHARACTERS.bourdieu.prompt.includes('反思'));
});

test('dynamic mentions resolve full names and aliases for old and new thinkers', () => {
  const { mentionRegex, mentionTargetId } = characterRuntime();
  assert.equal(mentionTargetId('马克思'), 'marx');
  assert.equal(mentionTargetId('米歇尔·福柯'), 'foucault');
  assert.equal(mentionTargetId('巴菲特'), 'buffett');
  assert.equal(mentionTargetId('布尔迪厄'), 'bourdieu');
  assert.equal(mentionTargetId('皮埃尔·布尔迪厄'), 'bourdieu');
  const labels = [...'@马克思 @米歇尔·福柯 @布尔迪厄 @所有人'.matchAll(mentionRegex())]
    .map(match => match[1]);
  assert.deepEqual(labels, ['马克思', '米歇尔·福柯', '布尔迪厄', '所有人']);
});

test('roundtable inline scripts remain syntactically valid', () => {
  for (const [index, source] of [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].entries()) {
    new vm.Script(source[1], { filename: `public/roundtable/index.html#script-${index}` });
  }
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test tests/roundtable-page.test.js
```

Expected: FAIL because the page still says seven people, lacks `bourdieu`, and does not define `mentionRegex` or `mentionTargetId`. Syntax compilation should remain green.

- [ ] **Step 3: Confirm the failure is feature absence, not a test error**

Inspect the failure list. Fix only test extraction mistakes; re-run until the failures specifically name seven-person copy, missing Bourdieu, or missing mention helpers.

- [ ] **Step 4: Commit the red test**

```bash
git add tests/roundtable-page.test.js
git commit -m "test: define Bourdieu roundtable contract"
```

---

### Task 6: Implement the eighth speaker and dynamic mention routing

**Files:**
- Modify: `public/roundtable/index.html`
- Test: `tests/roundtable-page.test.js`

**Interfaces:**
- Consumes: approved `/Users/llin/Desktop/.agents/skills/bourdieu-perspective/references/roundtable-prompt.md` and Task 5's `mentionRegex(): RegExp` / `mentionTargetId(label: string): string | null` contract.
- Produces: an eight-person static roundtable page with dynamic full-name and alias mention routing.

- [ ] **Step 1: Change product copy and add the eighth controls**

Update the meta description, `<title>`, hidden heading, header, empty state, and payment description to eight-person wording. Add a `data-id="bourdieu"` sidebar card and a `data-at="bourdieu"` chip after the education researcher, using avatar `布` and color `#a43f5f`.

- [ ] **Step 2: Add aliases and the Bourdieu character config**

Add `aliases` arrays to all eight `CHARACTERS` entries using this exact mapping:

| ID | `name` | `aliases` |
|---|---|---|
| `marx` | `卡尔·马克思` | `['马克思']` |
| `wangyangming` | `王阳明` | `[]` |
| `zhuangzi` | `庄子` | `[]` |
| `foucault` | `米歇尔·福柯` | `['福柯']` |
| `buffett` | `沃伦·巴菲特` | `['巴菲特']` |
| `luxun` | `鲁迅` | `[]` |
| `edu` | `教育研究者` | `['当代教育研究者']` |
| `bourdieu` | `皮埃尔·布尔迪厄` | `['布尔迪厄']` |

Paste the complete approved `roundtable-prompt.md` as `CHARACTERS.bourdieu.prompt` without adding claims or quotations.

- [ ] **Step 3: Implement pure dynamic mention helpers before the state marker**

```javascript
function escapeMentionText(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionEntries() {
  const entries = [];
  for (const [id, character] of Object.entries(CHARACTERS)) {
    const labels = [character.name, ...(character.aliases || [])];
    for (const label of new Set(labels.filter(Boolean))) entries.push({ id, label });
  }
  return entries.sort((a, b) => b.label.length - a.label.length);
}

function mentionRegex() {
  const labels = mentionEntries().map(entry => escapeMentionText(entry.label));
  return new RegExp('@(' + [...labels, '所有人'].join('|') + ')', 'g');
}

function mentionTargetId(label) {
  const entry = mentionEntries().find(item => item.label === label);
  return entry ? entry.id : null;
}
```

- [ ] **Step 4: Replace both hard-coded mention regular expressions**

In `collectMentions`, use `const re = mentionRegex()` and `mentionTargetId(mm[1])`. In `formatReply`, use `mentionRegex()` for highlighting. Preserve the existing `@所有人` branch and self-mention exclusion.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
node --test tests/roundtable-page.test.js
node --test tests/shixing-points-pages.test.js tests/platform-shell.test.js
```

Expected: all focused tests pass with no syntax errors.

- [ ] **Step 6: Commit the implementation**

```bash
git add public/roundtable/index.html tests/roundtable-page.test.js
git commit -m "feat: add Bourdieu to thought roundtable"
```

---

### Task 7: Run full regression and responsive acceptance

**Files:**
- Verify: `public/roundtable/index.html`
- Verify: all `tests/*.test.js`

**Interfaces:**
- Consumes: Task 6 implementation.
- Produces: local release evidence and a release-candidate SHA-256 for deployment.

- [ ] **Step 1: Run syntax and complete automated regression**

Run:

```bash
node --check server.js
node --test tests/*.test.js
git diff --check
```

Expected: syntax exit 0, complete suite 0 failures, diff check empty.

- [ ] **Step 2: Verify desktop layout at 1440x900**

Serve `public/` locally, open `/roundtable/`, and inspect the eighth sidebar card, header, message area, selection bar, and input area. Confirm no overlap, clipping, or unintended page-width overflow; capture a screenshot.

- [ ] **Step 3: Verify narrow layout at 390x844**

Open the same page at 390x844. Expand and collapse the thinker list, horizontally inspect the selection chips, and verify `document.documentElement.scrollWidth === document.documentElement.clientWidth`. Confirm all eight cards are reachable by scrolling and the input remains usable; capture a screenshot.

- [ ] **Step 4: Record the release hash**

Run:

```bash
shasum -a 256 public/roundtable/index.html
```

Save the hash in the deployment notes used by Task 8.

---

### Task 8: Back up, deploy, verify, and log the release

**Files:**
- Deploy: `public/roundtable/index.html` to `/home/admin/classroom-broadcast/public/roundtable/index.html`
- Modify: `/Users/llin/Library/Mobile Documents/iCloud~md~obsidian/Documents/ht/开发日志/2026-06-29 思想圆桌.md`

**Interfaces:**
- Consumes: Task 7 release hash and green regression evidence.
- Produces: production eight-person roundtable, rollback artifact, cross-product evidence, and append-only project history.

- [ ] **Step 1: Reconfirm the production baseline before overwrite**

Run:

```bash
ssh -i /Users/llin/.ssh/yingyuzuowen_server -o IdentitiesOnly=yes root@120.79.245.205 'sha256sum /home/admin/classroom-broadcast/public/roundtable/index.html'
```

Expected before first deployment: `0d3f2b488b312320d23065751ba66b166b26f5b2fb901b8591367b4c007af3ee`. If it differs, stop, download the live file, and reconcile instead of overwriting concurrent work.

- [ ] **Step 2: Create a timestamped production backup**

On the server, set a task-specific timestamp with `roundtable_release_stamp=$(date +%Y%m%d-%H%M%S)`, create `/home/admin/classroom-broadcast/backups/roundtable-bourdieu-${roundtable_release_stamp}/`, and copy the live `index.html` into it before upload. Print and record the resolved directory in the development log.

- [ ] **Step 3: Upload only the static page and compare hashes**

```bash
scp -i /Users/llin/.ssh/yingyuzuowen_server -o IdentitiesOnly=yes public/roundtable/index.html root@120.79.245.205:/home/admin/classroom-broadcast/public/roundtable/index.html
shasum -a 256 public/roundtable/index.html
ssh -i /Users/llin/.ssh/yingyuzuowen_server -o IdentitiesOnly=yes root@120.79.245.205 'sha256sum /home/admin/classroom-broadcast/public/roundtable/index.html'
```

Expected: local and remote hashes are identical. Do not restart `classroom-broadcast` for this static upload.

- [ ] **Step 4: Verify the live product and shared-service family**

Strict HTTPS checks must return 200 for:

```text
https://notice.yingyuzuowen.asia/roundtable/
https://notice.yingyuzuowen.asia/
https://comment.yingyuzuowen.asia/
https://zuowen.yingyuzuowen.asia/
https://xiezuo.yingyuzuowen.asia/
https://shixing.yingyuzuowen.asia/
```

Confirm live source contains “思想圆桌 · 八人谈”, `data-id="bourdieu"`, `mentionRegex`, and no user-visible seven-person copy. Confirm `classroom-broadcast` remains active.

- [ ] **Step 5: Append and reread the project development log**

Append a dated section covering changed modules, user-visible eight-person behavior, Nuwa research and validation, automated and responsive tests, backup path, static deployment/no restart, production hash, cross-product HTTPS results, remaining latency/cost risk, and the next observation step. Mark no unimplemented item as complete. Update the log frontmatter `updated` date to `2026-08-14`, then reread the appended section.

- [ ] **Step 6: Final evidence gate**

Freshly rerun the focused test, full suite, live HTTPS check, live source markers, remote hash, timer-independent service status, and log tail before claiming completion.
