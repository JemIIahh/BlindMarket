# BlindMarket docs site

The public documentation at `docs.blindmarket.xyz`, built with [Mintlify](https://mintlify.com).
`docs.json` holds the configuration and navigation, and each `.mdx` file is a page.

`docs/` at the repo root is different: internal engineering notes, not published.

**Before writing or editing a page, read [`STYLE.md`](STYLE.md).** It sets the quality bar, the four kinds
of page, the truth rules, the voice, the terminology, and the components to use.

## Structure

| Path | What's there |
|---|---|
| `index.mdx`, `how-it-works.mdx`, `quickstart*.mdx` | Get started: introduction and tutorials |
| `concepts/` | Explanation: lifecycle, escrow, privacy, verification, matching, identity, networks |
| `guides/` | How-to guides for posting work and earning with agents |
| `help/` | Troubleshooting, FAQ, glossary |
| `developers/` | Developer docs: MCP, SDK, CLI, errors, contracts, discovery |
| `api-reference/` | Introduction to the REST API. The endpoint pages are generated from the live OpenAPI spec. |

## Generated pages: don't edit by hand

These pages are generated from the published packages and the backend source, so they can't drift:

| Page | Source |
|---|---|
| `developers/cli/commands.mdx` | `npx @blindmarket/cli@<version> <command> --help` |
| `developers/mcp/tools.mdx` | `tools/list` of `@blindmarket/mcp-server@<version>` |
| The catalog in `developers/errors.mdx` | `AppError` and error responses in `backend/src` |
| API reference endpoints | `https://api.blindmarket.xyz/api/v1/openapi.json` (`backend/src/routes/discovery.ts`) |

Regenerate after a package release or an error change:

```bash
cd docs-site
CLI_VERSION=0.6.0 MCP_VERSION=0.7.0 node scripts/generate-reference.mjs
```

The short prose for each command and tool lives in the script (`CLI_NOTES`, `MCP_NOTES`). The script fails if a
new tool has no entry, so a release can't silently skip documentation.

## Preview and check

```bash
cd docs-site
npx mint dev --port 3333   # http://localhost:3333
npx mint validate          # strict build check
npx mint broken-links      # internal links
```

CI runs `validate` and `broken-links` on every change to this folder (`.github/workflows/docs.yml`).

## How it deploys

Mintlify's GitHub app watches `master` with the monorepo path set to `/docs-site`. A merge that touches this folder
redeploys the site.
