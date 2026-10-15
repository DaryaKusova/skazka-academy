import { DomainError, mergeImport, recordImport, restoreBootstrapState } from "@/lib/model";
import { transferAdminCredential } from "@/lib/auth";
import { compareAndSwap, database, fail, json, loadStored, readJson, requireBootstrapToken } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await requireBootstrapToken(request);
    const body = await readJson(request, 8 * 1024 * 1024);
    const stored = await loadStored();
    if (stored.state.events.length) throw new DomainError("Первичный импорт уже выполнен. Используйте кабинет L&D.", 409);
    if (body.snapshot !== undefined && body.data !== undefined) throw new DomainError("Передайте либо снимок рабочей области, либо исходный план.");
    if (body.snapshot !== undefined && body.adminCredential === undefined) throw new DomainError("Для переноса снимка нужна учётная запись администратора.");
    const restored = body.snapshot !== undefined ? restoreBootstrapState(body.snapshot) : mergeImport(stored.state, body.data);
    const next = recordImport(restored, { id: "bootstrap-service", name: "Первичный импорт", email: "" });
    if (!next.events.length) throw new DomainError("Первичный импорт должен содержать мероприятия.");
    // A service call never signs in. An optional validated password hash can provision
    // the first administrator in the same atomic transaction as the initial programme.
    if (body.adminCredential !== undefined) await transferAdminCredential(database(), stored, body.adminCredential, next);
    else if (!await compareAndSwap(stored.revision, next)) throw new DomainError("Данные уже изменены. Проверьте результат импорта.", 409);
    return json({ ok: true, revision: stored.revision + 1, imported: { people: next.people.length, events: next.events.length, skills: next.skills.length, tasks: next.tasks.length } });
  } catch (error) { return fail(error); }
}
