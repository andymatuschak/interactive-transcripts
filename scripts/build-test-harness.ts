import { build } from "bun";

const result = await build({
	entrypoints: ["test-harness/test-entry.ts"],
	outdir: "test-harness",
	naming: "bundle.js",
	format: "esm",
	target: "browser",
	external: [
		"@codemirror/state",
		"@codemirror/view",
		"@codemirror/commands",
		"obsidian",
	],
	sourcemap: "inline",
});

if (!result.success) {
	console.error("Build failed:", result.logs);
	process.exit(1);
}

console.log("Test harness bundle built!");
