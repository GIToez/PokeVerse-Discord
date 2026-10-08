import { main } from "./cli.js";

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`\nERROR: ${(error as Error)?.stack ?? String(error)}\n`);
    process.exit(1);
  },
);
