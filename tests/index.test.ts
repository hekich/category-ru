import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	buildSingBoxRuleSet,
	convertDomainLists,
	DEFAULT_SOURCE_CONFIG_PATH,
	deriveOutputPath,
	getUsageText,
	mergeEntries,
	parseCliArgs,
	parseDomainList,
	parseSourceConfig,
	resolveSourceUrls,
	type SingBoxRuleSet,
	writeRuleSet,
} from "../src/index";

describe("CLI metadata", () => {
	test("prints usage with the actual entrypoint path", () => {
		expect(getUsageText()).toContain(
			"bun run ./src/index.ts [options] [url ...]",
		);
	});

	test("keeps package metadata aligned with the executable entrypoint", async () => {
		const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
			module?: string;
		};

		expect(packageJson.module).toBe("./src/index.ts");
		expect(await Bun.file(packageJson.module ?? "").exists()).toBe(true);
	});

	test("parses help requests without requiring sources", () => {
		expect(parseCliArgs(["--help"])).toEqual({
			helpRequested: true,
			outputPath: undefined,
			sourceUrls: [],
			version: 3,
		});
	});
});

describe("parseSourceConfig", () => {
	test("reads source URLs from config JSON", () => {
		const sourceUrls = parseSourceConfig(
			JSON.stringify({
				sourceUrls: ["https://a.test/list", " https://b.test/list "],
			}),
			DEFAULT_SOURCE_CONFIG_PATH,
		);

		expect(sourceUrls).toEqual(["https://a.test/list", "https://b.test/list"]);
	});
});

describe("deriveOutputPath", () => {
	test("writes source-derived output files into the rules directory", () => {
		const outputPath = deriveOutputPath([
			"https://example.test/lists/category-ru.list",
		]);

		expect(outputPath).toBe("rules/category-ru.list.json");
	});
});

describe("parseDomainList", () => {
	test("maps supported prefixes to sing-box rule fields", () => {
		const result = parseDomainList(
			[
				"# comment",
				"domain:Example.com",
				"full:login.example.com",
				"keyword:pay",
				"regexp:^api\\.",
			].join("\n"),
			"https://example.test/list",
		);

		expect(result.entries).toEqual([
			{
				type: "domain_suffix",
				value: "example.com",
				sourceUrl: "https://example.test/list",
				lineNumber: 2,
			},
			{
				type: "domain",
				value: "login.example.com",
				sourceUrl: "https://example.test/list",
				lineNumber: 3,
			},
			{
				type: "domain_keyword",
				value: "pay",
				sourceUrl: "https://example.test/list",
				lineNumber: 4,
			},
			{
				type: "domain_regex",
				value: "^api\\.",
				sourceUrl: "https://example.test/list",
				lineNumber: 5,
			},
		]);
		expect(result.unsupportedEntries).toEqual([]);
	});

	test("parses Mihomo list shorthand as exact domains and suffixes", () => {
		const result = parseDomainList(
			["example.com", "+.example.org", "+.ru"].join("\n"),
			"https://example.test/category-ru.list",
		);

		expect(result.entries).toEqual([
			{
				type: "domain",
				value: "example.com",
				sourceUrl: "https://example.test/category-ru.list",
				lineNumber: 1,
			},
			{
				type: "domain_suffix",
				value: "example.org",
				sourceUrl: "https://example.test/category-ru.list",
				lineNumber: 2,
			},
			{
				type: "domain_suffix",
				value: "ru",
				sourceUrl: "https://example.test/category-ru.list",
				lineNumber: 3,
			},
		]);
		expect(result.unsupportedEntries).toEqual([]);
	});

	test("parses explicit Mihomo rule prefixes", () => {
		const result = parseDomainList(
			[
				"DOMAIN,login.example.com",
				"DOMAIN-SUFFIX,.example.com",
				"DOMAIN-KEYWORD,pay",
				"DOMAIN-REGEX,^api\\.",
			].join("\n"),
			"https://example.test/provider.list",
		);

		expect(result.entries).toEqual([
			{
				type: "domain",
				value: "login.example.com",
				sourceUrl: "https://example.test/provider.list",
				lineNumber: 1,
			},
			{
				type: "domain_suffix",
				value: "example.com",
				sourceUrl: "https://example.test/provider.list",
				lineNumber: 2,
			},
			{
				type: "domain_keyword",
				value: "pay",
				sourceUrl: "https://example.test/provider.list",
				lineNumber: 3,
			},
			{
				type: "domain_regex",
				value: "^api\\.",
				sourceUrl: "https://example.test/provider.list",
				lineNumber: 4,
			},
		]);
		expect(result.unsupportedEntries).toEqual([]);
	});

	test("accepts bare domains and reports unsupported lines", () => {
		const result = parseDomainList(
			["example.com", "*.sub.example.com", "include:other-list"].join("\n"),
			"https://example.test/plain",
		);

		expect(result.entries).toEqual([
			{
				type: "domain_suffix",
				value: "example.com",
				sourceUrl: "https://example.test/plain",
				lineNumber: 1,
			},
			{
				type: "domain_suffix",
				value: "sub.example.com",
				sourceUrl: "https://example.test/plain",
				lineNumber: 2,
			},
		]);
		expect(result.unsupportedEntries).toEqual([
			{
				sourceUrl: "https://example.test/plain",
				lineNumber: 3,
				rawLine: "include:other-list",
			},
		]);
	});

	test("preserves regex values that contain spaces", () => {
		const result = parseDomainList(
			["regexp:^foo bar$", "DOMAIN-REGEX,^bar baz$"].join("\n"),
			"https://example.test/list",
		);

		expect(result.entries).toEqual([
			{
				type: "domain_regex",
				value: "^foo bar$",
				sourceUrl: "https://example.test/list",
				lineNumber: 1,
			},
			{
				type: "domain_regex",
				value: "^bar baz$",
				sourceUrl: "https://example.test/list",
				lineNumber: 2,
			},
		]);
		expect(result.unsupportedEntries).toEqual([]);
	});
});

