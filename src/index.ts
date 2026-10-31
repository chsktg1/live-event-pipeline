import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { createPool, migrate, waitForDb } from "./db.js";

async function main() {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";
  const db = createPool();
  await waitForDb(db);
  await migrate(db);

  const app = buildApp({ db, logger: true, webDir: fileURLToPath(new URL("../web/dist", import.meta.url)) });
  await app.listen({ port, host });

  const shutdown = async () => {
    await app.close();
    await db.end();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
