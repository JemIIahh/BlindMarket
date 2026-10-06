# BlindMarket docs: style and quality bar

These rules apply to every page in `docs-site/`. This file isn't published (see `.mintignore`).

The bar is the best developer documentation in the industry: Stripe, Cloudflare, Vercel, Anthropic. Those docs share four traits:

1. **The reader always knows what kind of page they're on.**
2. **Every claim is true today.**
3. **Every code sample runs.**
4. **Depth is there for whoever needs it, without burying whoever doesn't.**

## 1. Four kinds of page (Diátaxis)

Every page is exactly one of these. Don't mix them.

| Kind | Reader's state | Must have | Must not have |
|---|---|---|---|
| **Tutorial** (quickstarts) | New. Learning by doing. | One path from zero to a visible result. Every command and every line of code. Prerequisites up front, expected output after each step, and next steps at the end. | Alternatives, options tables, theory. Link out instead. |
| **How-to guide** | Knows the basics, has a goal. | The steps for one job, plus the options that matter for it, edge cases, and what to do when it fails. | Teaching concepts from scratch. Link to the concept page. |
| **Reference** | Looking something up. | Complete, uniform, and scannable: every method, flag, tool, field, and error code, each with type, default, and behaviour. | Narrative and opinions. |
| **Explanation** (concepts) | Wants to understand why and how. | The model, mechanism, trade-offs, diagrams, and limits, stated honestly. | Step-by-step instructions. |

## 2. Truth rules (non-negotiable)

- **Verify every fact before you write it.** That covers numbers, addresses, limits, defaults, labels, commands, fields, and error codes.
  - Sources, in order of authority: the live system, then the code, then the published packages. `.md` files are not sources.
  - The checks are listed under "Docs go stale" in the root `CLAUDE.md`.
- **Document what users install.** That means the published npm versions:
  - `@blindmarket/sdk` 0.9.0
  - `@blindmarket/cli` 0.6.0
  - `@blindmarket/mcp-server` 0.7.0

  Don't document unreleased behaviour that exists only in `sdk/src` or `cli/src`. If source and the published package differ, the published package wins.
- **Leave a source note for maintainers** at the end of each factual section. Use an MDX comment, which is not rendered:
  `{/* source: contracts/contracts/BlindEscrow.sol:718-760; live read 2026-10-06 */}`
- **Be honest about limits.** Say what BlindMarket can see, what isn't built, and what can fail. Never market.
- **Put values that change behind "check live".** Fees, deploy fee, and posting chain are examples. Give today's value, and show how to read the current one (an endpoint or a contract call).

## 3. Voice

- **Second person, present tense, active voice.** "You post a task." Not "Tasks can be posted."
- **Short declarative sentences.** One idea per paragraph. No hype ("seamless", "powerful", "simply", "just", "blazing").
- **Statement headings.** For example "Refunds go to the funding wallet". Concept pages can use plain noun headings ("Key custody").
- **Define a term the first time it appears,** and use the glossary term every time after.

### Terms

| Use | Not |
|---|---|
| poster | buyer, client, requester |
| agent: anything that takes and does tasks | worker or executor, except when naming an API field such as `targetExecutor` |
| hosted agent: runs on BlindMarket | platform agent |
| self-run worker: your code, your machine | local worker |
| remote MCP endpoint: `api.blindmarket.xyz/mcp` | hosted MCP |
| MCP server package: `@blindmarket/mcp-server`, runs inside your MCP client and talks to the production API | local MCP server |
| private task / public task | blind task, encrypted task |
| brief | prompt, description, instructions (except the `instructions` field) |
| result | evidence, deliverable (except field names) |
| reward | bounty, price (price only for services) |

## 4. Page anatomy

- **Frontmatter:** `title` (sentence case), `description` (one sentence, what the reader gets), and `sidebarTitle` if the title is long.
- **First paragraph:** what this page lets you do, or what it explains, in at most two sentences.
- **Tutorials and how-tos:**
  - a **Before you begin** section (accounts, keys, balances, versions);
  - then `<Steps>`;
  - then a **Troubleshooting** section (an `<AccordionGroup>` of real failure messages);
  - then **Next steps** (a `<CardGroup>`).
- **Concepts:** an overview, a diagram (Mermaid) where a picture explains the mechanism, then the sections, then a **Limits and trade-offs** section.
- **Reference:** a uniform entry per item: signature, `<ParamField>` / `<ResponseField>` with types and defaults, behaviour, errors, and an example.

## 5. Code

- **Complete and runnable:** imports, env vars, and real package names. Never `...` inside code that the reader runs.
- **Title every block** with its language and filename, for example ```` ```ts post-task.ts ````.
  - Use `<CodeGroup>` when the same thing works in several clients (SDK, CLI, MCP, curl).
- **Type-check every TypeScript sample** against the published SDK before committing (`tsc --noEmit` against `@blindmarket/sdk@0.9.0`).
  - Read-only samples against the production API may be executed: GET calls only.
  - Never spend real money to test a sample.
- **Show expected output** for commands and calls when it helps the reader confirm success.
- **Amounts:** always state the unit. Show both forms when relevant: `2.5` USDC = `2500000` raw (6 decimals).
- **Secrets:** use placeholders like `sk_...` and `0x...`. Never real keys.

## 6. Components (Mintlify)

| Component | Use it for |
|---|---|
| `<Steps>` / `<Step>` | Procedures |
| `<Tabs>` / `<CodeGroup>` | The same operation across clients or languages |
| `<ParamField>`, `<ResponseField>`, `<Expandable>` | Reference fields |
| `<AccordionGroup>` | Troubleshooting and FAQ |
| `<Note>` / `<Tip>` / `<Warning>` / `<Info>` | Callouts. Use `<Warning>` only where money or secrets are at risk. |
| `<CardGroup>` | Next steps and choosing between options |
| Mermaid code blocks | State machines, sequence diagrams, architecture |

**Tables:**
- Two or three columns, with short cells. A table must never scroll sideways.
- If you need four or more columns, use cards, accordions, or separate tables.
- The theme sets a 150 px minimum width per cell. `style.css` removes that, so three-column tables fit a phone. Don't delete that rule.

## 7. Done means

- `npx mint validate` and `npx mint broken-links` pass.
- Every TypeScript sample type-checks.
- Every fact has a source note.
- The page reads correctly on a 390 px wide screen.
