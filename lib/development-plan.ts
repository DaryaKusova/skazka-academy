/** Generic template only. Personal source content is supplied privately at runtime. */
export type PlanSectionKey = "priorities" | "individualTopics" | "sharedRoute" | "requests" | "checkpoints" | "selfContext";
export type PlanRow = { id: string; cells: string[] };
export type PlanDiagnostic = { id: string; competency: string; selfScore: number | null; externalScore: number | null; employeeComment: string; planResponse: string };
export type PlanDetails = {
  version: 1; periodStart: string | null; periodEnd: string | null;
  sourceNote: string; selfAssessmentSource: string; externalAssessmentSource: string;
  sections: Record<PlanSectionKey, PlanRow[]>; diagnostics: PlanDiagnostic[];
};
export const PLAN_SECTIONS: readonly { key: PlanSectionKey; title: string; columns: readonly [string, string, string, string, string] }[] = [
  { key: "priorities", title: "Основные цели ИПР", columns: ["Приоритет / исходная точка", "Целевое изменение", "Практика в работе", "Критерий результата", "Связь с мастер-календарём"] },
  { key: "individualTopics", title: "Индивидуальные темы", columns: ["Тема", "Что развиваем", "Практика", "Проверяемый результат", "Даты и покрытие по мастеру"] },
  { key: "sharedRoute", title: "Общий рабочий маршрут", columns: ["Направление", "Действие участника", "Ожидаемый результат", "Как проверить", "Срок / условие"] },
  { key: "requests", title: "Запросы из самооценки", columns: ["Запрос / сильная сторона", "Как учтено", "Практическое применение", "Результат", "Статус"] },
  { key: "checkpoints", title: "Контрольные точки", columns: ["Дата", "Что проверить", "Что готовит участник", "Критерий / решение", "Связь с мастер-календарём"] },
  { key: "selfContext", title: "Сильные стороны и контекст самооценки", columns: ["Категория", "Источник / основание", "Как учтено", "Практическое подтверждение", "Статус"] },
];
export function emptyPlanDetails(): PlanDetails {
  return { version: 1, periodStart: null, periodEnd: null, sourceNote: "", selfAssessmentSource: "", externalAssessmentSource: "", sections: { priorities: [], individualTopics: [], sharedRoute: [], requests: [], checkpoints: [], selfContext: [] }, diagnostics: [] };
}
/** Dates and provenance alone are not an individual development plan. */
export function hasPlanDetailsContent(details: PlanDetails): boolean {
  return PLAN_SECTIONS.some(({ key }) => details.sections[key].some(row => row.cells.some(cell => cell.trim()))) || details.diagnostics.some(row => row.competency.trim());
}
