import { transferAdminCredential } from "@/lib/auth";
import { database, fail, json, loadStored, readJson, requireBootstrapToken } from "@/lib/server";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    await requireBootstrapToken(request);
    const body = await readJson(request, 4096), stored = await loadStored();
    await transferAdminCredential(database(), stored, body.adminCredential);
    return json({ ok: true });
  } catch (error) { return fail(error); }
}
