import { eq, sql } from "drizzle-orm";
import type { DbOrTx } from "../db/client";
import { settings } from "../db/schema";

/**
 * Settings made in the app, one JSON value per key. Secrets inside a value
 * are stored encrypted (core/crypto.ts); readers decrypt them.
 */
export async function readSetting<T>(db: DbOrTx, key: string): Promise<T | null> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
  return (row?.value as T | undefined) ?? null;
}

export async function writeSetting<T>(db: DbOrTx, key: string, value: T): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: sql`now()` } });
}

/** Changes a stored value with `change` (null when there is none yet), with its row locked meanwhile. */
export async function updateSetting<T>(
  db: DbOrTx,
  key: string,
  change: (current: T | null) => T,
): Promise<T> {
  return db.transaction(async (tx) => {
    const next = change(await readSettingForUpdate<T>(tx, key));
    await writeSetting(tx, key, next);
    return next;
  });
}

/** Reads a value and locks its row until the transaction ends (read, compare, write without a race). */
export async function readSettingForUpdate<T>(tx: DbOrTx, key: string): Promise<T | null> {
  const [row] = await tx
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .for("update");
  return (row?.value as T | undefined) ?? null;
}
