import { AuthError, createSession, setCredential } from "@/lib/auth";
import { browserWriteGuard, database, fail, json, loadStored, nativeOwner, readJson } from "@/lib/server";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    browserWriteGuard(request);
    const owner = await nativeOwner();
    if (!owner) throw new AuthError("Восстановление доступа недоступно.", 403);
    const body = await readJson(request, 4096), db = database(), stored = await loadStored();
    const result = await setCredential(db, stored, body, owner, { recovery: true });
    const response = json({ ok: true }); response.headers.set("Set-Cookie", await createSession(db, result.principalId, request, result.passwordHash)); return response;
  } catch (error) { return fail(error); }
}
