import { getAdminCredential, getPasswordUser, isLocalSetupRequest } from "@/lib/auth";
import { database, fail, json, nativeOwner } from "@/lib/server";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const db = database(), configured = Boolean(await getAdminCredential(db));
    const user = await getPasswordUser(db, request.headers);
    const native = !configured ? await nativeOwner() : null;
    return json({ authenticated: Boolean(user || native), localSetupAllowed: !configured && (isLocalSetupRequest(request) || Boolean(native)) });
  } catch (error) { return fail(error); }
}
