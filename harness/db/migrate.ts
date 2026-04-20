#!/usr/bin/env -S deno run --allow-all
/**
 * Apply the harness schema.sql to a target postgres database.
 *
 *   deno run --allow-all harness/db/migrate.ts postgres://localhost/scaffold_harness
 */

import postgres from 'postgres';

async function main(): Promise<void> {
  const url = Deno.args[0] ?? 'postgres://localhost/scaffold_harness';
  const schemaPath = new URL('./schema.sql', import.meta.url).pathname;
  const schema = await Deno.readTextFile(schemaPath);

  const sql = postgres(url, { max: 1 });
  try {
    await sql.unsafe(schema);
    console.log(`Schema applied to ${url}`);
  } finally {
    await sql.end();
  }
}

if (import.meta.main) {
  await main();
}
