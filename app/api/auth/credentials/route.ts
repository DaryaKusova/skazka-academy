import { AuthError, createSession, setCredential } from "@/lib/auth";
import { resolveRole } from "@/lib/model";
import { authenticatedUser, browserWriteGuard, database, fail, json, loadForUser, readJson } from "@/lib/server";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    browserWriteGuard(request);
    const user = await authenticatedUser(), stored = await loadForUser(user);
    if (resolveRole(stored.state, user) !== "admin") throw new AuthError("Управление доступом доступно только L&D.", 403);
    const body = await readJson(request, 4096), db = database();
    const result = await setCredential(db, stored, body, user);
    const response = json({ ok: true });
    if (result.self) response.headers.set("Set-Cookie", await createSession(db, result.principalId, request, result.passwordHash));
    return response;
  } catch (error) { return fail(error); }
}
