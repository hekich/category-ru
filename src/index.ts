import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const DEFAULT_SOURCE_CONFIG_PATH = "category-ru.config.json";

export const DEFAULT_RULE_SET_VERSION = 3;

const DEFAULT_OUTPUT_DIRECTORY = "rules/sing-box";

const DEFAULT_OUTPUT_FILE = `${DEFAULT_OUTPUT_DIRECTORY}/category-ru.json`;

const RULE_FIELD_BY_PREFIX = {
	domain: "domain_suffix",
	domain_suffix: "domain_suffix",
	full: "domain",
	keyword: "domain_keyword",
	domain_keyword: "domain_keyword",
	regexp: "domain_regex",
	regex: "domain_regex",
	domain_regex: "domain_regex",
} as const;

const MIHOMO_RULE_FIELD_BY_PREFIX = {
	DOMAIN: "domain",
	"DOMAIN-SUFFIX": "domain_suffix",
	"DOMAIN-KEYWORD": "domain_keyword",
	"DOMAIN-REGEX": "domain_regex",
} as const;

const RULE_FIELDS = [
	"domain",
	"domain_suffix",
	"domain_keyword",
	"domain_regex",
] as const;

type SourcePrefix = keyof typeof RULE_FIELD_BY_PREFIX;
type MihomoPrefix = keyof typeof MIHOMO_RULE_FIELD_BY_PREFIX;
type DomainListFormat = "geosite" | "mihomo";

export type RuleField = (typeof RULE_FIELD_BY_PREFIX)[SourcePrefix];
export type RuleSetVersion = 1 | 2 | 3 | 4;

export type ParsedEntry = {
	type: RuleField;
	value: string;
	sourceUrl: string;
	lineNumber: number;
};

export type DuplicateEntry = ParsedEntry & {
	firstSeenSourceUrl: string;
	firstSeenLineNumber: number;
};

export type UnsupportedEntry = {
	sourceUrl: string;
	lineNumber: number;
	rawLine: string;
};

export type ParseResult = {
	entries: ParsedEntry[];
	unsupportedEntries: UnsupportedEntry[];
};

export type GroupedRuleValues = {
	[Key in (typeof RULE_FIELDS)[number]]: string[];
};

export type SingBoxRule = Partial<
	Record<(typeof RULE_FIELDS)[number], string[]>
>;

export type SingBoxRuleSet = {
	version: RuleSetVersion;
	rules: SingBoxRule[];
};

export type MergeResult = {
	ruleValues: GroupedRuleValues;
	duplicates: DuplicateEntry[];
};

export type ConversionResult = MergeResult & {
	ruleSet: SingBoxRuleSet;
	unsupportedEntries: UnsupportedEntry[];
	totalParsedEntries: number;
	uniqueEntryCount: number;
};

type CliOptions = {
	sourceUrls: string[];
	outputPath?: string;
	mihomoOutputPath?: string;
	version: RuleSetVersion;
	helpRequested: boolean;
};

type TextFileTargetStat = {
	isDirectory: () => boolean;
};

export type WriteTextFilesOperations = {
	createTemporarySuffix: () => string;
	mkdir: typeof mkdir;
	rename: typeof rename;
	rm: typeof rm;
	stat: (path: string) => Promise<TextFileTargetStat>;
	write: (path: string, content: string) => Promise<unknown>;
};

const BARE_DOMAIN_PATTERN =
	/^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

const createEmptyRuleValues = (): GroupedRuleValues => ({
	domain: [],
	domain_suffix: [],
	domain_keyword: [],
	domain_regex: [],
});

const countDomainLabels = (value: string): number => value.split(".").length;

const findCoveringDomainSuffixEntry = (
	value: string,
	domainSuffixEntryByValue: ReadonlyMap<string, ParsedEntry>,
	includeSelf: boolean,
): ParsedEntry | undefined => {
	const labels = value.split(".");
	const startIndex = includeSelf ? 0 : 1;

	for (let index = startIndex; index < labels.length; index += 1) {
		const candidateValue = labels.slice(index).join(".");
		const coveringEntry = domainSuffixEntryByValue.get(candidateValue);

		if (coveringEntry) {
			return coveringEntry;
		}
	}

	return undefined;
};