describe("mergeEntries", () => {
	test("deduplicates entries by rule type and normalized value", () => {
		const result = mergeEntries([
			{
				type: "domain_suffix",
				value: "example.com",
				sourceUrl: "https://a.test/list",
				lineNumber: 1,
			},
			{
				type: "domain_suffix",
				value: "example.com",
				sourceUrl: "https://b.test/list",
				lineNumber: 12,
			},
			{
				type: "domain",
				value: "login.example.com",
				sourceUrl: "https://a.test/list",
				lineNumber: 2,
			},
		]);

		expect(result.ruleValues).toEqual({
			domain: [],
			domain_suffix: ["example.com"],
			domain_keyword: [],
			domain_regex: [],
		});
		expect(result.duplicates).toEqual([
			{
				type: "domain",
				value: "login.example.com",
				sourceUrl: "https://a.test/list",
				lineNumber: 2,
				firstSeenSourceUrl: "https://a.test/list",
				firstSeenLineNumber: 1,
			},
			{
				type: "domain_suffix",
				value: "example.com",
				sourceUrl: "https://b.test/list",
				lineNumber: 12,
				firstSeenSourceUrl: "https://a.test/list",
				firstSeenLineNumber: 1,
			},
		]);
	});

	test("drops domains and narrower suffixes covered by a broader domain suffix", () => {
		const result = mergeEntries([
			{
				type: "domain",
				value: "foo.bar.ru",
				sourceUrl: "https://a.test/list",
				lineNumber: 1,
			},
			{
				type: "domain_suffix",
				value: "bar.ru",
				sourceUrl: "https://a.test/list",
				lineNumber: 2,
			},
			{
				type: "domain",
				value: "example.com",
				sourceUrl: "https://a.test/list",
				lineNumber: 3,
			},
			{
				type: "domain_suffix",
				value: "ru",
				sourceUrl: "https://b.test/list",
				lineNumber: 5,
			},
		]);

		expect(result.ruleValues).toEqual({
			domain: ["example.com"],
			domain_suffix: ["ru"],
			domain_keyword: [],
			domain_regex: [],
		});
		expect(result.duplicates).toEqual([
			{
				type: "domain",
				value: "foo.bar.ru",
				sourceUrl: "https://a.test/list",
				lineNumber: 1,
				firstSeenSourceUrl: "https://b.test/list",
				firstSeenLineNumber: 5,
			},
			{
				type: "domain_suffix",
				value: "bar.ru",
				sourceUrl: "https://a.test/list",
				lineNumber: 2,
				firstSeenSourceUrl: "https://b.test/list",
				firstSeenLineNumber: 5,
			},
		]);
	});
});

