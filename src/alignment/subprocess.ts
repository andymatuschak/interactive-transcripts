import { spawn, ChildProcess } from "child_process";

export interface SubprocessResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

export interface SubprocessOptions {
	cwd?: string;
	env?: Record<string, string>;
	timeout?: number;
	onStdout?: (data: string) => void;
	onStderr?: (data: string) => void;
}

/**
 * Run a subprocess and return the result.
 */
export function runSubprocess(
	command: string,
	args: string[],
	options: SubprocessOptions = {}
): Promise<SubprocessResult> {
	return new Promise((resolve, reject) => {
		const { cwd, env, timeout, onStdout, onStderr } = options;

		const child: ChildProcess = spawn(command, args, {
			cwd,
			env: { ...process.env, ...env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let killed = false;

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
			reject(err);
		});

		child.on("close", (exitCode) => {
			if (timeoutId) clearTimeout(timeoutId);
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
