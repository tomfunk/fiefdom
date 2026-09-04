/**
 * Repository analysis for fief discovery
 *
 * Examines a repository structure and proposes a division into fiefs
 * based on directory structure, package boundaries, and common patterns.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { FiefConfig } from "./config.ts";
import { FIEFDOM_DIR, defaultMemoryPath, defaultPersonaPath } from "./paths.ts";
import { gitIgnoredNames } from "./gitignore.ts";

export interface AnalysisResult {
	proposedFiefs: ProposedFief[];
	orphanPaths: string[];
	stats: RepoStats;
	confidence: "high" | "medium" | "low";
	reasoning: string;
}

export interface ProposedFief {
	id: string;
	paths: string[];
	description: string;
	fileCount: number;
	suggestedPersona: string;
}

export interface RepoStats {
	totalFiles: number;
	totalDirs: number;
	languages: Record<string, number>;
	hasMonorepo: boolean;
	frameworks: string[];
}

// Common directory patterns that suggest fief boundaries
const FIEF_PATTERNS: Record<string, { description: string; persona: string }> = {
	frontend: {
		description: "Frontend/client-side code",
		persona: `You are the frontend specialist. You handle UI components, state management, and user interactions.

## Focus Areas
- React/Vue/Angular components
- State management (Redux, Zustand, Pinia, etc.)
- Styling (CSS, Tailwind, styled-components)
- Client-side routing
- API integration from the frontend perspective`,
	},
	backend: {
		description: "Backend/server-side code",
		persona: `You are the backend specialist. You handle API endpoints, business logic, and data access.

## Focus Areas
- API routes and controllers
- Business logic and services
- Database queries and ORM usage
- Authentication and authorization
- External service integrations`,
	},
	api: {
		description: "API layer",
		persona: `You are the API specialist. You handle endpoint definitions, request/response handling, and API contracts.

## Focus Areas
- REST/GraphQL endpoint design
- Request validation
- Response formatting
- API versioning
- Rate limiting and caching`,
	},
	services: {
		description: "Microservices or service modules",
		persona: `You are the services specialist. You handle individual service implementations and inter-service communication.

## Focus Areas
- Service boundaries and contracts
- Message queues and event handling
- Service-to-service communication
- Health checks and monitoring`,
	},
	shared: {
		description: "Shared code and utilities",
		persona: `You are the shared code specialist. You handle code that's used across multiple parts of the application.

## Focus Areas
- Shared types and interfaces
- Utility functions
- Common constants
- Cross-cutting concerns`,
	},
	infra: {
		description: "Infrastructure and DevOps",
		persona: `You are the infrastructure specialist. You handle deployment, CI/CD, and infrastructure-as-code.

## Focus Areas
- Docker and containerization
- CI/CD pipelines
- Cloud infrastructure (Terraform, CloudFormation)
- Monitoring and logging configuration`,
	},
	mobile: {
		description: "Mobile application code",
		persona: `You are the mobile specialist. You handle native and cross-platform mobile development.

## Focus Areas
- React Native / Flutter / Swift / Kotlin
- Mobile-specific UI patterns
- Platform-specific APIs
- App store requirements`,
	},
	docs: {
		description: "Documentation",
		persona: `You are the documentation specialist. You handle technical docs, API docs, and guides.

## Focus Areas
- README files and guides
- API documentation
- Architecture decision records
- User documentation`,
	},
	tests: {
		description: "Test suites",
		persona: `You are the testing specialist. You handle test infrastructure and test suites.

## Focus Areas
- Unit tests
- Integration tests
- E2E tests
- Test utilities and fixtures`,
	},
};

// Directories to ignore during analysis
const IGNORE_DIRS = new Set([
	"node_modules",
	".git",
	".pi",
	"dist",
	"build",
	"out",
	".next",
	".nuxt",
	"coverage",
	".cache",
	"__pycache__",
	".venv",
	"venv",
	"vendor",
	"target",
]);

// File extensions to language mapping
const EXTENSION_LANGUAGE: Record<string, string> = {
	".ts": "TypeScript",
	".tsx": "TypeScript",
	".js": "JavaScript",
	".jsx": "JavaScript",
	".py": "Python",
	".go": "Go",
	".rs": "Rust",
	".java": "Java",
	".kt": "Kotlin",
	".swift": "Swift",
	".rb": "Ruby",
	".php": "PHP",
	".cs": "C#",
	".cpp": "C++",
	".c": "C",
	".vue": "Vue",
	".svelte": "Svelte",
};

/**
 * Analyze a repository and propose fief divisions
 */
