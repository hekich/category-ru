# category-ru rules for sing-box and Mihomo

To install dependencies:

```bash
bun install
```

Manage source URLs in `category-ru.config.json`:

```json
{
  "sourceUrls": [
  "https://raw.githubusercontent.com/hydraponique/roscomvpn-geosite/master/data/category-ru",
  "https://raw.githubusercontent.com/hydraponique/roscomvpn-geosite/master/data/whitelist",
  "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/category-ru.list",
  "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/geosite/category-gov-ru.list",
  "https://raw.githubusercontent.com/itdoginfo/allow-domains/main/Russia/outside-raw.lst",
  "https://raw.githubusercontent.com/runetfreedom/russia-domains-list/main/ru-available-only-inside"
  ]
}
```

Then build the readable rule-set artifacts with:

```bash
bun run rule-set:generate
bun run rule-set:format
bun run rule-set:check
```

This writes:

- `rules/sing-box/category-ru.json` for sing-box
- `rules/mihomo/category-ru.lst` for Mihomo rule providers with `format: text` and `behavior: domain`

To compile that JSON rule-set to sing-box's binary `.srs` format:

```bash
sing-box rule-set compile --output rules/sing-box/category-ru.srs rules/sing-box/category-ru.json
```

To compile the Mihomo text rule-set to Mihomo's binary `.mrs` format:

```bash
mihomo convert-ruleset domain text rules/mihomo/category-ru.lst rules/mihomo/category-ru.mrs
```

You can still override the config from the CLI when needed:

```bash
bun run ./src/index.ts --url https://example.com/list-1 --url https://example.com/list-2 --output output/sing-box/category-ru.json --mihomo-output output/mihomo/category-ru.lst
```

The converter:

- fetches one or more remote domain lists
- parses common geosite-style entries such as `domain:`, `full:`, `keyword:`, and `regexp:`
- parses Mihomo-style `.list` entries such as bare exact domains, `+.example.com`, and `DOMAIN-SUFFIX,example.com`
- accepts bare domain lines like `example.com` or `*.example.com`
- removes exact duplicates and drops domains or narrower suffixes already covered by a broader `domain_suffix`
- writes the generated sing-box rule-set JSON to `--output`
- can also write Mihomo domain text `.lst` output for `format: text`, `behavior: domain`
- rejects Mihomo text output when parsed rules include keyword or regex entries, because Mihomo domain text cannot represent them
- loads default source URLs from `category-ru.config.json`
- prints duplicate and unsupported-line summaries to the console

Automation:

- `.github/workflows/update-rule-set.yml` runs every day at `00:00` UTC and can also be started manually with `workflow_dispatch`
- the workflow regenerates sing-box JSON and `.srs` artifacts at `rules/sing-box/category-ru.*`
- Mihomo `.lst` and `.mrs` artifacts are updated with the same source snapshot as sing-box; Mihomo generation or compile failures stop the workflow before any mixed artifact commit

Run the full verification suite with:

```bash
bun run check
```
