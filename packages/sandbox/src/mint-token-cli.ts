import { main } from "./mint-token.js";

main(process.argv.slice(2), process.env).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