export async function analyzeRepository(repoRoot: string): Promise<AnalysisResult> {
	const stats: RepoStats = {
		totalFiles: 0,
		totalDirs: 0,
		languages: {},
		hasMonorepo: false,
		frameworks: [],
	};

	const topLevelDirs: Map<string, { files: number; subdirs: string[] }> = new Map();
	const allPaths: string[] = [];

	// Scan repository structure
	await scanDirectory(repoRoot, "", topLevelDirs, allPaths, stats);

	// Drop anything the repository itself ignores: build output is not a fief.
	const ignored = gitIgnoredNames(repoRoot, [...topLevelDirs.keys()]);
	for (const name of ignored) {
		const entry = topLevelDirs.get(name);
		if (!entry) continue;
		topLevelDirs.delete(name);
		stats.totalFiles -= entry.files;
	}

	// Detect monorepo
	const packagesDir = path.join(repoRoot, "packages");
	const appsDir = path.join(repoRoot, "apps");
	stats.hasMonorepo =
		fs.existsSync(packagesDir) ||
		fs.existsSync(appsDir) ||
		fs.existsSync(path.join(repoRoot, "lerna.json")) ||
		fs.existsSync(path.join(repoRoot, "pnpm-workspace.yaml"));

	// Detect frameworks
	stats.frameworks = detectFrameworks(repoRoot);

	// Propose fiefs based on structure
	const proposedFiefs: ProposedFief[] = [];
	const coveredPaths = new Set<string>();

	// Strategy 1: Monorepo packages
	if (stats.hasMonorepo) {
		const packageFiefs = await analyzeMonorepo(repoRoot, stats);
		for (const fief of packageFiefs) {
			proposedFiefs.push(fief);
			fief.paths.forEach((p) => coveredPaths.add(p.replace("/**", "")));
		}
	}

	// Strategy 2: Known directory patterns
	for (const [dirName, dirInfo] of topLevelDirs) {
		if (coveredPaths.has(dirName)) continue;

		const pattern = findMatchingPattern(dirName);
		if (pattern) {
			proposedFiefs.push({
				id: dirName,
				paths: [`${dirName}/**`],
				description: pattern.description,
				fileCount: dirInfo.files,
				suggestedPersona: pattern.persona,
			});
			coveredPaths.add(dirName);
		}
	}

	// Strategy 3: Large directories that might need their own fief
	for (const [dirName, dirInfo] of topLevelDirs) {
		if (coveredPaths.has(dirName)) continue;
		if (IGNORE_DIRS.has(dirName)) continue;

		// If it has significant files, suggest it as a fief
		if (dirInfo.files > 10) {
			const guessedType = guessDirectoryType(dirName, dirInfo.subdirs);
			proposedFiefs.push({
				id: dirName,
				paths: [`${dirName}/**`],
				description: guessedType.description,
				fileCount: dirInfo.files,
				suggestedPersona: guessedType.persona,
			});
			coveredPaths.add(dirName);
		}
	}

	// Find orphan paths (not covered by any fief)
	const orphanPaths = Array.from(topLevelDirs.keys()).filter(
		(dir) => !coveredPaths.has(dir) && !IGNORE_DIRS.has(dir)
	);

	// Calculate confidence
	const confidence = calculateConfidence(proposedFiefs, stats, orphanPaths);

	// Generate reasoning
	const reasoning = generateReasoning(proposedFiefs, stats, orphanPaths);

	return {
		proposedFiefs,
		orphanPaths,
		stats,
		confidence,
		reasoning,
	};
}

/**
 * Recursively scan a directory
 */