describe("buildSingBoxRuleSet", () => {
	test("builds a single headless rule with populated fields only", () => {
		const ruleSet = buildSingBoxRuleSet(
			{
				domain: ["login.example.com"],
				domain_suffix: ["example.com"],
				domain_keyword: [],
				domain_regex: ["^api\\."],
			},
			3,
		);

		expect(ruleSet).toEqual({
			version: 3,
			rules: [
				{
					domain: ["login.example.com"],
					domain_suffix: ["example.com"],
					domain_regex: ["^api\\."],
				},
			],
		});
	});
});

describe("convertDomainLists", () => {
	test("combines multiple sources into one sing-box rule-set", () => {
		const result = convertDomainLists(
			[
				{
					sourceUrl: "https://a.test/list",
					content: ["domain:example.com", "keyword:bank"].join("\n"),
				},
				{
					sourceUrl: "https://b.test/list",
					content: ["domain:example.com", "full:login.example.com"].join("\n"),
				},
			],
			3,
		);

		expect(result.totalParsedEntries).toBe(4);
		expect(result.uniqueEntryCount).toBe(2);
		expect(result.ruleSet).toEqual({
			version: 3,
			rules: [
				{
					domain_suffix: ["example.com"],
					domain_keyword: ["bank"],
				},
			],
		});
		expect(result.duplicates).toHaveLength(2);
	});

	test("removes entries already covered by a broader suffix from another source", () => {
		const result = convertDomainLists(
			[
				{
					sourceUrl: "https://a.test/list",
					content: ["full:foo.bar.ru", "domain:bar.ru"].join("\n"),
				},
				{
					sourceUrl: "https://b.test/list",
					content: "domain:ru",
				},
			],
			3,
		);

		expect(result.totalParsedEntries).toBe(3);
		expect(result.uniqueEntryCount).toBe(1);
		expect(result.ruleSet).toEqual({
			version: 3,
			rules: [
				{
					domain_suffix: ["ru"],
				},
			],
		});
		expect(result.duplicates).toHaveLength(2);
	});
});

describe("resolveSourceUrls", () => {
	test("loads source URLs from config when CLI values are absent", async () => {
		const tempDirectory = await mkdtemp(join(tmpdir(), "category-ru-"));
		const configPath = join(tempDirectory, DEFAULT_SOURCE_CONFIG_PATH);

		try {
			await Bun.write(
				configPath,
				JSON.stringify({
					sourceUrls: ["https://a.test/list", "https://b.test/list"],
				}),
			);

			const sourceUrls = await resolveSourceUrls([], configPath);

			expect(sourceUrls).toEqual([
				"https://a.test/list",
				"https://b.test/list",
			]);
		} finally {
			await rm(tempDirectory, { recursive: true, force: true });
		}
	});

	test("keeps CLI URLs as the highest priority source", async () => {
		const sourceUrls = await resolveSourceUrls([
			"https://cli.test/list",
			"https://cli.test/second-list",
		]);

		expect(sourceUrls).toEqual([
			"https://cli.test/list",
			"https://cli.test/second-list",
		]);
	});
});

describe("writeRuleSet", () => {
	test("writes to the current working directory", async () => {
		const tempDirectory = await mkdtemp(join(tmpdir(), "category-ru-"));
		const previousDirectory = process.cwd();
		const expectedRuleSet: SingBoxRuleSet = {
			version: 3,
			rules: [{ domain_suffix: ["example.com"] }],
		};

		try {
			process.chdir(tempDirectory);
			await writeRuleSet("rule-set.json", expectedRuleSet);

			const writtenContent = await readFile(
				join(tempDirectory, "rule-set.json"),
				"utf8",
			);
			const writtenRuleSet = JSON.parse(
				writtenContent,
			) as typeof expectedRuleSet;

			expect(writtenRuleSet).toEqual(expectedRuleSet);
		} finally {
			process.chdir(previousDirectory);
			await rm(tempDirectory, { recursive: true, force: true });
		}
	});
});
