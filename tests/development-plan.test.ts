import test from "node:test";
import assert from "node:assert/strict";
import { emptyPlanDetails, PLAN_SECTIONS } from "../lib/development-plan.ts";
import { applyAction, calculateRace, DomainError, emptyState, mergeImport, normalizeState, parsePlanDetails, restoreBootstrapState, scopeWorkspace } from "../lib/model.ts";

const admin = { id: "admin-test", name: "Администратор", email: "admin@example.test" };
const manager = { id: "manager-test", name: "Учебный участник", email: "manager@example.test" };
function fixture() {
  const state = mergeImport({ ...emptyState(), ownerId: admin.id }, { people: [{ id: "p1", name: "Учебный участник" }, { id: "p2", name: "Другой участник" }], events: [{ id: "e1", title: "Учебная встреча", participantIds: ["p1"] }], skills: [{ id: "s1", name: "Рабочий навык" }] });
  state.people[0].userId = manager.id;
  return state;
}
function details() {
  const result = emptyPlanDetails();
  result.periodStart = "2026-10-26"; result.periodEnd = "2027-04-25";
  result.sourceNote = "Учебный образец. Не данные сотрудника.";
  result.selfAssessmentSource = "Учебная самооценка"; result.externalAssessmentSource = "Учебное наблюдение";
  result.sections.priorities = [{ id: "priority-1", cells: ["Развитие навыка", "Наблюдаемое изменение", "Практика", "Критерий", "Связь"] }];
  result.diagnostics = [{ id: "diagnostic-1", competency: "Учебная компетенция", selfScore: 0, externalScore: null, employeeComment: "Нужна практика", planResponse: "Разбор примера" }];
  return result;
}
function denied(fn: () => unknown, status = 400) { assert.throws(fn, (error: unknown) => error instanceof DomainError && error.status === status); }

test("detailed IPR accepts five-column sections and 0–10 diagnostics, without generating XP", () => {
  const initial = fixture(), planDetails = details();
  planDetails.diagnostics.push({ ...planDetails.diagnostics[0], id: "diagnostic-2", selfScore: 10, externalScore: 7.5 });
  const next = applyAction(initial, admin, "saveDevelopmentPlan", { personId: "p1", goal: "", details: planDetails });
  assert.deepEqual(next.developmentPlans[0].details, planDetails);
  assert.equal(next.developmentPlans[0].goal, "");
  assert.deepEqual(next.assessments, []);
  assert.deepEqual(calculateRace(next), calculateRace(initial));
  assert.equal(PLAN_SECTIONS.length, 6); assert.ok(PLAN_SECTIONS.every(section => section.columns.length === 5));
});

test("old plans remain unchanged and partial edits preserve omitted detailed content", () => {
  let state = applyAction(fixture(), admin, "saveDevelopmentPlan", { personId: "p1", goal: "Существующая цель", support: "Наставник" });
  assert.equal("details" in state.developmentPlans[0], false);
  const legacy = JSON.parse(JSON.stringify(state)); delete legacy.planImportReceipts;
  assert.deepEqual(normalizeState(legacy).developmentPlans, state.developmentPlans);
  assert.deepEqual(normalizeState(legacy).planImportReceipts, []);
  state = applyAction(state, admin, "saveDevelopmentPlan", { personId: "p1", details: details() });
  const next = applyAction(state, admin, "saveDevelopmentPlan", { personId: "p1", goal: "Новая цель" });
  assert.deepEqual(next.developmentPlans[0].details, state.developmentPlans[0].details);
  assert.equal(next.developmentPlans[0].support, "Наставник");
  assert.deepEqual(mergeImport(next, { people: [], events: [], skills: [] }).developmentPlans, next.developmentPlans);
  assert.deepEqual(restoreBootstrapState(next).developmentPlans, next.developmentPlans);
});

test("only L&D writes detailed IPR; managers receive only their content, pending receives none", () => {
  let state = fixture();
  denied(() => applyAction(state, manager, "saveDevelopmentPlan", { personId: "p1", details: details() }), 403);
  state = applyAction(state, admin, "saveDevelopmentPlan", { personId: "p1", details: details() });
  const other = details(); other.sourceNote = "PRIVATE_OTHER_SOURCE"; other.diagnostics[0].employeeComment = "PRIVATE_OTHER_COMMENT";
  state = applyAction(state, admin, "saveDevelopmentPlan", { personId: "p2", details: other });
  state.planImportReceipts = [{ importId: "PRIVATE_RECEIPT", payloadHash: "a".repeat(64), appliedAt: "2026-10-16T09:00:00.000Z" }];
  const own = scopeWorkspace(state, 1, manager);
  assert.deepEqual(own.developmentPlans[0].details, details());
  for (const secret of ["PRIVATE_OTHER_SOURCE", "PRIVATE_OTHER_COMMENT", "PRIVATE_RECEIPT"]) assert.equal(JSON.stringify(own).includes(secret), false);
  assert.equal("planImportReceipts" in scopeWorkspace(state, 1, admin), false);
  assert.deepEqual(scopeWorkspace(state, 1, { ...manager, id: "outsider" }).developmentPlans, []);
});

test("empty source metadata does not replace a substantive goal; malformed rows, dates and scores reject", () => {
  const state = fixture();
  denied(() => applyAction(state, admin, "saveDevelopmentPlan", { personId: "p1", goal: "", details: { ...emptyPlanDetails(), sourceNote: "Only provenance", periodStart: "2026-10-01" } }));
  for (const cells of [["a"], ["a", "b", "c", "d", "e", "f"], ["a", "b", "c", "d", null]]) {
    const candidate = details(); candidate.sections.priorities = [{ id: "r1", cells: cells as string[] }]; denied(() => parsePlanDetails(candidate));
  }
  for (const score of [-1, 10.1, "7", Number.NaN, Number.POSITIVE_INFINITY]) {
    const candidate = details(); candidate.diagnostics[0].selfScore = score as number; denied(() => parsePlanDetails(candidate));
  }
  const reversed = details(); reversed.periodStart = "2027-05-01"; denied(() => parsePlanDetails(reversed));
  denied(() => parsePlanDetails({ ...details(), periodStart: "2026-02-30" }));
  denied(() => parsePlanDetails({ ...details(), version: 2 }));
  const duplicate = details(); duplicate.sections.priorities.push(duplicate.sections.priorities[0]); denied(() => parsePlanDetails(duplicate));
  const duplicateDiagnostic = details(); duplicateDiagnostic.diagnostics.push(duplicateDiagnostic.diagnostics[0]); denied(() => parsePlanDetails(duplicateDiagnostic));
});

test("details limits bound durable state and unknown metadata is projected away", () => {
  const excessive = details(); excessive.sections.requests = Array.from({ length: 101 }, (_, i) => ({ id: `r-${i}`, cells: ["a", "", "", "", ""] })); denied(() => parsePlanDetails(excessive));
  const tooLarge = details(); tooLarge.sections.requests = Array.from({ length: 10 }, (_, i) => ({ id: `r-${i}`, cells: ["ю".repeat(9000), "", "", "", ""] })); denied(() => parsePlanDetails(tooLarge), 413);
  const raw = { ...details(), rawOriginalMetadata: "PRIVATE_RAW" };
  const parsed = parsePlanDetails(raw); assert.equal(JSON.stringify(parsed).includes("PRIVATE_RAW"), false);
  assert.equal(parsed.diagnostics[0].selfScore, 0); assert.equal(parsed.diagnostics[0].externalScore, null);
});