async function scanDirectory(
	root: string,
	relativePath: string,
	topLevelDirs: Map<string, { files: number; subdirs: string[] }>,
	allPaths: string[],
	stats: RepoStats
): Promise<void> {
	const fullPath = relativePath ? path.join(root, relativePath) : root;

	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(fullPath, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const entryRelPath = relativePath
			? path.join(relativePath, entry.name)
			: entry.name;

		if (entry.isDirectory()) {
			if (IGNORE_DIRS.has(entry.name)) continue;

			stats.totalDirs++;

			// Track top-level directories
			if (!relativePath) {
				topLevelDirs.set(entry.name, { files: 0, subdirs: [] });
			} else {
				const topLevel = relativePath.split(path.sep)[0];
				const dirInfo = topLevelDirs.get(topLevel);
				if (dirInfo) {
					dirInfo.subdirs.push(entry.name);
				}
			}

			await scanDirectory(root, entryRelPath, topLevelDirs, allPaths, stats);
		} else if (entry.isFile()) {
			stats.totalFiles++;
			allPaths.push(entryRelPath);

			// Count files in top-level dir
			if (relativePath) {
				const topLevel = relativePath.split(path.sep)[0];
				const dirInfo = topLevelDirs.get(topLevel);
				if (dirInfo) {
					dirInfo.files++;
				}
			}

			// Track language
			const ext = path.extname(entry.name).toLowerCase();
			const lang = EXTENSION_LANGUAGE[ext];
			if (lang) {
				stats.languages[lang] = (stats.languages[lang] || 0) + 1;
			}
		}
	}
}

/**
 * Analyze monorepo packages
 */
async function analyzeMonorepo(
	repoRoot: string,
	stats: RepoStats
): Promise<ProposedFief[]> {
	const fiefs: ProposedFief[] = [];
	const packageDirs = ["packages", "apps", "libs", "modules"];

	for (const packageDir of packageDirs) {
		const packagesPath = path.join(repoRoot, packageDir);
		if (!fs.existsSync(packagesPath)) continue;

		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(packagesPath, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (IGNORE_DIRS.has(entry.name)) continue;

			const packagePath = path.join(packagesPath, entry.name);
			const packageJson = path.join(packagePath, "package.json");

			let description = `${packageDir}/${entry.name} package`;
			let persona = "";

			// Try to get description from package.json
			if (fs.existsSync(packageJson)) {
				try {
					const pkg = JSON.parse(fs.readFileSync(packageJson, "utf-8"));
					if (pkg.description) {
						description = pkg.description;
					}
				} catch {
					// Ignore
				}
			}

			// Guess type based on name
			const guessed = guessDirectoryType(entry.name, []);
			persona = guessed.persona;

			// Count files
			let fileCount = 0;
			try {
				const files = await countFiles(packagePath);
				fileCount = files;
			} catch {
				// Ignore
			}

			fiefs.push({
				id: `${packageDir}-${entry.name}`,
				paths: [`${packageDir}/${entry.name}/**`],
				description,
				fileCount,
				suggestedPersona: persona,
			});
		}
	}

	return fiefs;
}

/**
 * Count files in a directory recursively
 */
async function countFiles(dir: string): Promise<number> {
	let count = 0;

	async function scan(currentDir: string) {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (IGNORE_DIRS.has(entry.name)) continue;

			if (entry.isDirectory()) {
				await scan(path.join(currentDir, entry.name));
			} else if (entry.isFile()) {
				count++;
			}
		}
	}

	await scan(dir);
	return count;
}

/**
 * Find a matching pattern for a directory name
 */
function findMatchingPattern(
	dirName: string
): { description: string; persona: string } | null {
	const normalized = dirName.toLowerCase();

	// Direct match
	if (FIEF_PATTERNS[normalized]) {
		return FIEF_PATTERNS[normalized];
	}

	// Partial matches
	const patterns: [string[], string][] = [
		[["front", "client", "web", "ui", "app"], "frontend"],
		[["back", "server", "api"], "backend"],
		[["service", "svc"], "services"],
		[["share", "common", "lib", "util", "core"], "shared"],
		[["infra", "deploy", "ci", "cd", "k8s", "terraform"], "infra"],
		[["mobile", "ios", "android", "native"], "mobile"],
		[["doc", "readme"], "docs"],
		[["test", "spec", "e2e"], "tests"],
	];

	for (const [keywords, patternKey] of patterns) {
		if (keywords.some((kw) => normalized.includes(kw))) {
			return FIEF_PATTERNS[patternKey];
		}
	}

	return null;
}

/**
 * Guess directory type based on name and subdirectories
 */
function guessDirectoryType(
	dirName: string,
	subdirs: string[]
): { description: string; persona: string } {
	const pattern = findMatchingPattern(dirName);
	if (pattern) return pattern;

	// Check subdirs for hints
	const subdirsLower = subdirs.map((s) => s.toLowerCase());
	if (
		subdirsLower.some((s) =>
			["components", "hooks", "pages", "views"].includes(s)
		)
	) {
		return FIEF_PATTERNS.frontend;
	}
	if (
		subdirsLower.some((s) =>
			["routes", "controllers", "models", "middleware"].includes(s)
		)
	) {
		return FIEF_PATTERNS.backend;
	}

	// Generic fallback
	return {
		description: `${dirName} module`,
		persona: `You are the ${dirName} specialist. You handle code in the ${dirName}/ directory.

## Focus Areas
- All code within ${dirName}/
- Related tests and documentation
- Integration with other parts of the system`,
	};
}

