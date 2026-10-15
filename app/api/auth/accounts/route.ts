import { AuthError, listAccounts } from "@/lib/auth";
import { resolveRole } from "@/lib/model";
import { authenticatedUser, database, fail, json, loadForUser } from "@/lib/server";

export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const user = await authenticatedUser(), stored = await loadForUser(user);
    if (resolveRole(stored.state, user) !== "admin") throw new AuthError("Управление доступом доступно только L&D.", 403);
    return json({ accounts: await listAccounts(database()) });
  } catch (error) { return fail(error); }
}