const isSourcePrefix = (value: string): value is SourcePrefix =>
	Object.hasOwn(RULE_FIELD_BY_PREFIX, value);

const isMihomoPrefix = (value: string): value is MihomoPrefix =>
	Object.hasOwn(MIHOMO_RULE_FIELD_BY_PREFIX, value);

const isRuleSetVersion = (value: number): value is RuleSetVersion =>
	Number.isInteger(value) && value >= 1 && value <= 4;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
	typeof value === "string" && value.trim().length > 0;

const isInvalidPathCharacter = (character: string): boolean => {
	const codePoint = character.charCodeAt(0);
	return (
		'<>:"/\\|?*'.includes(character) || (codePoint >= 0 && codePoint <= 31)
	);
};

const sanitizeOutputName = (value: string): string => {
	const sanitized = [...value.trim()]
		.map((character) => (isInvalidPathCharacter(character) ? "-" : character))
		.join("");
	return sanitized.length > 0 ? sanitized : "rule-set";
};

export const deriveOutputPath = (sourceUrls: readonly string[]): string => {
	const [firstSourceUrl] = sourceUrls;

	if (!firstSourceUrl) {
		return DEFAULT_OUTPUT_FILE;
	}

	try {
		const lastPathSegment = new URL(firstSourceUrl).pathname
			.split("/")
			.filter(Boolean)
			.at(-1);

		return `${DEFAULT_OUTPUT_DIRECTORY}/${sanitizeOutputName(lastPathSegment ?? "rule-set")}.json`;
	} catch {
		return DEFAULT_OUTPUT_FILE;
	}
};

export const parseSourceConfig = (
	content: string,
	configPath: string,
): string[] => {
	let parsedContent: unknown;

	try {
		parsedContent = JSON.parse(content) as unknown;
	} catch {
		throw new Error(`Invalid JSON in ${configPath}.`);
	}

	if (!isRecord(parsedContent)) {
		throw new Error(
			`Invalid source config in ${configPath}: expected an object with a sourceUrls array.`,
		);
	}

	const sourceUrls = parsedContent.sourceUrls;

	if (
		!Array.isArray(sourceUrls) ||
		sourceUrls.length === 0 ||
		sourceUrls.some((sourceUrl) => !isNonEmptyString(sourceUrl))
	) {
		throw new Error(
			`Invalid source config in ${configPath}: sourceUrls must be a non-empty array of strings.`,
		);
	}

	return sourceUrls.map((sourceUrl) => sourceUrl.trim());
};

export const readSourceConfig = async (
	configPath: string = DEFAULT_SOURCE_CONFIG_PATH,
): Promise<string[] | undefined> => {
	const configFile = Bun.file(configPath);

	if (!(await configFile.exists())) {
		return undefined;
	}

	return parseSourceConfig(await configFile.text(), configPath);
};

export const resolveSourceUrls = async (
	cliSourceUrls: readonly string[],
	configPath: string = DEFAULT_SOURCE_CONFIG_PATH,
): Promise<string[]> => {
	if (cliSourceUrls.length > 0) {
		return [...cliSourceUrls];
	}

	const configuredSourceUrls = await readSourceConfig(configPath);

	if (configuredSourceUrls) {
		return configuredSourceUrls;
	}

	throw new Error(
		`No source URLs provided. Add them to ${configPath} or pass --url.`,
	);
};

const normalizeEntryValue = (type: RuleField, value: string): string => {
	const normalizedValue = value.trim();
	return type === "domain_regex"
		? normalizedValue
		: normalizedValue.toLowerCase();
};

const stripWildcardPrefix = (value: string): string =>
	value.startsWith("*.") ? value.slice(2) : value;

const stripDomainSuffixPrefix = (value: string): string => {
	const normalizedValue = stripWildcardPrefix(value);

	if (normalizedValue.startsWith("+.")) {
		return normalizedValue.slice(2);
	}

	if (normalizedValue.startsWith(".")) {
		return normalizedValue.slice(1);
	}

	return normalizedValue;
};

const normalizeParsedValue = (type: RuleField, value: string): string =>
	normalizeEntryValue(
		type,
		type === "domain_suffix"
			? stripDomainSuffixPrefix(value)
			: stripWildcardPrefix(value),
	);

