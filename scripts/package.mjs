// Builds the distributable packages:
//   node scripts/package.mjs windows   -> builds/dev/pokeverse-discord-dev-windows-x64[.zip]
//   node scripts/package.mjs linux     -> builds/production/pokeverse-discord-linux-x64[.tar.gz]
//
// Both contain the bundled bot, an official Node.js runtime (MIT licensed, with its
// LICENSE file), third-party licenses, example configuration and start scripts.
// They never contain .env files, tokens or secrets.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];
if (target !== "windows" && target !== "linux") {
  console.error("Usage: node scripts/package.mjs windows|linux [--skip-node]");
  process.exit(2);
}
const skipNode = process.argv.includes("--skip-node");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const nodeVersion = process.env.NODE_DIST_VERSION ?? process.version;
const cacheDir = join(root, ".cache", "node");

const layout =
  target === "windows"
    ? { outDir: join(root, "builds", "dev"), name: "pokeverse-discord-dev-windows-x64", profile: "development" }
    : { outDir: join(root, "builds", "production"), name: "pokeverse-discord-linux-x64", profile: "production" };
const stage = join(layout.outDir, layout.name);

function log(message) {
  console.log(`[package] ${message}`);
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function download(url, file) {
  if (existsSync(file)) {
    return;
  }
  log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}): ${url}`);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}

async function verifiedNodeFile(relativePath) {
  const sums = join(cacheDir, nodeVersion, "SHASUMS256.txt");
  await download(`https://nodejs.org/dist/${nodeVersion}/SHASUMS256.txt`, sums);
  const expected = readFileSync(sums, "utf8")
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === relativePath)?.[0];
  if (!expected) {
    throw new Error(`No checksum for ${relativePath} in Node.js ${nodeVersion}`);
  }
  const file = join(cacheDir, nodeVersion, relativePath);
  await download(`https://nodejs.org/dist/${nodeVersion}/${relativePath}`, file);
  const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (actual !== expected) {
    rmSync(file);
    throw new Error(`Checksum mismatch for ${relativePath}`);
  }
  return file;
}

async function addNodeRuntime() {
  const nodeDir = join(stage, "node");
  mkdirSync(nodeDir, { recursive: true });
  if (target === "windows") {
    cpSync(await verifiedNodeFile("win-x64/node.exe"), join(nodeDir, "node.exe"));
    const license = join(cacheDir, nodeVersion, "LICENSE");
    await download(`https://raw.githubusercontent.com/nodejs/node/${nodeVersion}/LICENSE`, license);
    cpSync(license, join(nodeDir, "LICENSE"));
  } else {
    const archive = await verifiedNodeFile(`node-${nodeVersion}-linux-x64.tar.xz`);
    const extractDir = join(cacheDir, nodeVersion, "linux-x64");
    if (!existsSync(extractDir)) {
      mkdirSync(extractDir, { recursive: true });
      execFileSync("tar", ["-xJf", archive, "-C", extractDir, "--strip-components=1"]);
    }
    mkdirSync(join(nodeDir, "bin"), { recursive: true });
    cpSync(join(extractDir, "bin", "node"), join(nodeDir, "bin", "node"));
    chmodSync(join(nodeDir, "bin", "node"), 0o755);
    cpSync(join(extractDir, "LICENSE"), join(nodeDir, "LICENSE"));
  }
  log(`Added Node.js ${nodeVersion} runtime`);
}

/** Collects name, version, license and license text of every package that ends up in the bundle. */
function thirdPartyLicenses(metafile) {
  const packages = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const match = /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(input);
    if (!match) {
      continue;
    }
    const dir = join(root, input.slice(0, input.indexOf(match[0]) + match[0].length));
    if (!packages.has(dir) && existsSync(join(dir, "package.json"))) {
      packages.set(dir, JSON.parse(readFileSync(join(dir, "package.json"), "utf8")));
    }
  }
  const sections = [];
  for (const [dir, info] of [...packages].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    const licenseFile = readdirSync(dir).find((file) => /^(licen[cs]e|copying)/i.test(file));
    const text = licenseFile ? readFileSync(join(dir, licenseFile), "utf8").trim() : `License: ${info.license ?? "unknown"}`;
    sections.push(`${info.name}@${info.version} (${info.license ?? "unknown"})\n${"-".repeat(60)}\n${text}\n`);
  }
  return `Third-party software included in bot/bot.cjs\n${"=".repeat(60)}\n\n${sections.join("\n")}`;
}

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

