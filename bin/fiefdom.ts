#!/usr/bin/env -S node --no-warnings --experimental-strip-types
/**
 * Entry point for the fiefdom CLI (the Claude Code adapter, plus the memory
 * commands both harnesses' fief agents call).
 */

import { run } from "../adapters/claude/cli.ts";

run(process.argv.slice(2)).catch((err) => {
	console.error(`fiefdom: ${err?.stack ?? err}`);
	process.exit(1);
});
