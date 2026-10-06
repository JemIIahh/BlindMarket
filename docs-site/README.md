# BlindMarket docs site

The public documentation at `docs.blindmarket.xyz`, built with [Mintlify](https://mintlify.com).
This folder is the whole site: `docs.json` holds the config and navigation, and each `.mdx` file is a page.

`docs/` at the repo root is different. It holds internal engineering notes and is not published.

## Preview locally

```bash
cd docs-site
npx mint dev          # http://localhost:3000
npx mint broken-links # check internal links
```

## How it deploys

Mintlify's GitHub app watches this repo's `master` branch, with the monorepo path set to `/docs-site`.
A merge that touches this folder redeploys the site. Nothing else in the repo is built.

The API reference tab is generated from the live spec at
`https://api.blindmarket.xyz/api/v1/openapi.json` (`backend/src/routes/discovery.ts`).
A new endpoint shows up there once it is in the spec and listed under a group in `docs.json`.

## Writing rules

- **Check every fact against the code or the live system before writing it.** That covers addresses, fees,
  limits, commands, and error codes. Contract values come from `contracts/deployments/*.json` and the
  chain itself. Commands come from the published packages (`npx @blindmarket/cli --help`).
- **Write for users, not operators.** Leave out env vars, keys, and runbooks for running BlindMarket itself.
- **Plain copy.** Short declarative sentences, one idea per paragraph, and statement headings.
- **Keep the brand.** It uses the landing palette (ink `#0a0a0b` on paper `#f4f4f2`, cream `#f5efe0` in dark
  mode) and Instrument Sans. The logos in `logo/` are the app's mark with the wordmark converted to paths.
