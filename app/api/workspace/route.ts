import { applyAction, scopeWorkspace } from "@/lib/model";
import { authenticatedUser, browserWriteGuard, expectedRevision, fail, json, loadForUser, readJson, saveForUser } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await authenticatedUser();
    const stored = await loadForUser(user);
    return json(scopeWorkspace(stored.state, stored.revision, user));
  } catch (error) { return fail(error); }
}

export async function POST(request: Request) {
  try {
    browserWriteGuard(request);
    const user = await authenticatedUser();
    const body = await readJson(request);
    const revision = expectedRevision(body.revision);
    const stored = await loadForUser(user);
    const next = applyAction(stored.state, user, typeof body.action === "string" ? body.action : "", body.payload);
    return await saveForUser(stored, revision, next, user);
  } catch (error) { return fail(error); }
}