const extractParsedValue = (type: RuleField, value: string): string => {
	const trimmedValue = value.trim();

	if (trimmedValue.length === 0) {
		return "";
	}

	return type === "domain_regex"
		? trimmedValue
		: (trimmedValue.split(/\s+/, 1)[0] ?? "");
};

const splitGeoSiteEntryLine = (
	line: string,
): { prefix: string; value: string } | undefined => {
	const separatorIndex = line.indexOf(":");

	if (separatorIndex === -1) {
		return undefined;
	}

	return {
		prefix: line.slice(0, separatorIndex).trim().toLowerCase(),
		value: line.slice(separatorIndex + 1).trim(),
	};
};

const splitMihomoEntryLine = (
	line: string,
): { prefix: string; value: string } | undefined => {
	const separatorIndex = line.indexOf(",");

	if (separatorIndex === -1) {
		return undefined;
	}

	return {
		prefix: line.slice(0, separatorIndex).trim().toUpperCase(),
		value: line.slice(separatorIndex + 1).trim(),
	};
};

const getMeaningfulLines = (content: string): string[] =>
	content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));

const usesMihomoListExtension = (sourceUrl: string): boolean => {
	try {
		return new URL(sourceUrl).pathname.toLowerCase().endsWith(".list");
	} catch {
		return sourceUrl.toLowerCase().endsWith(".list");
	}
};

const detectDomainListFormat = (
	content: string,
	sourceUrl: string,
): DomainListFormat => {
	for (const line of getMeaningfulLines(content)) {
		if (line.startsWith("+.")) {
			return "mihomo";
		}

		const mihomoEntryLine = splitMihomoEntryLine(line);
		if (mihomoEntryLine && isMihomoPrefix(mihomoEntryLine.prefix)) {
			return "mihomo";
		}

		const geositeEntryLine = splitGeoSiteEntryLine(line);
		if (geositeEntryLine && isSourcePrefix(geositeEntryLine.prefix)) {
			return "geosite";
		}
	}

	return usesMihomoListExtension(sourceUrl) ? "mihomo" : "geosite";
};

const createParsedEntry = (
	type: RuleField,
	value: string,
	sourceUrl: string,
	lineNumber: number,
): ParsedEntry => ({
	type,
	value: normalizeParsedValue(type, value),
	sourceUrl,
	lineNumber,
});

const parseGeoSiteLine = (
	line: string,
	sourceUrl: string,
	lineNumber: number,
): ParsedEntry | undefined => {
	if (BARE_DOMAIN_PATTERN.test(line)) {
		return createParsedEntry("domain_suffix", line, sourceUrl, lineNumber);
	}

	const splitLine = splitGeoSiteEntryLine(line);

	if (!splitLine || !isSourcePrefix(splitLine.prefix)) {
		return undefined;
	}

	const type = RULE_FIELD_BY_PREFIX[splitLine.prefix];
	const normalizedValue = extractParsedValue(type, splitLine.value);

	if (normalizedValue.length === 0) {
		return undefined;
	}

	return createParsedEntry(type, normalizedValue, sourceUrl, lineNumber);
};

const parseMihomoLine = (
	line: string,
	sourceUrl: string,
	lineNumber: number,
): ParsedEntry | undefined => {
	if (line.startsWith("+.")) {
		return createParsedEntry("domain_suffix", line, sourceUrl, lineNumber);
	}

	const splitLine = splitMihomoEntryLine(line);

	if (splitLine && isMihomoPrefix(splitLine.prefix)) {
		const type = MIHOMO_RULE_FIELD_BY_PREFIX[splitLine.prefix];
		const normalizedValue = extractParsedValue(type, splitLine.value);

		if (normalizedValue.length === 0) {
			return undefined;
		}

		return createParsedEntry(type, normalizedValue, sourceUrl, lineNumber);
	}

	if (BARE_DOMAIN_PATTERN.test(line)) {
		return createParsedEntry("domain", line, sourceUrl, lineNumber);
	}

	return undefined;
};

