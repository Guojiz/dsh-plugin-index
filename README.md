# DSH Plugin Index

A public, large-scale [plugin index](https://github.com/deepseek-ai/deepseek-harness) (format 1) for
DeepSeek Harness (DSH): every npm package that publishes a `dsh.bundle` manifest, rebuilt straight
from the registry by `.github/workflows/refresh.yml`.

| | |
|---|---|
| **Index URL** | `https://raw.githubusercontent.com/Guojiz/dsh-plugin-index/main/index.json` |
| **Mirror (Pages)** | `https://guojiz.github.io/dsh-plugin-index/index.json` |
| **Plugins** | 2488 |
| **Versions** | 22401 |
| **Official (`@deepseek-ai/`)** | 27 |
| **Community** | 2461 |
| **Bundles skipped** | 559 candidate packages without a `dsh.bundle` field |
| **Refresh** | daily 03:17 UTC, plus on demand via `workflow_dispatch` |

The index lists npm-sourced versions only, so it works for anyone who can reach npm (or a mirror of it):
every version carries `{"type": "npm"}` with no `registry` pin, which means the installing client's own
registry is used.

Both URLs were verified on 2026-11-15: HTTP 200, **zero redirects** (the market rejects redirects), and
the served document passes `parseMarketIndex` as a format-1 index. The `refresh index` workflow also
runs green on GitHub-hosted `ubuntu-latest` with the validator installed from npm.

## Use it in DSH

1. Install the plugin-market bundle into the profile you want discovery in:

   ```
   plugin_manager(action: "install_bundle",
                  target: "@deepseek-ai/dsh-experimental-plugin-market-bundle@0.2.2-rc.3")
   ```

2. Add the index URL — Settings → Discover, the `pluginMarket.setIndexes([...])` remote, or the
   `plugin-market` row's `indexes` in the profile's `cordis.patch.yml`. **Use the exact URL above**:
   the market rejects redirects, so a URL that browser-redirects to a canonical form will not load.

3. Browse it: the Discover tab, or the read-only agent tool

   ```
   plugin_market(index: "https://raw.githubusercontent.com/Guojiz/dsh-plugin-index/main/index.json",
                 query: "terminal", sort: "published")
   ```

   Each returned version carries the exact `install` spec and optional `registry` to hand to
   `plugin_manager install_bundle`.

## What gets listed

- Candidates come from nine registry searches (`@deepseek-ai/dsh`, `dsh-bundle`, `dsh-plugin`,
  `deepseek-harness`, `keywords:dsh*`, …), deduplicated.
- A candidate becomes an entry only if at least one published version carries `dsh.bundle`; unrelated
  npm packages that merely mention "dsh" are dropped (`559` in the last build).
- Per plugin: name, derived title, description, author, homepage, repository (+ directory), and every
  bundle version in descending SemVer order, capped at 12 per plugin.
- `metadata.category` is `core` for the profile bundles (`dsh-base`, `dsh-web-app`, `dsh-headless`,
  `dsh-acp-app`, `dsh-sdk-app`, `dsh-sdk-minimal`), `experimental` for anything whose name says so, and
  `extension` otherwise. Labels: `official` (`@deepseek-ai/` scope), `experimental`, `opt-in`
  (`dsh.bundle.listedByDefault === false`), `platform-specific` (`dsh.bundle.platforms` present).
- `sortKeys.publishedTimestamp` lets the Discover tab sort by recency.

## Build locally

```bash
npm install
node build-index.mjs --out index.json --max-versions 12
# PASS  index.json  6150647 bytes
#       2488 plugin(s), 22401 version(s); skipped 559 non-bundle, 0 without publish time
```

The builder validates its own output with `parseMarketIndex` from
`@deepseek-ai/dsh-plugin-market-index` — the same validator DSH runs when it reads an index — so a
build that would be rejected by the Discover tab fails locally first.

Flags: `--out <path>`, `--max-versions <n>`, `--url <index url used to resolve relative icons>`,
`--mirrors <comma-separated registry bases>` (default `https://registry.npmmirror.com,https://registry.npmjs.org`;
`registry.npmjs.org` resets connections on some networks, so the mirror is tried first and failover is automatic).

## Limits worth knowing

- **Not a security review.** The index records registry declarations: names, versions, publish times.
  Nothing here says a bundle is safe. Read a plugin's source before installing it.
- **Unsigned.** Index content is a claim, not attestation; what actually installs is decided by the
  package manifest that the client downloads.
- **npm only.** Git-pinned community bundles that were never published to npm are not listed; the
  format supports them, this generator does not discover them.
- **Descriptions are third-party text.** The market truncates them to 300 characters and the
  `plugin_market` tool declares them as content, not instructions.
- **Staleness.** `cacheTtlMs` is 10 minutes in DSH; a new release appears within one refresh plus that
  cache window. Pin the Pages URL or the raw URL — both resolve without redirects.
