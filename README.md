# category-ru rules for sing-box

To install dependencies:

```bash
bun install
```

Manage source URLs in `category-ru.config.json`:

```json
{
  "sourceUrls": [
    "https://raw.githubusercontent.com/hydraponique/roscomvpn-geosite/master/data/category-ru",
    "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/category-ru.list",
    ...more
  ]
}
```

Then build the sing-box rule-set JSON with:

```bash
bun run ./src/index.ts --output rules/category-ru.json
```

To compile that JSON rule-set to sing-box's binary `.srs` format:

```bash
sing-box rule-set compile --output rules/category-ru.srs rules/category-ru.json
```

You can still override the config from the CLI when needed:

```bash
bun run ./src/index.ts --url https://example.com/list-1 --url https://example.com/list-2 --output output/category-ru.json
```

The converter:

- fetches one or more remote domain lists
- parses common geosite-style entries such as `domain:`, `full:`, `keyword:`, and `regexp:`
- parses Mihomo-style `.list` entries such as bare exact domains, `+.example.com`, and `DOMAIN-SUFFIX,example.com`
- accepts bare domain lines like `example.com` or `*.example.com`
- removes exact duplicates and drops domains or narrower suffixes already covered by a broader `domain_suffix`
- writes the generated rule-set JSON under `rules/` by default
- loads default source URLs from `category-ru.config.json`
- prints duplicate and unsupported-line summaries to the console

Automation:

- `.github/workflows/update-rule-set.yml` runs every day at `00:00` UTC and can also be started manually with `workflow_dispatch`
- the workflow regenerates `rules/category-ru.json`, compiles `rules/category-ru.srs`, and commits the updated files back to the repository

Run the full verification suite with:

```bash
bun run check
```
