import { and, eq, gt } from "drizzle-orm";
import type { Db } from "../db/client";
import { sessions, users } from "../db/schema";
import { auth } from "./auth";
import type { UserPrincipal } from "./principal";

/** The signed-in person of a browser request (session cookie), or null. */
export async function resolveSession(db: Db, headers: Headers): Promise<UserPrincipal | null> {
  const session = await auth().api.getSession({ headers });
  if (!session) return null;
  // The cookie cache can outlive a revoked session by a minute; check the row.
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      image: users.image,
      isAdmin: users.isAdmin,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, session.session.id), gt(sessions.expiresAt, new Date())));
  if (!row || !row.isAdmin) return null;
  return { kind: "user", ...row };
}

/** Who makes a request: the session cookie's person, or null. Agents use their own routes (/api/agent). */
export async function resolvePrincipal(db: Db, headers: Headers): Promise<UserPrincipal | null> {
  return resolveSession(db, headers);
}
