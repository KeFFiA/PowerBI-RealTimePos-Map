/**
 * Build helper for the Aircraft Map Visual.
 *
 * On each run it:
 *   1. Bumps the visual version (last segment of major.minor.patch.build) in both
 *      pbiviz.json and package.json, so every uploaded package shows a new version
 *      in Power BI and is easy to tell apart.
 *   2. Runs `pbiviz package`.
 *   3. Copies the produced .pbiviz (named <guid>.<version>.pbiviz by the tooling)
 *      into releases/ under a short, readable name — WITHOUT deleting older builds,
 *      so the full release history is preserved.
 *
 * Usage:
 *   node tools/build.mjs            bump build segment, package, archive
 *   node tools/build.mjs --no-bump  package the current version as-is
 *
 * The visual GUID is intentionally left untouched: changing it would make Power BI
 * treat the visual as a different one and drop it from existing reports.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_NAME = "AircraftRealTimePosMap";

const pbivizPath = path.join(ROOT, "pbiviz.json");
const packagePath = path.join(ROOT, "package.json");
const releasesDir = path.join(ROOT, "releases");
const distDir = path.join(ROOT, "dist");

const noBump = process.argv.includes("--no-bump");

/** Read a JSON file, returning both the parsed value and a writer that preserves 4-space indentation. */
function readJson(file) {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    const write = (next) => fs.writeFileSync(file, JSON.stringify(next, null, 4) + "\n", "utf8");
    return { value, write };
}

/** Increment the last numeric segment of a dotted version (e.g. 1.0.29.0 -> 1.0.29.1). */
function bumpVersion(version) {
    const parts = String(version).split(".");
    const last = parts.length - 1;
    const n = Number(parts[last]);
    parts[last] = String((Number.isFinite(n) ? n : 0) + 1);
    return parts.join(".");
}

const pbiviz = readJson(pbivizPath);
const pkg = readJson(packagePath);

const currentVersion = pbiviz.value.visual.version;
const version = noBump ? currentVersion : bumpVersion(currentVersion);

if (!noBump) {
    pbiviz.value.visual.version = version;
    pbiviz.write(pbiviz.value);
    pkg.value.version = version;
    pkg.write(pkg.value);
    console.log(`Version bumped: ${currentVersion} -> ${version}`);
} else {
    console.log(`Packaging current version: ${version}`);
}

// Run `pbiviz package` via the local CLI entry (works whether launched by npm or directly).
const pbivizCli = path.join(ROOT, "node_modules", "powerbi-visuals-tools", "bin", "pbiviz.js");
execFileSync(process.execPath, [pbivizCli, "package"], { cwd: ROOT, stdio: "inherit" });

// Archive the produced package under a short, versioned name, keeping all prior builds.
const guid = pbiviz.value.visual.guid;
const built = path.join(distDir, `${guid}.${version}.pbiviz`);
if (!fs.existsSync(built)) {
    console.error(`Expected built package not found: ${built}`);
    process.exit(1);
}

fs.mkdirSync(releasesDir, { recursive: true });
const archived = path.join(releasesDir, `${RELEASE_NAME}.${version}.pbiviz`);
fs.copyFileSync(built, archived);

console.log(`\nArchived: releases/${RELEASE_NAME}.${version}.pbiviz`);
