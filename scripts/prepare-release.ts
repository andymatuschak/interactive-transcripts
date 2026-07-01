import { cp, mkdir, readFile, rm } from "fs/promises";
import { join } from "path";
import { spawnSync } from "child_process";

const manifest = JSON.parse(await readFile("manifest.json", "utf8")) as { id: string };
const pluginId = manifest.id;
const outDir = join("dist", pluginId);

const rootFiles = ["main.js", "manifest.json", "styles.css"];
const pythonFiles = ["pyproject.toml", "uv.lock", "speechServer.py"];

await rm("dist", { recursive: true, force: true });
await mkdir(join(outDir, "python"), { recursive: true });

for (const file of rootFiles) {
	await cp(file, join(outDir, file));
}

for (const file of pythonFiles) {
	await cp(join("python", file), join(outDir, "python", file));
}

const zipResult = spawnSync("zip", ["-qr", `${pluginId}.zip`, pluginId], {
	cwd: "dist",
	encoding: "utf8",
});
if (zipResult.status !== 0) {
	throw new Error(`Failed to create release archive: ${zipResult.stderr}`);
}

console.debug(`Prepared release folder: ${outDir}`);
console.debug(`Prepared release archive: ${join("dist", `${pluginId}.zip`)}`);
