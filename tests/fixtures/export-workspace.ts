import type { Workspace, LearningEvent, Task } from "../../lib/model";
import { PLAN_SECTIONS, emptyPlanDetails } from "../../lib/development-plan.ts";

/** Deliberately anonymous records. Never copy production workspace data into tests. */
export function exportFixture(): Workspace {
  const event = (id: string, title: string, participantIds: string[], type: LearningEvent["type"] = "group"): LearningEvent => ({ id, title, participantIds, type, date: "2026-10-26", week: "1", skill: "Обратная связь", description: "Обсудить подход и разобрать практический пример.", format: "Практикум", expectedResult: "Применить новый подход в команде", stage: "Инструменты", owner: "L&D", planLink: "", status: "planned", originalStatus: "INTERNAL_ORIGINAL", comment: "INTERNAL_NOTE", sourceSheet: "INTERNAL_SOURCE", sourceRow: 123, archived: false });
  const task = (id: string, personId: string, eventId: string | null, title: string): Task => ({ id, personId, eventId, title, description: "Подготовить пример и обсудить результат", dueDate: "2026-10-30", status: "todo", evidence: "", completedAt: null, rating: null, ratingComment: "", ratedAt: null, ratedBy: "PRIVATE_RATER_ID" });
  return {
    user: { id: "PRIVATE_ADMIN_ID", name: "Администратор", email: "PRIVATE_ADMIN_EMAIL@example.test" }, role: "admin", revision: 1,
    people: [
      { id: "p1", name: "Участник Альфа", title: "Руководитель команды А", userId: "PRIVATE_USER_A", email: "PRIVATE_A_EMAIL@example.test", color: "#008d95", active: true },
      { id: "p2", name: "Участник Бета", title: "Руководитель команды Б", userId: "PRIVATE_USER_B", email: "PRIVATE_B_EMAIL@example.test", color: "#9a70c4", active: true },
    ],
    events: [event("e1", "Общая встреча", ["p1", "p2"]), event("e2", "Личная встреча Беты", ["p2"], "individual"), { ...event("e3", "Архивная встреча", ["p1", "p2"]), archived: true }],
    eventRoster: [{ eventId: "e1", personId: "p1", name: "Участник Альфа", title: "Руководитель команды А" }, { eventId: "e1", personId: "p2", name: "Участник Бета", title: "Руководитель команды Б" }],
    tasks: [task("t1", "p1", "e1", '=HYPERLINK("https://example.test","Текст")'), { ...task("t2", "p2", "e2", "Личная задача Беты"), status: "done", evidence: "План команды подготовлен", completedAt: "2026-10-29T10:30:00Z", rating: 4, ratingComment: "Результат соответствует цели", ratedAt: "2026-10-30T09:00:00Z" }, task("t3", "p1", null, "Самостоятельная практика Альфы")],
    skills: [{ id: "s1", name: "Обратная связь" }], assessments: [{ id: "a1", personId: "p1", skillId: "s1", baseline: null, current: null, target: 5, evidence: "", date: null }, { id: "a2", personId: "p2", skillId: "s1", baseline: 0, current: 4, target: 5, evidence: "PRIVATE_B_SKILL_EVIDENCE", date: "2026-10-30" }],
    attendance: [{ id: "at1", eventId: "e1", personId: "p1", status: "confirmed", note: "Практикум завершен" }],
    developmentPlans: [{ id: "d1", personId: "p1", goal: "Развить навык обратной связи", successCriteria: "Провести три развивающие беседы", support: "Разбор с наставником", reviewDate: "2026-11-30" }, { id: "d2", personId: "p2", goal: "Личная цель Беты", successCriteria: "Критерий Беты", support: "Ресурсы Беты", reviewDate: null }],
    peerReviews: [{ id: "r1", eventId: "e1", personId: "p1", reviewerPersonId: "p2", personName: "Участник Альфа", reviewerName: "Участник Бета", eventTitle: "Общая встреча", score: 4, comment: "Ясная обратная связь", updatedAt: "2026-10-30T12:00:00Z" }, { id: "r2", eventId: "e1", personId: "p2", reviewerPersonId: "p1", personName: "Участник Бета", reviewerName: "Участник Альфа", eventTitle: "Общая встреча", score: 5, comment: "Отзыв Альфы", updatedAt: "2026-10-30T12:00:00Z" }],
    settings: { eventPoints: 20, taskPoints: 30, skillPointWeight: 50, finishPoints: 1000 },
    audit: [{ id: "PRIVATE_AUDIT_ID", at: "2026-10-30T12:00:00Z", actorId: "PRIVATE_ADMIN_ID", actorName: "PRIVATE_AUDIT_NAME", action: "PRIVATE_AUDIT_ACTION", entityId: "p1" }], race: [],
  };
}

export function detailedExportFixture(): Workspace {
  const workspace = exportFixture();
  const details = emptyPlanDetails();
  details.periodStart = "2026-11-01";
  details.periodEnd = "2027-04-30";
  details.sourceNote = "Анонимный учебный пример ИПР\nДополнительное основание";
  details.selfAssessmentSource = "Учебная анкета самооценки";
  details.externalAssessmentSource = "Учебная внешняя оценка";
  for (const section of PLAN_SECTIONS) details.sections[section.key] = [{ id: `row-${section.key}`, cells: [section.title, `Пример ${section.key} второй столбец`, `Пример ${section.key} третий столбец`, `Пример ${section.key} четвертый столбец`, `Пример ${section.key} пятый столбец`] }];
  details.sections.priorities.push({ id: "row-literal", cells: ["=SUM(1,2)", "+Текст", "-Текст", "@Текст", "Полное многострочное содержание\n" + "Подробное описание действия. ".repeat(45) + "Конец подробного описания"] });
  details.diagnostics = [
    { id: "diag1", competency: "Обратная связь", selfScore: 7, externalScore: null, employeeComment: "Учебный комментарий к самооценке", planResponse: "Отработать практику обратной связи" },
    { id: "diag2", competency: "Планирование", selfScore: 0, externalScore: 9, employeeComment: "Исходное значение ноль", planResponse: "Сохранить подтвержденную внешнюю оценку" },
  ];
  workspace.developmentPlans[0].details = details;
  const otherDetails = emptyPlanDetails();
  otherDetails.sourceNote = "PRIVATE_B_PLAN_SOURCE";
  otherDetails.sections.priorities = [{ id: "other-row", cells: ["PRIVATE_B_PLAN_DETAILS", "", "", "", ""] }];
  otherDetails.diagnostics = [{ id: "other-diag", competency: "PRIVATE_B_DIAGNOSTIC", selfScore: 8, externalScore: 6, employeeComment: "", planResponse: "" }];
  workspace.developmentPlans[1].details = otherDetails;
  return workspace;
}
