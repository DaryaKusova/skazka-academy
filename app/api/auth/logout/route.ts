import { revokeSession } from "@/lib/auth";
import { browserWriteGuard, database, fail, json, readJson } from "@/lib/server";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    browserWriteGuard(request); await readJson(request, 4096);
    const cookie = await revokeSession(database(), request);
    const response = json({ ok: true }); response.headers.set("Set-Cookie", cookie); return response;
  } catch (error) { return fail(error); }
}