export const parseDomainList = (
	content: string,
	sourceUrl: string,
): ParseResult => {
	const listFormat = detectDomainListFormat(content, sourceUrl);

	const result = content.split(/\r?\n/).reduce<ParseResult>(
		(accumulator, rawLine, index) => {
			const lineNumber = index + 1;
			const line = rawLine.trim();

			if (line.length === 0 || line.startsWith("#")) {
				return accumulator;
			}

			const parsedEntry =
				listFormat === "mihomo"
					? (parseMihomoLine(line, sourceUrl, lineNumber) ??
						parseGeoSiteLine(line, sourceUrl, lineNumber))
					: (parseGeoSiteLine(line, sourceUrl, lineNumber) ??
						parseMihomoLine(line, sourceUrl, lineNumber));

			if (!parsedEntry) {
				accumulator.unsupportedEntries.push({
					sourceUrl,
					lineNumber,
					rawLine: rawLine,
				});
				return accumulator;
			}

			accumulator.entries.push(parsedEntry);

			return accumulator;
		},
		{
			entries: [],
			unsupportedEntries: [],
		},
	);

	return result;
};

export const mergeEntries = (entries: readonly ParsedEntry[]): MergeResult => {
	const firstSeenByKey = new Map<string, ParsedEntry>();
	const uniqueEntries: ParsedEntry[] = [];
	const keptDomainSuffixEntriesByValue = new Map<string, ParsedEntry>();
	const ruleValues = createEmptyRuleValues();
	const duplicates: DuplicateEntry[] = [];

	for (const entry of entries) {
		const dedupeKey = `${entry.type}:${entry.value}`;
		const firstSeen = firstSeenByKey.get(dedupeKey);

		if (firstSeen) {
			duplicates.push({
				...entry,
				firstSeenSourceUrl: firstSeen.sourceUrl,
				firstSeenLineNumber: firstSeen.lineNumber,
			});
			continue;
		}

		firstSeenByKey.set(dedupeKey, entry);
		uniqueEntries.push(entry);
	}

	const domainSuffixEntries = uniqueEntries
		.filter((entry) => entry.type === "domain_suffix")
		.toSorted((left, right) => {
			const labelCountComparison =
				countDomainLabels(left.value) - countDomainLabels(right.value);

			if (labelCountComparison !== 0) {
				return labelCountComparison;
			}

			return left.value.localeCompare(right.value);
		});

	for (const entry of domainSuffixEntries) {
		const coveringEntry = findCoveringDomainSuffixEntry(
			entry.value,
			keptDomainSuffixEntriesByValue,
			false,
		);

		if (coveringEntry) {
			duplicates.push({
				...entry,
				firstSeenSourceUrl: coveringEntry.sourceUrl,
				firstSeenLineNumber: coveringEntry.lineNumber,
			});
			continue;
		}

		keptDomainSuffixEntriesByValue.set(entry.value, entry);
		ruleValues.domain_suffix.push(entry.value);
	}

	for (const entry of uniqueEntries) {
		if (entry.type === "domain_suffix") {
			continue;
		}

		if (entry.type === "domain") {
			const coveringEntry = findCoveringDomainSuffixEntry(
				entry.value,
				keptDomainSuffixEntriesByValue,
				true,
			);

			if (coveringEntry) {
				duplicates.push({
					...entry,
					firstSeenSourceUrl: coveringEntry.sourceUrl,
					firstSeenLineNumber: coveringEntry.lineNumber,
				});
				continue;
			}
		}

		ruleValues[entry.type].push(entry.value);
	}

	const sortedRuleValues = RULE_FIELDS.reduce<GroupedRuleValues>(
		(accumulator, field) => {
			accumulator[field] = ruleValues[field].toSorted((left, right) =>
				left.localeCompare(right),
			);
			return accumulator;
		},
		createEmptyRuleValues(),
	);

	return {
		ruleValues: sortedRuleValues,
		duplicates: duplicates.toSorted((left, right) => {
			const typeComparison = left.type.localeCompare(right.type);
			if (typeComparison !== 0) {
				return typeComparison;
			}

			const valueComparison = left.value.localeCompare(right.value);
			if (valueComparison !== 0) {
				return valueComparison;
			}

			const sourceComparison = left.sourceUrl.localeCompare(right.sourceUrl);
			if (sourceComparison !== 0) {
				return sourceComparison;
			}

			return left.lineNumber - right.lineNumber;
		}),
	};
};

