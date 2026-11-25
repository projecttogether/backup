import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { users } from "../db/schema";
import type { UserPrincipal } from "../auth/principal";

/**
 * Sign-in is the OIDC provider's job; API tests act as a person in the web
 * app through the x-test-user header. Use with
 * `vi.mock("../auth/resolve", () => import("../test/resolve-mock"))`.
 */
export async function resolveSession(db: Db, headers: Headers): Promise<UserPrincipal | null> {
  const id = headers.get("x-test-user");
  if (!id) return null;
  const [user] = await db.select().from(users).where(eq(users.id, id));
  if (!user || !user.isAdmin) return null;
  return {
    kind: "user",
    id: user.id,
    email: user.email,
    name: user.name,
    image: null,
    isAdmin: user.isAdmin,
  };
}

export async function resolvePrincipal(db: Db, headers: Headers): Promise<UserPrincipal | null> {
  return resolveSession(db, headers);
}
