// Bundles the bot into a single file (dist/bot.cjs) so the distributions only need node.
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/bot.cjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  legalComments: "linked",
  // Optional native accelerators of discord.js/ws; the bot works without them.
  external: ["zlib-sync", "bufferutil", "utf-8-validate", "@discordjs/opus", "ffmpeg-static"],
  define: { "process.env.POKEVERSE_BOT_VERSION": JSON.stringify(pkg.version) },
  logLevel: "info",
});