export const buildSingBoxRuleSet = (
	ruleValues: GroupedRuleValues,
	version: RuleSetVersion,
): SingBoxRuleSet => {
	const rule = RULE_FIELDS.reduce<SingBoxRule>((accumulator, field) => {
		if (ruleValues[field].length > 0) {
			accumulator[field] = ruleValues[field];
		}

		return accumulator;
	}, {});

	return {
		version,
		rules: Object.keys(rule).length === 0 ? [] : [rule],
	};
};

const MIHOMO_DOMAIN_TEXT_UNSUPPORTED_FIELDS = [
	"domain_keyword",
	"domain_regex",
] as const;

const MIHOMO_DOMAIN_TEXT_LINE_FORMATTERS = {
	domain: (value: string) => value,
	domain_suffix: (value: string) => `+.${value}`,
} as const satisfies Partial<Record<RuleField, (value: string) => string>>;

const getMihomoDomainTextUnsupportedFields = (
	ruleValues: GroupedRuleValues,
): (typeof MIHOMO_DOMAIN_TEXT_UNSUPPORTED_FIELDS)[number][] =>
	MIHOMO_DOMAIN_TEXT_UNSUPPORTED_FIELDS.filter(
		(field) => ruleValues[field].length > 0,
	);

const assertMihomoDomainTextSupported = (
	ruleValues: GroupedRuleValues,
): void => {
	const unsupportedFields = getMihomoDomainTextUnsupportedFields(ruleValues);

	if (unsupportedFields.length > 0) {
		throw new Error(
			`Mihomo domain text output cannot represent rule field(s): ${unsupportedFields.join(", ")}.`,
		);
	}
};

export const buildMihomoDomainTextRuleSet = (
	ruleValues: GroupedRuleValues,
): string => {
	assertMihomoDomainTextSupported(ruleValues);

	const lines = Object.entries(MIHOMO_DOMAIN_TEXT_LINE_FORMATTERS).flatMap(
		([field, formatLine]) =>
			ruleValues[field as keyof typeof MIHOMO_DOMAIN_TEXT_LINE_FORMATTERS].map(
				formatLine,
			),
	);

	return lines.length > 0 ? `${lines.join("\n")}\n` : "";
};

export const convertDomainLists = (
	sources: ReadonlyArray<{ sourceUrl: string; content: string }>,
	version: RuleSetVersion,
): ConversionResult => {
	const parsedResults = sources.map(({ sourceUrl, content }) =>
		parseDomainList(content, sourceUrl),
	);
	const parsedEntries = parsedResults.flatMap((result) => result.entries);
	const unsupportedEntries = parsedResults.flatMap(
		(result) => result.unsupportedEntries,
	);
	const mergeResult = mergeEntries(parsedEntries);
	const uniqueEntryCount = RULE_FIELDS.reduce(
		(total, field) => total + mergeResult.ruleValues[field].length,
		0,
	);

	if (uniqueEntryCount === 0) {
		throw new Error(
			"No supported domain entries were found in the provided sources.",
		);
	}

	return {
		...mergeResult,
		ruleSet: buildSingBoxRuleSet(mergeResult.ruleValues, version),
		unsupportedEntries,
		totalParsedEntries: parsedEntries.length,
		uniqueEntryCount,
	};
};

const fetchSource = async (
	sourceUrl: string,
): Promise<{ sourceUrl: string; content: string }> => {
	const response = await fetch(sourceUrl);

	if (!response.ok) {
		throw new Error(
			`Failed to fetch ${sourceUrl}: ${response.status} ${response.statusText}`,
		);
	}

	return {
		sourceUrl,
		content: await response.text(),
	};
};

const formatResolvedPath = (path: string): string => {
	const relativePath = relative(process.cwd(), path);
	return (relativePath.length > 0 ? relativePath : ".").split(sep).join("/");
};

const isNestedPath = (path: string, possibleParentPath: string): boolean => {
	const relativePath = relative(possibleParentPath, path);
	const escapedParent =
		relativePath === ".." || relativePath.startsWith(`..${sep}`);

	return relativePath.length > 0 && !escapedParent && !isAbsolute(relativePath);
};

type NamedOutputPath = {
	optionName: string;
	path: string;
};

