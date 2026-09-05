/**
 * Write targets in a shell command.
 *
 * The file tools are easy to police; the shell is where the boundary actually
 * leaks, because an agent told to work through Bash edits with `sed -i` and
 * heredocs instead of Write/Edit. This extracts the paths a command clearly
 * writes to, so the same ownership rule can be applied to them.
 *
 * The bias is deliberate: only report a target when it is unambiguous. A
 * missed write is a boundary the agent is trusted to respect anyway; a false
 * one blocks a build or a test run, which is worse.
 */

export interface WriteTarget {
	path: string;
	/** What in the command implied a write, for the denial message */
	reason: string;
	/**
	 * Directory the path is relative to, when the command changed directory
	 * first (`cd frontend && sed -i ... src/App.tsx`).
	 */
	cwd?: string;
}

/** Paths we cannot resolve statically, so we do not judge them. */
function isUnresolvable(token: string): boolean {
	return (
		token.length === 0 ||
		/[$`*?~\[\]{}]/.test(token) || // expansion or globbing
		token.startsWith("-") ||
		token === "/dev/null" ||
		token.startsWith("/dev/")
	);
}

function unquote(token: string): string {
	if (
		(token.startsWith('"') && token.endsWith('"') && token.length > 1) ||
		(token.startsWith("'") && token.endsWith("'") && token.length > 1)
	) {
		return token.slice(1, -1);
	}
	return token;
}

function add(
	targets: WriteTarget[],
	raw: string | undefined,
	reason: string,
	cwd: string
): void {
	if (!raw) return;
	const path = unquote(raw.trim());
	if (isUnresolvable(path)) return;
	if (targets.some((t) => t.path === path && t.cwd === (cwd || undefined))) return;
	targets.push({ path, reason, cwd: cwd || undefined });
}

/**
 * Split a command line into its individual commands, so `cd x && sed -i ...`
 * is examined piece by piece.
 */
function segments(command: string): string[] {
	return command.split(/\|\||&&|;|\n|\|/g).map((s) => s.trim()).filter(Boolean);
}

export function extractWriteTargets(command: string): WriteTarget[] {
	const targets: WriteTarget[] = [];

	// Commands routinely start with `cd somewhere`, and every relative path
	// after it means something different. Track it rather than misjudging.
	let cwd = "";

	for (const segment of segments(command)) {
		const cd = segment.match(/^cd\s+(\S+)\s*$/);
		if (cd) {
			const dir = unquote(cd[1]);
			// An unresolvable directory means every later path is a guess, so stop.
			if (isUnresolvable(dir) || dir.startsWith("/")) return targets;
			cwd = cwd ? `${cwd}/${dir}` : dir;
			continue;
		}

		// Redirection: `> file`, `>> file`. Excludes `2>`, `>&2`, `<`.
		for (const match of segment.matchAll(/(?<![0-9&])>>?\s*([^\s|&;<>]+)/g)) {
			add(targets, match[1], "shell redirection", cwd);
		}

		// tee writes every file it is given
		const tee = segment.match(/(?:^|\s)tee\b(.*)$/);
		if (tee) {
			for (const token of tee[1].split(/\s+/)) {
				if (token && !token.startsWith("-")) add(targets, token, "tee", cwd);
			}
		}

		const words = segment.split(/\s+/).filter(Boolean);
		const cmd = words[0]?.split("/").pop();
		const args = words.slice(1);
		const positional = args.filter((a) => !a.startsWith("-"));

		// In-place editors
		if (
			(cmd === "sed" || cmd === "perl" || cmd === "ruby") &&
			args.some((a) => /^-[a-zA-Z]*i/.test(a))
		) {
			// sed -i '' 's/x/y/' file  (BSD) or sed -i 's/x/y/' file (GNU):
			// the file is the last positional argument.
			add(targets, positional[positional.length - 1], `${cmd} in place`, cwd);
		}

		// Direct file mutations. cp/mv/install write their final argument;
		// rm/touch/truncate write all of theirs.
		if ((cmd === "cp" || cmd === "mv" || cmd === "install") && positional.length >= 2) {
			add(targets, positional[positional.length - 1], `${cmd} destination`, cwd);
		}

		if (cmd === "rm" || cmd === "touch" || cmd === "truncate" || cmd === "unlink") {
			for (const token of positional) add(targets, token, cmd, cwd);
		}

		// dd of=path
		for (const match of segment.matchAll(/\bof=([^\s]+)/g)) {
			add(targets, match[1], "dd output", cwd);
		}

		// Common "apply a patch" forms
		if (cmd === "patch") {
			for (const token of positional) add(targets, token, "patch", cwd);
		}
	}

	return targets;
}