/** Refuses to produce a package that contains configuration files with real values. */
function assertNoSecrets() {
  const forbidden = [];
  const secrets = [process.env.DISCORD_TOKEN, process.env.BRIDGE_SECRET].filter((value) => value && value.length >= 8);
  for (const file of listFiles(stage)) {
    const name = basename(file);
    if (name.startsWith(".env") && !name.endsWith(".example")) {
      forbidden.push(relative(stage, file));
    }
    if (name === "config.local.lua" || /^state\..*\.json$/.test(name)) {
      forbidden.push(relative(stage, file));
    }
    if (secrets.length > 0 && statSync(file).size < 50 * 1024 * 1024) {
      const content = readFileSync(file);
      if (secrets.some((secret) => content.includes(secret))) {
        forbidden.push(`${relative(stage, file)} (contains a secret value)`);
      }
    }
  }
  if (forbidden.length > 0) {
    throw new Error(`Refusing to package secrets: ${forbidden.join(", ")}`);
  }
}

/** Minimal ZIP writer (deflate), so no zip tool is needed on any platform. */
function writeZip(sourceDir, zipFile, prefix) {
  const files = listFiles(sourceDir);
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const file of files) {
    const name = Buffer.from(`${prefix}/${relative(sourceDir, file).split("\\").join("/")}`, "utf8");
    const data = readFileSync(file);
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, compressed);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(dosTime, 12);
    header.writeUInt16LE(dosDate, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralSize = central.reduce((size, buffer) => size + buffer.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(zipFile, Buffer.concat([...chunks, ...central, end]));
}

async function main() {
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, "bot"), { recursive: true });

  const result = await build({
    entryPoints: [join(root, "src", "index.ts")],
    outfile: join(stage, "bot", "bot.cjs"),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    sourcemap: true,
    metafile: true,
    legalComments: "none",
    external: ["zlib-sync", "bufferutil", "utf-8-validate", "@discordjs/opus", "ffmpeg-static"],
    logLevel: "warning",
  });
  writeFileSync(join(stage, "THIRD_PARTY_LICENSES.txt"), thirdPartyLicenses(result.metafile));

  const scripts = join(root, "scripts", target);
  cpSync(scripts, stage, { recursive: true });
  cpSync(join(root, `.env.${layout.profile}.example`), join(stage, `.env.${layout.profile}.example`));
  writeFileSync(
    join(stage, "VERSION.json"),
    JSON.stringify({ name: pkg.name, version: pkg.version, profile: layout.profile, commit: gitCommit(), node: nodeVersion, builtAt: new Date().toISOString() }, null, 2) + "\n",
  );
  if (!skipNode) {
    await addNodeRuntime();
  }
  if (target === "linux") {
    for (const file of listFiles(stage).filter((path) => path.endsWith(".sh"))) {
      chmodSync(file, 0o755);
    }
  }
  assertNoSecrets();

  if (target === "windows") {
    const zip = `${stage}.zip`;
    writeZip(stage, zip, layout.name);
    log(`Wrote ${relative(root, zip)} (${(statSync(zip).size / 1024 / 1024).toFixed(1)} MB)`);
  } else {
    const tarball = `${stage}.tar.gz`;
    execFileSync("tar", ["-czf", tarball, "-C", layout.outDir, layout.name]);
    log(`Wrote ${relative(root, tarball)} (${(statSync(tarball).size / 1024 / 1024).toFixed(1)} MB)`);
  }
  log(`Staged ${relative(root, stage)}`);
}

main().catch((error) => {
  console.error(`[package] ${error.message}`);
  process.exit(1);
});