const assertDistinctOutputPaths = (
	outputPath: string,
	mihomoOutputPath: string | undefined,
): void => {
	const outputPaths: NamedOutputPath[] = [
		{ optionName: "--output", path: outputPath },
	];

	if (mihomoOutputPath) {
		outputPaths.push({
			optionName: "--mihomo-output",
			path: mihomoOutputPath,
		});
	}

	for (let leftIndex = 0; leftIndex < outputPaths.length - 1; leftIndex += 1) {
		const leftOutput = outputPaths[leftIndex] as NamedOutputPath;
		const resolvedLeftPath = resolve(leftOutput.path);

		for (
			let rightIndex = leftIndex + 1;
			rightIndex < outputPaths.length;
			rightIndex += 1
		) {
			const rightOutput = outputPaths[rightIndex] as NamedOutputPath;
			const resolvedRightPath = resolve(rightOutput.path);

			if (resolvedLeftPath === resolvedRightPath) {
				throw new Error(
					`Output paths must be different: ${leftOutput.optionName} and ${rightOutput.optionName} both resolve to ${formatResolvedPath(resolvedLeftPath)}.`,
				);
			}

			if (
				isNestedPath(resolvedLeftPath, resolvedRightPath) ||
				isNestedPath(resolvedRightPath, resolvedLeftPath)
			) {
				throw new Error(
					`Output paths must not overlap: ${leftOutput.optionName} resolves to ${formatResolvedPath(resolvedLeftPath)} and ${rightOutput.optionName} resolves to ${formatResolvedPath(resolvedRightPath)}.`,
				);
			}
		}
	}
};

export const writeTextFile = async (
	outputPath: string,
	content: string,
): Promise<void> => {
	const outputDirectory = dirname(outputPath);

	if (outputDirectory !== ".") {
		await mkdir(outputDirectory, { recursive: true });
	}

	await Bun.write(outputPath, content);
};

const isNotFoundError = (error: unknown): boolean =>
	isRecord(error) && error.code === "ENOENT";

const formatErrorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const assertTextFileTarget = async (
	outputPath: string,
	operations: WriteTextFilesOperations,
): Promise<void> => {
	try {
		const outputPathStat = await operations.stat(outputPath);

		if (outputPathStat.isDirectory()) {
			throw new Error(
				`Output path must be a file, got directory: ${formatResolvedPath(resolve(outputPath))}.`,
			);
		}
	} catch (error) {
		if (isNotFoundError(error)) {
			return;
		}

		throw error;
	}
};

const pathExists = async (
	path: string,
	operations: WriteTextFilesOperations,
): Promise<boolean> => {
	try {
		await operations.stat(path);
		return true;
	} catch (error) {
		if (isNotFoundError(error)) {
			return false;
		}

		throw error;
	}
};

const defaultWriteTextFilesOperations: WriteTextFilesOperations = {
	createTemporarySuffix: () => `${process.pid}.${randomUUID()}`,
	mkdir,
	rename,
	rm,
	stat,
	write: async (path, content) => Bun.write(path, content),
};

type PreparedTextFileWrite = {
	outputPath: string;
	temporaryPath: string;
	backupPath: string;
};

