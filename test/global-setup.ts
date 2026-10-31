import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/**
 * Tests run against a real Postgres. Use TEST_DATABASE_URL (e.g. the docker compose db or a CI service),
 * or, if unset, boot a throwaway embedded Postgres so `npm test` works with zero setup.
 */
export default async function setup(project: TestProject) {
  if (process.env.TEST_DATABASE_URL) {
    project.provide("databaseUrl", process.env.TEST_DATABASE_URL);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "lep-pg-"));
  const port = 54000 + Math.floor(Math.random() * 900);
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port, persistent: false, onLog: () => {}, onError: () => {} });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("events_test");
  project.provide("databaseUrl", `postgres://postgres:postgres@localhost:${port}/events_test`);
  return async () => {
    await pg.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}