/**
 * Detect frameworks used in the repo
 */
function detectFrameworks(repoRoot: string): string[] {
	const frameworks: string[] = [];

	const packageJsonPath = path.join(repoRoot, "package.json");
	if (fs.existsSync(packageJsonPath)) {
		try {
			const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
			const deps = {
				...pkg.dependencies,
				...pkg.devDependencies,
			};

			if (deps.react) frameworks.push("React");
			if (deps.vue) frameworks.push("Vue");
			if (deps.angular || deps["@angular/core"]) frameworks.push("Angular");
			if (deps.svelte) frameworks.push("Svelte");
			if (deps.next) frameworks.push("Next.js");
			if (deps.nuxt) frameworks.push("Nuxt");
			if (deps.express) frameworks.push("Express");
			if (deps.fastify) frameworks.push("Fastify");
			if (deps.nestjs || deps["@nestjs/core"]) frameworks.push("NestJS");
			if (deps.prisma || deps["@prisma/client"]) frameworks.push("Prisma");
		} catch {
			// Ignore
		}
	}

	// Python
	if (
		fs.existsSync(path.join(repoRoot, "requirements.txt")) ||
		fs.existsSync(path.join(repoRoot, "pyproject.toml"))
	) {
		frameworks.push("Python");
	}

	// Go
	if (fs.existsSync(path.join(repoRoot, "go.mod"))) {
		frameworks.push("Go");
	}

	// Rust
	if (fs.existsSync(path.join(repoRoot, "Cargo.toml"))) {
		frameworks.push("Rust");
	}

	return frameworks;
}

/**
 * Calculate confidence in the analysis
 */
function calculateConfidence(
	fiefs: ProposedFief[],
	stats: RepoStats,
	orphans: string[]
): "high" | "medium" | "low" {
	// High confidence if we have clear structure
	if (
		fiefs.length >= 2 &&
		fiefs.length <= 6 &&
		orphans.length <= 2 &&
		(stats.hasMonorepo || fiefs.every((f) => f.fileCount > 5))
	) {
		return "high";
	}

	// Low confidence if too few or too many fiefs, or lots of orphans
	if (fiefs.length === 0 || fiefs.length > 10 || orphans.length > 5) {
		return "low";
	}

	return "medium";
}

/**
 * Generate human-readable reasoning for the proposal
 */
function generateReasoning(
	fiefs: ProposedFief[],
	stats: RepoStats,
	orphans: string[]
): string {
	const parts: string[] = [];

	// Repository overview
	parts.push(
		`Found ${stats.totalFiles} files in ${stats.totalDirs} directories.`
	);

	if (stats.hasMonorepo) {
		parts.push("Detected monorepo structure.");
	}

	if (stats.frameworks.length > 0) {
		parts.push(`Frameworks detected: ${stats.frameworks.join(", ")}.`);
	}

	// Fief summary
	if (fiefs.length > 0) {
		parts.push(
			`\nProposing ${fiefs.length} fiefs based on directory structure:`
		);
		for (const fief of fiefs) {
			parts.push(`  • ${fief.id}: ${fief.description} (${fief.fileCount} files)`);
		}
	}

	// Orphans
	if (orphans.length > 0) {
		parts.push(
			`\nUnassigned directories: ${orphans.join(", ")}. These may need manual assignment or a new fief.`
		);
	}

	return parts.join("\n");
}

/**
 * Generate config file content from analysis
 */
export function generateConfigFromAnalysis(
	analysis: AnalysisResult,
	stateDirName: string = FIEFDOM_DIR
): { fiefs: FiefConfig[]; personas: Map<string, string> } {
	const fiefs: FiefConfig[] = analysis.proposedFiefs.map((fief) => ({
		id: fief.id,
		paths: fief.paths,
		persona: defaultPersonaPath(stateDirName, fief.id),
		memory: defaultMemoryPath(stateDirName, fief.id),
		description: fief.description,
	}));

	const personas = new Map<string, string>();
	for (const fief of analysis.proposedFiefs) {
		personas.set(fief.id, fief.suggestedPersona);
	}

	return { fiefs, personas };
}