export const writeTextFiles = async (
	files: readonly { outputPath: string; content: string }[],
	operations: WriteTextFilesOperations = defaultWriteTextFilesOperations,
): Promise<void> => {
	const preparedWrites: PreparedTextFileWrite[] = [];
	const backupWrites: PreparedTextFileWrite[] = [];
	const installedOutputPaths: string[] = [];
	const temporarySuffix = operations.createTemporarySuffix();

	try {
		for (const file of files) {
			const outputDirectory = dirname(file.outputPath);

			if (outputDirectory !== ".") {
				await operations.mkdir(outputDirectory, { recursive: true });
			}
		}

		for (const file of files) {
			await assertTextFileTarget(file.outputPath, operations);
		}

		for (const [index, file] of files.entries()) {
			const temporaryPath = `${file.outputPath}.${temporarySuffix}.${index}.tmp`;
			const backupPath = `${file.outputPath}.${temporarySuffix}.${index}.backup`;

			preparedWrites.push({
				outputPath: file.outputPath,
				temporaryPath,
				backupPath,
			});
			await operations.write(temporaryPath, file.content);
		}

		for (const preparedWrite of preparedWrites) {
			if (await pathExists(preparedWrite.outputPath, operations)) {
				await operations.rename(
					preparedWrite.outputPath,
					preparedWrite.backupPath,
				);
				backupWrites.push(preparedWrite);
			}
		}

		for (const preparedWrite of preparedWrites) {
			await operations.rename(
				preparedWrite.temporaryPath,
				preparedWrite.outputPath,
			);
			installedOutputPaths.push(preparedWrite.outputPath);
		}

		await Promise.allSettled(
			backupWrites.map((preparedWrite) =>
				operations.rm(preparedWrite.backupPath, {
					force: true,
					recursive: false,
				}),
			),
		);
	} catch (error) {
		await Promise.allSettled(
			installedOutputPaths
				.reverse()
				.map((outputPath) =>
					operations.rm(outputPath, { force: true, recursive: false }),
				),
		);

		const unrestoredBackupPaths = new Set<string>();
		const restoreFailures: Error[] = [];

		for (const preparedWrite of backupWrites.reverse()) {
			await operations
				.rename(preparedWrite.backupPath, preparedWrite.outputPath)
				.catch((restoreError: unknown) => {
					unrestoredBackupPaths.add(preparedWrite.backupPath);
					restoreFailures.push(
						new Error(
							`Failed to restore ${preparedWrite.backupPath} to ${preparedWrite.outputPath}: ${formatErrorMessage(restoreError)}`,
							{ cause: restoreError },
						),
					);
				});
		}

		await Promise.allSettled([
			...preparedWrites.map((preparedWrite) =>
				operations.rm(preparedWrite.temporaryPath, {
					force: true,
					recursive: false,
				}),
			),
			...preparedWrites
				.filter(
					(preparedWrite) =>
						!unrestoredBackupPaths.has(preparedWrite.backupPath),
				)
				.map((preparedWrite) =>
					operations.rm(preparedWrite.backupPath, {
						force: true,
						recursive: false,
					}),
				),
		]);

		if (restoreFailures.length > 0) {
			throw new AggregateError(
				[error, ...restoreFailures],
				"Failed to write text files and restore one or more backups.",
			);
		}

		throw error;
	}
};

export const writeRuleSet = async (
	outputPath: string,
	ruleSet: SingBoxRuleSet,
): Promise<void> => {
	await writeTextFile(outputPath, `${JSON.stringify(ruleSet, null, "\t")}\n`);
};

const formatEntryLocation = (sourceUrl: string, lineNumber: number): string =>
	`${sourceUrl}:${lineNumber}`;

const formatUnsupportedEntrySummary = (
	unsupportedEntries: readonly UnsupportedEntry[],
): string => {
	const summaryLines = unsupportedEntries
		.slice(0, 10)
		.map(
			(entry) =>
				`- ${formatEntryLocation(entry.sourceUrl, entry.lineNumber)} => ${entry.rawLine.trim()}`,
		);

	if (unsupportedEntries.length > 10) {
		summaryLines.push(`- ... ${unsupportedEntries.length - 10} more`);
	}

	return summaryLines.join("\n");
};

export const getUsageText =
	(): string => `Usage: bun run ./src/index.ts [options] [url ...]

	Options:
	  -u, --url <url>              Add a source URL. Can be used multiple times.
	  -o, --output <path>          Output sing-box JSON file path.
	      --mihomo-output <path>   Output Mihomo domain text .lst file path.
	  -v, --version <n>            sing-box rule-set version (1-4). Default: ${DEFAULT_RULE_SET_VERSION}
	  -h, --help                   Show this help message.

If no URLs are provided, source URLs are loaded from:
	${DEFAULT_SOURCE_CONFIG_PATH}`;

const printUsage = (): void => {
	console.log(getUsageText());
};

const OPTION_ARGUMENTS = new Set([
	"-u",
	"--url",
	"-o",
	"--output",
	"--mihomo-output",
	"-v",
	"--version",
	"-h",
	"--help",
]);

const getOptionValue = (
	argv: readonly string[],
	index: number,
	argument: string,
): string => {
	const value = argv[index + 1];

	if (!value || OPTION_ARGUMENTS.has(value)) {
		throw new Error(`Missing value for ${argument}.`);
	}

	return value;
};

