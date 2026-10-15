import { loginWithPassword } from "@/lib/auth";
import { browserWriteGuard, database, fail, json, readJson } from "@/lib/server";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    browserWriteGuard(request);
    const body = await readJson(request, 4096);
    const cookie = await loginWithPassword(database(), body, request);
    const response = json({ ok: true }); response.headers.set("Set-Cookie", cookie); return response;
  } catch (error) { return fail(error); }
}
