import { env } from "cloudflare:workers";
import { DomainError } from "@/lib/model";
import { applyPrivatePlanImport, canonicalPlanImportPayload, parsePlanImportPayload, planImportDigest, verifyPlanImportAuthorization } from "@/lib/plan-import";
import { browserWriteGuard, compareAndSwap, fail, json, loadStored, readJson } from "@/lib/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    if (request.headers.has("origin")) browserWriteGuard(request);
    const payload = await readJson(request);
    const configured = (env as unknown as { IPR_IMPORT_CONFIG?: string }).IPR_IMPORT_CONFIG;
    const payloadHash = await verifyPlanImportAuthorization(configured, request.headers.get("authorization"), payload);
    const validated = parsePlanImportPayload(payload);
    for (let attempt = 0; attempt < 4; attempt++) {
      const stored = await loadStored();
      const result = applyPrivatePlanImport(stored.state, payload, payloadHash);
      if (result.replayed || await compareAndSwap(stored.revision, result.state)) {
        const readback = await loadStored();
        const person = readback.state.people.find(person => person.id === validated.personId);
        const plan = readback.state.developmentPlans.find(plan => plan.personId === validated.personId);
        if (!person || !plan) throw new DomainError("Импорт сохранён, но проверка записи не завершена. Повторите тот же запрос.", 409);
        const storedPlanHash = await planImportDigest(canonicalPlanImportPayload({ title: person.title, plan }));
        // The receipt contains no employee identity, source text, scores or hash.
        return json({ ok: true, receipt: { importId: result.receipt.importId, appliedAt: result.receipt.appliedAt }, replayed: result.replayed, storedPlanHash });
      }
    }
    throw new DomainError("Рабочая область меняется. Повторите тот же разовый импорт.", 409);
  } catch (error) { return fail(error); }
}
