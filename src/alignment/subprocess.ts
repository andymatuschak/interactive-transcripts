import { spawn, ChildProcess } from "child_process";

export interface SubprocessResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

/**
 * Get an enhanced PATH that includes common binary locations.
 * GUI apps like Obsidian don't inherit terminal PATH.
 */
function getEnhancedPath(): string {
	const currentPath = process.env.PATH || "";
	const additionalPaths = [
		"/opt/homebrew/bin",      // macOS ARM Homebrew
		"/usr/local/bin",         // macOS Intel Homebrew / common
		"/usr/bin",
		"/bin",
		`${process.env.HOME}/.local/bin`,
		`${process.env.HOME}/.cargo/bin`,
	];

	// Add paths that aren't already present
	const pathSet = new Set(currentPath.split(":"));
	for (const p of additionalPaths) {
		pathSet.add(p);
	}

	return Array.from(pathSet).join(":");
}

export interface SubprocessOptions {
	cwd?: string;
	env?: Record<string, string>;
	timeout?: number;
	onStdout?: (data: string) => void;
	onStderr?: (data: string) => void;
	/** Abort signal to cancel the subprocess. */
	signal?: AbortSignal;
}

/**
 * Run a subprocess and return the result.
 * Supports abort via AbortSignal, timeout, and streaming output callbacks.
 */
export function runSubprocess(
	command: string,
	args: string[],
	options: SubprocessOptions = {}
): Promise<SubprocessResult> {
	return new Promise((resolve, reject) => {
		const { cwd, env, timeout, onStdout, onStderr, signal } = options;

		// Check if already aborted
		if (signal?.aborted) {
			reject(new Error("Aborted"));
			return;
		}

		const child: ChildProcess = spawn(command, args, {
			cwd,
			env: { ...process.env, PATH: getEnhancedPath(), ...env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let killed = false;

		// Handle abort signal
		const onAbort = () => {
			if (!killed) {
				killed = true;
				child.kill("SIGTERM");
				reject(new Error("Aborted"));
			}
		};
		signal?.addEventListener("abort", onAbort);

		// Set up timeout
		let timeoutId: NodeJS.Timeout | undefined;
		if (timeout) {
			timeoutId = setTimeout(() => {
				killed = true;
				child.kill("SIGTERM");
				reject(new Error(`Process timed out after ${timeout}ms`));
			}, timeout);
		}

		child.stdout?.on("data", (data: Buffer) => {
			const text = data.toString();
			stdout += text;
			onStdout?.(text);
		});

		child.stderr?.on("data", (data: Buffer) => {
			const text = data.toString();
			stderr += text;
			onStderr?.(text);
		});

		child.on("error", (err) => {
			if (timeoutId) clearTimeout(timeoutId);
			signal?.removeEventListener("abort", onAbort);
			reject(err);
		});

		child.on("close", (exitCode) => {
			if (timeoutId) clearTimeout(timeoutId);
			signal?.removeEventListener("abort", onAbort);
			if (!killed) {
				resolve({ stdout, stderr, exitCode });
			}
		});
	});
}

/**
 * Check if uv is available.
 */
export async function checkUv(): Promise<{ available: boolean; version?: string }> {
	try {
		const result = await runSubprocess("uv", ["--version"], { timeout: 5000 });
		if (result.exitCode === 0) {
			const version = result.stdout.trim();
			return { available: true, version };
		}
		return { available: false };
	} catch {
		return { available: false };
	}
}
