import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	buildMihomoDomainTextRuleSet,
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
	run,
	type SingBoxRuleSet,
	writeRuleSet,
	writeTextFiles,
} from "../src/index";

describe("CLI metadata", () => {
	test("prints usage with the actual entrypoint path", () => {
		expect(getUsageText()).toContain(
			"bun run ./src/index.ts [options] [url ...]",
		);
		expect(getUsageText()).toContain("--output <path>");
		expect(getUsageText()).toContain("--mihomo-output <path>");
		expect(getUsageText()).not.toContain("--compat-output");
	});

	test("keeps package metadata aligned with the executable entrypoint", async () => {
		const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
			module?: string;
			scripts?: Record<string, string>;
		};

		expect(packageJson.module).toBe("./src/index.ts");
		expect(await Bun.file(packageJson.module ?? "").exists()).toBe(true);
		expect(packageJson.scripts?.["rule-set:generate"]).toContain(
			"rules/sing-box/category-ru.json",
		);
		expect(packageJson.scripts?.["rule-set:generate"]).not.toContain(
			"--compat-output",
		);
		expect(packageJson.scripts?.["rule-set:format"]).not.toContain(
			"rules/category-ru.json",
		);
		expect(packageJson.scripts?.["rule-set:check"]).not.toContain(
			"rules/category-ru.json",
		);
	});

	test("parses help requests without requiring sources", () => {
		expect(parseCliArgs(["--help"])).toEqual({
			helpRequested: true,
			mihomoOutputPath: undefined,
			outputPath: undefined,
			sourceUrls: [],
			version: 3,
		});
	});

	test("parses Mihomo output paths", () => {
		expect(
			parseCliArgs([
				"--url",
				"https://example.test/list",
				"--output",
				"rules/sing-box/category-ru.json",
				"--mihomo-output",
				"rules/mihomo/category-ru.lst",
			]),
		).toEqual({
			helpRequested: false,
			mihomoOutputPath: "rules/mihomo/category-ru.lst",
			outputPath: "rules/sing-box/category-ru.json",
			sourceUrls: ["https://example.test/list"],
			version: 3,
		});
	});

	test("rejects output options when the next token is another option", () => {
		expect(() =>
			parseCliArgs([
				"--output",
				"rules/sing-box/category-ru.json",
				"--mihomo-output",
				"--version",
			]),
		).toThrow("Missing value for --mihomo-output.");
	});

	test("rejects compatibility output paths as unsupported", () => {
		expect(() =>
			parseCliArgs(["--compat-output", "output/compat.json"]),
		).toThrow("Unknown argument: --compat-output");
	});

	test("keeps sing-box workflow updates independent from Mihomo artifacts", async () => {
		const workflow = await readFile(
			".github/workflows/update-rule-set.yml",
			"utf8",
		);

		expect(workflow).not.toContain("LEGACY_RULE_SET_JSON");
		expect(workflow).not.toContain("LEGACY_RULE_SET_BINARY");
		expect(workflow).not.toContain("--compat-output");
		expect(workflow).not.toContain("Copy compatibility sing-box binary");
		expect(workflow.indexOf("Compile rule-set to binary .srs")).toBeLessThan(
			workflow.indexOf("Install Mihomo CLI"),
		);
		expect(workflow).not.toContain("mihomo_ready");

		const singBoxGitAddLine = workflow
			.split("\n")
			.find(
				(line) => line.includes("git add") && line.includes("RULE_SET_JSON"),
			);
		expect(singBoxGitAddLine).toContain("RULE_SET_BINARY");
		expect(singBoxGitAddLine).toContain("MIHOMO_RULE_SET_TEXT");
		expect(singBoxGitAddLine).toContain("MIHOMO_RULE_SET_BINARY");
		expect(singBoxGitAddLine).not.toContain("LEGACY_RULE_SET_JSON");
		expect(singBoxGitAddLine).not.toContain("LEGACY_RULE_SET_BINARY");
	});

	test("keeps workflow write credentials away from downloaded CLIs", async () => {
		const workflow = await readFile(
			".github/workflows/update-rule-set.yml",
			"utf8",
		);

		expect(workflow).toContain("persist-credentials: false");
		expect(workflow).not.toContain("continue-on-error: true");
		expect(workflow).toContain(
			["GITHUB_TOKEN: $", "{{ github.token }}"].join(""),
		);
		expect(workflow).toContain(
			[
				"https://x-access-token:$",
				"{GITHUB_TOKEN}@github.com/$",
				"{GITHUB_REPOSITORY}.git",
			].join(""),
		);

		const mihomoGitAddLine = workflow
			.split("\n")
			.find(
				(line) =>
					line.includes("git add") && line.includes("MIHOMO_RULE_SET_TEXT"),
			);
		expect(mihomoGitAddLine).toContain("MIHOMO_RULE_SET_BINARY");
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
	test("keeps source-derived output files in the sing-box rules directory by default", () => {
		const outputPath = deriveOutputPath([
			"https://example.test/lists/category-ru.list",
		]);

		expect(outputPath).toBe("rules/sing-box/category-ru.list.json");
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

describe("buildMihomoDomainTextRuleSet", () => {
	test("builds Mihomo domain text from exact and suffix rules", () => {
		const ruleSet = buildMihomoDomainTextRuleSet({
			domain: ["login.example.com"],
			domain_suffix: ["example.com", "ru"],
			domain_keyword: [],
			domain_regex: [],
		});

		expect(ruleSet).toBe(
			["login.example.com", "+.example.com", "+.ru", ""].join("\n"),
		);
	});

	test("returns empty text for empty supported fields", () => {
		const ruleSet = buildMihomoDomainTextRuleSet({
			domain: [],
			domain_suffix: [],
			domain_keyword: [],
			domain_regex: [],
		});

		expect(ruleSet).toBe("");
	});

	test("rejects values Mihomo domain text cannot represent", () => {
		expect(() =>
			buildMihomoDomainTextRuleSet({
				domain: [],
				domain_suffix: [],
				domain_keyword: ["pay"],
				domain_regex: ["^api\\."],
			}),
		).toThrow(
			"Mihomo domain text output cannot represent rule field(s): domain_keyword, domain_regex.",
		);
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

describe("writeTextFiles", () => {
	test("restores previous outputs when a later final rename fails", async () => {
		const tempDirectory = await mkdtemp(join(tmpdir(), "category-ru-"));
		const previousDirectory = process.cwd();

		try {
			process.chdir(tempDirectory);
			await Bun.write("first.txt", "old first");
			await Bun.write("second.txt", "old second");

			await expect(
				writeTextFiles(
					[
						{ outputPath: "first.txt", content: "new first" },
						{ outputPath: "second.txt", content: "new second" },
					],
					{
						createTemporarySuffix: () => "rollback-test",
						mkdir,
						rename: async (source, target) => {
							if (String(source).endsWith(".1.tmp")) {
								throw new Error("forced second rename failure");
							}

							await rename(source, target);
						},
						rm,
						stat,
						write: async (path, content) => Bun.write(path, content),
					},
				),
			).rejects.toThrow("forced second rename failure");

			expect(await readFile("first.txt", "utf8")).toBe("old first");
			expect(await readFile("second.txt", "utf8")).toBe("old second");
			expect(await Bun.file("first.txt.rollback-test.0.tmp").exists()).toBe(
				false,
			);
			expect(await Bun.file("first.txt.rollback-test.0.backup").exists()).toBe(
				false,
			);
		} finally {
			process.chdir(previousDirectory);
			await rm(tempDirectory, { recursive: true, force: true });
		}
	});

	test("preserves unrestored backups when rollback restore fails", async () => {
		const tempDirectory = await mkdtemp(join(tmpdir(), "category-ru-"));
		const previousDirectory = process.cwd();

		try {
			process.chdir(tempDirectory);
			await Bun.write("first.txt", "old first");
			await Bun.write("second.txt", "old second");

			let thrownError: unknown;
			await writeTextFiles(
				[
					{ outputPath: "first.txt", content: "new first" },
					{ outputPath: "second.txt", content: "new second" },
				],
				{
					createTemporarySuffix: () => "rollback-test",
					mkdir,
					rename: async (source, target) => {
						if (String(source).endsWith(".1.tmp")) {
							throw new Error("forced second rename failure");
						}

						if (
							String(source).endsWith(".0.backup") &&
							String(target) === "first.txt"
						) {
							throw new Error("forced restore failure");
						}

						await rename(source, target);
					},
					rm,
					stat,
					write: async (path, content) => Bun.write(path, content),
				},
			).catch((error: unknown) => {
				thrownError = error;
			});

			expect(thrownError).toBeInstanceOf(AggregateError);
			expect(String(thrownError)).toContain(
				"Failed to write text files and restore one or more backups.",
			);
			expect(await Bun.file("first.txt").exists()).toBe(false);
			expect(await readFile("first.txt.rollback-test.0.backup", "utf8")).toBe(
				"old first",
			);
			expect(await readFile("second.txt", "utf8")).toBe("old second");
		} finally {
			process.chdir(previousDirectory);
			await rm(tempDirectory, { recursive: true, force: true });
		}
	});

	test("overwrites existing outputs and cleans temporary files on success", async () => {
		const tempDirectory = await mkdtemp(join(tmpdir(), "category-ru-"));
		const previousDirectory = process.cwd();

		try {
			process.chdir(tempDirectory);
			await Bun.write("first.txt", "old first");
			await Bun.write("second.txt", "old second");

			await writeTextFiles(
				[
					{ outputPath: "first.txt", content: "new first" },
					{ outputPath: "second.txt", content: "new second" },
				],
				{
					createTemporarySuffix: () => "success-test",
					mkdir,
					rename,
					rm,
					stat,
					write: async (path, content) => Bun.write(path, content),
				},
			);

			expect(await readFile("first.txt", "utf8")).toBe("new first");
			expect(await readFile("second.txt", "utf8")).toBe("new second");
			expect(await Bun.file("first.txt.success-test.0.tmp").exists()).toBe(
				false,
			);
			expect(await Bun.file("first.txt.success-test.0.backup").exists()).toBe(
				false,
			);
			expect(await Bun.file("second.txt.success-test.1.tmp").exists()).toBe(
				false,
			);
			expect(await Bun.file("second.txt.success-test.1.backup").exists()).toBe(
				false,
			);
		} finally {
			process.chdir(previousDirectory);
			await rm(tempDirectory, { recursive: true, force: true });
		}
	});
});

describe("run", () => {
	test("writes sing-box and Mihomo outputs from one conversion", async () => {
		const tempDirectory = await mkdtemp(join(tmpdir(), "category-ru-"));
		const previousDirectory = process.cwd();
		const previousFetch = globalThis.fetch;
		const fetchedUrls: string[] = [];

		const fetchMock: typeof fetch = Object.assign(
			async (input: string | URL | Request) => {
				fetchedUrls.push(String(input));
				return new Response(
					["domain:example.com", "full:login.example.com"].join("\n"),
				);
			},
			{ preconnect: previousFetch.preconnect },
		);

		globalThis.fetch = fetchMock;

		try {
			process.chdir(tempDirectory);
			await run([
				"--url",
				"https://example.test/list",
				"--output",
				"rules/sing-box/category-ru.json",
				"--mihomo-output",
				"rules/mihomo/category-ru.lst",
			]);

			const singBoxRuleSet = JSON.parse(
				await readFile(
					join(tempDirectory, "rules/sing-box/category-ru.json"),
					"utf8",
				),
			) as SingBoxRuleSet;
			const mihomoRuleSet = await readFile(
				join(tempDirectory, "rules/mihomo/category-ru.lst"),
				"utf8",
			);

			expect(fetchedUrls).toEqual(["https://example.test/list"]);
			expect(singBoxRuleSet).toEqual({
				version: 3,
				rules: [
					{
						domain_suffix: ["example.com"],
					},
				],
			});
			expect(await Bun.file("rules/category-ru.json").exists()).toBe(false);
			expect(mihomoRuleSet).toBe("+.example.com\n");
		} finally {
			globalThis.fetch = previousFetch;
			process.chdir(previousDirectory);
			await rm(tempDirectory, { recursive: true, force: true });
		}
	});

	test("writes only sing-box output when Mihomo output is omitted", async () => {
		const tempDirectory = await mkdtemp(join(tmpdir(), "category-ru-"));
		const previousDirectory = process.cwd();
		const previousFetch = globalThis.fetch;
		const previousLog = console.log;
		const fetchedUrls: string[] = [];
		const loggedMessages: string[] = [];

		const fetchMock: typeof fetch = Object.assign(
			async (input: string | URL | Request) => {
				fetchedUrls.push(String(input));
				return new Response("domain:example.com");
			},
			{ preconnect: previousFetch.preconnect },
		);

		globalThis.fetch = fetchMock;
		console.log = (...values: unknown[]) => {
			loggedMessages.push(values.map(String).join(" "));
		};

		try {
			process.chdir(tempDirectory);
			await run([
				"--url",
				"https://example.test/list",
				"--output",
				"rules/sing-box/category-ru.json",
			]);

			const singBoxRuleSet = JSON.parse(
				await readFile(
					join(tempDirectory, "rules/sing-box/category-ru.json"),
					"utf8",
				),
			) as SingBoxRuleSet;

			expect(fetchedUrls).toEqual(["https://example.test/list"]);
			expect(singBoxRuleSet).toEqual({
				version: 3,
				rules: [
					{
						domain_suffix: ["example.com"],
					},
				],
			});
			expect(await Bun.file("rules/mihomo/category-ru.lst").exists()).toBe(
				false,
			);
			expect(loggedMessages.join("\n")).not.toContain("Mihomo");
		} finally {
			globalThis.fetch = previousFetch;
			console.log = previousLog;
			process.chdir(previousDirectory);
			await rm(tempDirectory, { recursive: true, force: true });
		}
	});

	test("rejects matching sing-box and Mihomo output paths before writing", async () => {
		const tempDirectory = await mkdtemp(join(tmpdir(), "category-ru-"));
		const previousDirectory = process.cwd();
		const previousFetch = globalThis.fetch;
		let fetchCalled = false;

		const fetchMock: typeof fetch = Object.assign(
			async () => {
				fetchCalled = true;
				return new Response("domain:example.com");
			},
			{ preconnect: previousFetch.preconnect },
		);

		globalThis.fetch = fetchMock;

		try {
			process.chdir(tempDirectory);

			await expect(
				run([
					"--url",
					"https://example.test/list",
					"--output",
					"rules/category-ru",
					"--mihomo-output",
					"./rules/category-ru",
				]),
			).rejects.toThrow(
				"Output paths must be different: --output and --mihomo-output both resolve to rules/category-ru.",
			);

			expect(fetchCalled).toBe(false);
			expect(await Bun.file("rules/category-ru").exists()).toBe(false);
		} finally {
			globalThis.fetch = previousFetch;
			process.chdir(previousDirectory);
			await rm(tempDirectory, { recursive: true, force: true });
		}
	});

	test("rejects nested sing-box and Mihomo output paths before writing", async () => {
		const tempDirectory = await mkdtemp(join(tmpdir(), "category-ru-"));
		const previousDirectory = process.cwd();
		const previousFetch = globalThis.fetch;
		let fetchCalled = false;

		const fetchMock: typeof fetch = Object.assign(
			async () => {
				fetchCalled = true;
				return new Response("domain:example.com");
			},
			{ preconnect: previousFetch.preconnect },
		);

		globalThis.fetch = fetchMock;

		try {
			process.chdir(tempDirectory);

			await expect(
				run([
					"--url",
					"https://example.test/list",
					"--output",
					"rules/category-ru",
					"--mihomo-output",
					"rules/category-ru/category-ru.lst",
				]),
			).rejects.toThrow(
				"Output paths must not overlap: --output resolves to rules/category-ru and --mihomo-output resolves to rules/category-ru/category-ru.lst.",
			);

			expect(fetchCalled).toBe(false);
			expect(await Bun.file("rules/category-ru").exists()).toBe(false);
		} finally {
			globalThis.fetch = previousFetch;
			process.chdir(previousDirectory);
			await rm(tempDirectory, { recursive: true, force: true });
		}
	});

	test("rejects Mihomo output when keyword rules cannot be represented", async () => {
		const tempDirectory = await mkdtemp(join(tmpdir(), "category-ru-"));
		const previousDirectory = process.cwd();
		const previousFetch = globalThis.fetch;

		const fetchMock: typeof fetch = Object.assign(
			async () => new Response("keyword:pay"),
			{ preconnect: previousFetch.preconnect },
		);

		globalThis.fetch = fetchMock;

		try {
			process.chdir(tempDirectory);

			await expect(
				run([
					"--url",
					"https://example.test/list",
					"--output",
					"rules/sing-box/category-ru.json",
					"--mihomo-output",
					"rules/mihomo/category-ru.lst",
				]),
			).rejects.toThrow(
				"Mihomo domain text output cannot represent rule field(s): domain_keyword.",
			);

			expect(await Bun.file("rules/sing-box/category-ru.json").exists()).toBe(
				false,
			);
			expect(await Bun.file("rules/mihomo/category-ru.lst").exists()).toBe(
				false,
			);
		} finally {
			globalThis.fetch = previousFetch;
			process.chdir(previousDirectory);
			await rm(tempDirectory, { recursive: true, force: true });
		}
	});

	test("rejects Mihomo output paths that contain the sing-box output path before writing", async () => {
		const tempDirectory = await mkdtemp(join(tmpdir(), "category-ru-"));
		const previousDirectory = process.cwd();
		const previousFetch = globalThis.fetch;
		let fetchCalled = false;

		const fetchMock: typeof fetch = Object.assign(
			async () => {
				fetchCalled = true;
				return new Response("domain:example.com");
			},
			{ preconnect: previousFetch.preconnect },
		);

		globalThis.fetch = fetchMock;

		try {
			process.chdir(tempDirectory);

			await expect(
				run([
					"--url",
					"https://example.test/list",
					"--output",
					"rules/category-ru/category-ru.json",
					"--mihomo-output",
					"rules/category-ru",
				]),
			).rejects.toThrow(
				"Output paths must not overlap: --output resolves to rules/category-ru/category-ru.json and --mihomo-output resolves to rules/category-ru.",
			);

			expect(fetchCalled).toBe(false);
			expect(await Bun.file("rules/category-ru").exists()).toBe(false);
		} finally {
			globalThis.fetch = previousFetch;
			process.chdir(previousDirectory);
			await rm(tempDirectory, { recursive: true, force: true });
		}
	});

	test("rejects compatibility output paths before writing", async () => {
		const tempDirectory = await mkdtemp(join(tmpdir(), "category-ru-"));
		const previousDirectory = process.cwd();
		const previousFetch = globalThis.fetch;
		let fetchCalled = false;

		const fetchMock: typeof fetch = Object.assign(
			async () => {
				fetchCalled = true;
				return new Response("domain:example.com");
			},
			{ preconnect: previousFetch.preconnect },
		);

		globalThis.fetch = fetchMock;

		try {
			process.chdir(tempDirectory);

			await expect(
				run([
					"--url",
					"https://example.test/list",
					"--output",
					"output/category-ru.json",
					"--compat-output",
					"output/compat.json",
				]),
			).rejects.toThrow("Unknown argument: --compat-output");

			expect(fetchCalled).toBe(false);
			expect(await Bun.file("rules").exists()).toBe(false);
		} finally {
			globalThis.fetch = previousFetch;
			process.chdir(previousDirectory);
			await rm(tempDirectory, { recursive: true, force: true });
		}
	});

	test("rejects nested output names that start with two dots before writing", async () => {
		const tempDirectory = await mkdtemp(join(tmpdir(), "category-ru-"));
		const previousDirectory = process.cwd();
		const previousFetch = globalThis.fetch;
		let fetchCalled = false;

		const fetchMock: typeof fetch = Object.assign(
			async () => {
				fetchCalled = true;
				return new Response("domain:example.com");
			},
			{ preconnect: previousFetch.preconnect },
		);

		globalThis.fetch = fetchMock;

		try {
			process.chdir(tempDirectory);

			await expect(
				run([
					"--url",
					"https://example.test/list",
					"--output",
					"rules/category-ru",
					"--mihomo-output",
					"rules/category-ru/..mihomo/category-ru.lst",
				]),
			).rejects.toThrow(
				"Output paths must not overlap: --output resolves to rules/category-ru and --mihomo-output resolves to rules/category-ru/..mihomo/category-ru.lst.",
			);

			expect(fetchCalled).toBe(false);
			expect(await Bun.file("rules").exists()).toBe(false);
		} finally {
			globalThis.fetch = previousFetch;
			process.chdir(previousDirectory);
			await rm(tempDirectory, { recursive: true, force: true });
		}
	});

	test("writes outputs and warns when unsupported source lines are skipped", async () => {
		const tempDirectory = await mkdtemp(join(tmpdir(), "category-ru-"));
		const previousDirectory = process.cwd();
		const previousFetch = globalThis.fetch;
		const previousWarn = console.warn;
		const warnings: string[] = [];

		const fetchMock: typeof fetch = Object.assign(
			async () =>
				new Response(["domain:example.com", "include:other"].join("\n")),
			{ preconnect: previousFetch.preconnect },
		);

		globalThis.fetch = fetchMock;
		console.warn = (...values: unknown[]) => {
			warnings.push(values.map(String).join(" "));
		};

		try {
			process.chdir(tempDirectory);

			await run([
				"--url",
				"https://example.test/list",
				"--output",
				"rules/sing-box/category-ru.json",
				"--mihomo-output",
				"rules/mihomo/category-ru.lst",
			]);

			expect(await Bun.file("rules/sing-box/category-ru.json").exists()).toBe(
				true,
			);
			expect(await Bun.file("rules/mihomo/category-ru.lst").exists()).toBe(
				true,
			);
			expect(warnings.join("\n")).toContain(
				"- https://example.test/list:2 => include:other",
			);
		} finally {
			globalThis.fetch = previousFetch;
			console.warn = previousWarn;
			process.chdir(previousDirectory);
			await rm(tempDirectory, { recursive: true, force: true });
		}
	});

	test("rejects Mihomo output when regex rules cannot be represented", async () => {
		const tempDirectory = await mkdtemp(join(tmpdir(), "category-ru-"));
		const previousDirectory = process.cwd();
		const previousFetch = globalThis.fetch;

		const fetchMock: typeof fetch = Object.assign(
			async () =>
				new Response(["domain:example.com", "regexp:^api\\."].join("\n")),
			{ preconnect: previousFetch.preconnect },
		);

		globalThis.fetch = fetchMock;

		try {
			process.chdir(tempDirectory);

			await expect(
				run([
					"--url",
					"https://example.test/list",
					"--output",
					"rules/sing-box/category-ru.json",
					"--mihomo-output",
					"rules/mihomo/category-ru.lst",
				]),
			).rejects.toThrow(
				"Mihomo domain text output cannot represent rule field(s): domain_regex.",
			);

			expect(await Bun.file("rules/sing-box/category-ru.json").exists()).toBe(
				false,
			);
			expect(await Bun.file("rules/mihomo/category-ru.lst").exists()).toBe(
				false,
			);
		} finally {
			globalThis.fetch = previousFetch;
			process.chdir(previousDirectory);
			await rm(tempDirectory, { recursive: true, force: true });
		}
	});

	test("does not leave the first output when the second output path fails", async () => {
		const tempDirectory = await mkdtemp(join(tmpdir(), "category-ru-"));
		const previousDirectory = process.cwd();
		const previousFetch = globalThis.fetch;

		const fetchMock: typeof fetch = Object.assign(
			async () => new Response("domain:example.com"),
			{ preconnect: previousFetch.preconnect },
		);

		globalThis.fetch = fetchMock;

		try {
			process.chdir(tempDirectory);
			await mkdir("rules/sing-box", { recursive: true });
			await mkdir("rules/mihomo", { recursive: true });

			await expect(
				run([
					"--url",
					"https://example.test/list",
					"--output",
					"rules/sing-box/category-ru.json",
					"--mihomo-output",
					"rules/mihomo",
				]),
			).rejects.toThrow();

			expect(await Bun.file("rules/sing-box/category-ru.json").exists()).toBe(
				false,
			);
			expect(await Bun.file("rules/mihomo/category-ru.lst").exists()).toBe(
				false,
			);
		} finally {
			globalThis.fetch = previousFetch;
			process.chdir(previousDirectory);
			await rm(tempDirectory, { recursive: true, force: true });
		}
	});
});
