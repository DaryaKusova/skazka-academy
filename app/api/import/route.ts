import { DomainError, mergeImport, recordImport, resolveRole } from "@/lib/model";
import { authenticatedUser, browserWriteGuard, expectedRevision, fail, loadForUser, readJson, saveForUser } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    browserWriteGuard(request);
    const user = await authenticatedUser();
    const stored = await loadForUser(user);
    if (resolveRole(stored.state, user) !== "admin") throw new DomainError("Импорт доступен только L&D.", 403);
    const body = await readJson(request, 8 * 1024 * 1024);
    const revision = expectedRevision(body.revision);
    const next = recordImport(mergeImport(stored.state, body.data), user);
    return await saveForUser(stored, revision, next, user);
  } catch (error) { return fail(error); }
}