export const parseCliArgs = (argv: readonly string[]): CliOptions => {
	let helpRequested = false;
	let outputPath: string | undefined;
	let mihomoOutputPath: string | undefined;
	let version: RuleSetVersion = DEFAULT_RULE_SET_VERSION;
	const sourceUrls: string[] = [];

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];

		if (!argument) {
			continue;
		}

		if (argument === "-h" || argument === "--help") {
			helpRequested = true;
			continue;
		}

		if (argument === "-u" || argument === "--url") {
			const value = getOptionValue(argv, index, argument);

			sourceUrls.push(value);
			index += 1;
			continue;
		}

		if (argument === "-o" || argument === "--output") {
			const value = getOptionValue(argv, index, argument);

			outputPath = value;
			index += 1;
			continue;
		}

		if (argument === "--mihomo-output") {
			const value = getOptionValue(argv, index, argument);

			mihomoOutputPath = value;
			index += 1;
			continue;
		}

		if (argument === "-v" || argument === "--version") {
			const value = getOptionValue(argv, index, argument);

			const parsedVersion = Number.parseInt(value, 10);

			if (!isRuleSetVersion(parsedVersion)) {
				throw new Error(`Invalid sing-box rule-set version: ${value}.`);
			}

			version = parsedVersion;
			index += 1;
			continue;
		}

		if (argument.startsWith("-")) {
			throw new Error(`Unknown argument: ${argument}`);
		}

		sourceUrls.push(argument);
	}

	return {
		helpRequested,
		sourceUrls,
		outputPath,
		mihomoOutputPath,
		version,
	};
};

export const run = async (argv: readonly string[]): Promise<void> => {
	const options = parseCliArgs(argv);

	if (options.helpRequested) {
		printUsage();
		return;
	}

	const sourceUrls = await resolveSourceUrls(options.sourceUrls);
	const outputPath = options.outputPath ?? deriveOutputPath(sourceUrls);
	assertDistinctOutputPaths(outputPath, options.mihomoOutputPath);

	const fetchedSources = await Promise.all(
		sourceUrls.map((sourceUrl) => fetchSource(sourceUrl)),
	);
	const conversionResult = convertDomainLists(fetchedSources, options.version);

	if (options.mihomoOutputPath) {
		assertMihomoDomainTextSupported(conversionResult.ruleValues);
	}

	const mihomoDomainTextRuleSet = options.mihomoOutputPath
		? buildMihomoDomainTextRuleSet(conversionResult.ruleValues)
		: undefined;
	const outputFiles = [
		{
			outputPath,
			content: `${JSON.stringify(conversionResult.ruleSet, null, "\t")}\n`,
		},
	];

	if (options.mihomoOutputPath && mihomoDomainTextRuleSet !== undefined) {
		outputFiles.push({
			outputPath: options.mihomoOutputPath,
			content: mihomoDomainTextRuleSet,
		});
	}

	await writeTextFiles(outputFiles);

	const summaryLines = [
		`Fetched ${sourceUrls.length} source URL(s).`,
		`Parsed ${conversionResult.totalParsedEntries} supported entries and kept ${conversionResult.uniqueEntryCount} unique entries.`,
		`Detected ${conversionResult.duplicates.length} duplicate entries.`,
		`Wrote sing-box rule-set JSON to ${outputPath}.`,
	];

	if (options.mihomoOutputPath) {
		summaryLines.push(
			`Wrote Mihomo domain text rule-set to ${options.mihomoOutputPath}.`,
		);
	}

	console.log(summaryLines.join("\n"));

	if (conversionResult.duplicates.length > 0) {
		console.log("\nDuplicate examples:");
		for (const duplicate of conversionResult.duplicates.slice(0, 10)) {
			console.log(
				`- ${duplicate.type}:${duplicate.value} (${formatEntryLocation(duplicate.sourceUrl, duplicate.lineNumber)}; first seen at ${formatEntryLocation(duplicate.firstSeenSourceUrl, duplicate.firstSeenLineNumber)})`,
			);
		}

		if (conversionResult.duplicates.length > 10) {
			console.log(`- ... ${conversionResult.duplicates.length - 10} more`);
		}
	}

	if (conversionResult.unsupportedEntries.length > 0) {
		console.warn("\nUnsupported lines skipped:");
		console.warn(
			formatUnsupportedEntrySummary(conversionResult.unsupportedEntries),
		);
	}
};

if (import.meta.main) {
	run(Bun.argv.slice(2)).catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(message);
		process.exitCode = 1;
	});
}
