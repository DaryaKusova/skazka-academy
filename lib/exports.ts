import type { Workspace } from "./model";
import { PLAN_SECTIONS } from "./development-plan.ts";
import type { PlanDetails, PlanSectionKey } from "./development-plan";

export type ExportOptions = { format: "xlsx" | "docx"; personId?: string; eventIds?: string[] };
export type ExportSelection = Omit<ExportOptions, "format">;
type PersonRow = { id: string; name: string; title: string; active: boolean; goal: string; successCriteria: string; support: string; reviewDate: string | null; details?: PlanDetails };
type EventRow = { id: string; date: string | null; week: string; title: string; type: string; skill: string; description: string; format: string; expectedResult: string; participants: string; stage: string; owner: string; status: string };
type TaskRow = { personId: string; name: string; title: string; event: string; description: string; dueDate: string | null; status: string; evidence: string; completedAt: string | null; rating: number | null; ratingComment: string; ratedAt: string | null };
type SkillRow = { personId: string; name: string; skill: string; baseline: number | null; current: number | null; target: number | null; evidence: string; date: string | null };
type AttendanceRow = { personId: string; name: string; event: string; date: string | null; status: string; note: string };
type PeerRow = { recipientId: string; reviewerId: string; recipient: string; reviewer: string; event: string; score: number; comment: string; updatedAt: string };
export type ExportData = { generatedAt: string; scope: string; people: PersonRow[]; events: EventRow[]; tasks: TaskRow[]; skills: SkillRow[]; attendance: AttendanceRow[]; peerReviews: PeerRow[] };

const eventTypes = { group: "Групповое", individual: "Индивидуальное", team: "Командное" };
const taskStatuses = { todo: "В работе", submitted: "На проверке L&D", done: "Выполнена" };
const attendanceStatuses = { pending: "Не отмечено", confirmed: "Подтверждено", absent: "Не присутствовал" };

function projectPlanDetails(details: PlanDetails | undefined): PlanDetails | undefined {
  if (!details) return undefined;
  return {
    version: 1, periodStart: details.periodStart, periodEnd: details.periodEnd,
    sourceNote: details.sourceNote, selfAssessmentSource: details.selfAssessmentSource, externalAssessmentSource: details.externalAssessmentSource,
    sections: Object.fromEntries(PLAN_SECTIONS.map(({ key }) => [key, (details.sections[key] ?? []).map((row) => ({ id: row.id, cells: Array.from({ length: 5 }, (_, i) => row.cells[i] ?? "") }))])) as PlanDetails["sections"],
    diagnostics: details.diagnostics.map((entry) => ({ id: entry.id, competency: entry.competency, selfScore: entry.selfScore ?? null, externalScore: entry.externalScore ?? null, employeeComment: entry.employeeComment, planResponse: entry.planResponse })),
  };
}

/** Explicit projection keeps future storage fields and access credentials out of documents. */
export function prepareExportData(workspace: Workspace, selection: ExportSelection = {}, generatedAt = new Date().toISOString()): ExportData {
  if (workspace.role !== "admin" && workspace.role !== "manager") throw new Error("Выгрузка доступна после входа в академию.");
  const allowedPeople = workspace.people.filter((person) => workspace.role === "admin" || (person.active && person.userId === workspace.user.id));
  const allowedIds = new Set(allowedPeople.map((person) => person.id));
  if (selection.personId && !allowedIds.has(selection.personId)) throw new Error("Участник недоступен для выгрузки.");
  const availableEvents = workspace.events.filter((event) => !event.archived && (workspace.role === "admin" || event.participantIds.some((id) => allowedIds.has(id))) && (!selection.personId || event.participantIds.includes(selection.personId)));
  const requestedIds = selection.eventIds === undefined ? null : new Set(selection.eventIds);
  if (requestedIds && [...requestedIds].some((id) => !availableEvents.some((event) => event.id === id))) throw new Error("Одно из выбранных мероприятий недоступно для выгрузки.");
  const selectedEvents = availableEvents.filter((event) => !requestedIds || requestedIds.has(event.id)).sort((a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999") || a.title.localeCompare(b.title, "ru"));
  const eventIds = new Set(selectedEvents.map((event) => event.id));
  const rosterIds = new Set(selectedEvents.flatMap((event) => event.participantIds));
  const selectedPeople = allowedPeople.filter((person) => (!selection.personId || person.id === selection.personId) && (!requestedIds || rosterIds.has(person.id)));
  const personIds = new Set(selectedPeople.map((person) => person.id));
  const names = new Map(allowedPeople.map((person) => [person.id, person.name]));
  for (const member of workspace.eventRoster ?? []) if (eventIds.has(member.eventId)) names.set(member.personId, member.name);
  const nameOf = (id: string) => names.get(id) ?? "Участник";
  const eventName = (id: string | null) => selectedEvents.find((event) => event.id === id)?.title ?? (id ? "Мероприятие вне выбранного плана" : "Самостоятельная практика");
  const people = selectedPeople.map((person): PersonRow => {
    const plan = (workspace.developmentPlans ?? []).find((item) => item.personId === person.id);
    return { id: person.id, name: person.name, title: person.title, active: person.active, goal: plan?.goal ?? "", successCriteria: plan?.successCriteria ?? "", support: plan?.support ?? "", reviewDate: plan?.reviewDate ?? null, details: projectPlanDetails(plan?.details) };
  });
  return {
    generatedAt, scope: selection.personId ? `Личный ИПР — ${nameOf(selection.personId)}` : requestedIds ? "Выбранные мероприятия" : workspace.role === "manager" ? "Личный план развития" : "Программа развития руководителей",
    people,
    events: selectedEvents.map((event) => {
      const roster = new Map((workspace.eventRoster ?? []).filter((entry) => entry.eventId === event.id).map((entry) => [entry.personId, entry]));
      const participants = event.participantIds.map((id) => roster.get(id) ?? allowedPeople.find((person) => person.id === id)).filter((person) => person !== undefined).map((person) => person.title ? `${person.name} — ${person.title}` : person.name).join("\n");
      return { id: event.id, date: event.date, week: event.week, title: event.title, type: eventTypes[event.type], skill: event.skill, description: event.description, format: event.format, expectedResult: event.expectedResult, participants, stage: event.stage, owner: event.owner, status: event.status === "draft" ? "Черновик" : "Запланировано" };
    }),
    tasks: workspace.tasks.filter((task) => personIds.has(task.personId) && (!requestedIds || (task.eventId !== null && eventIds.has(task.eventId)))).map((task) => ({ personId: task.personId, name: nameOf(task.personId), title: task.title, event: eventName(task.eventId), description: task.description, dueDate: task.dueDate, status: taskStatuses[task.status], evidence: task.evidence, completedAt: task.completedAt, rating: task.rating ?? null, ratingComment: task.ratingComment ?? "", ratedAt: task.ratedAt ?? null })),
    skills: workspace.assessments.filter((entry) => personIds.has(entry.personId)).map((entry) => ({ personId: entry.personId, name: nameOf(entry.personId), skill: workspace.skills.find((skill) => skill.id === entry.skillId)?.name ?? "Навык", baseline: entry.baseline, current: entry.current, target: entry.target, evidence: entry.evidence, date: entry.date })),
    attendance: selectedEvents.flatMap((event) => selectedPeople.filter((person) => event.participantIds.includes(person.id)).map((person) => {
      const record = workspace.attendance.find((item) => item.eventId === event.id && item.personId === person.id);
      return { personId: person.id, name: person.name, event: event.title, date: event.date, status: record ? attendanceStatuses[record.status] : "Не отмечено", note: record?.note ?? "" };
    })),
    peerReviews: (workspace.peerReviews ?? []).filter((review) => (!requestedIds || eventIds.has(review.eventId)) && (personIds.has(review.personId) || personIds.has(review.reviewerPersonId))).map((review) => {
      // The API supplies display fields for history after archival or roster changes.
      const history = review as typeof review & { personName?: string; reviewerName?: string; eventTitle?: string };
      return { recipientId: review.personId, reviewerId: review.reviewerPersonId, recipient: names.get(review.personId) ?? history.personName ?? "Участник", reviewer: names.get(review.reviewerPersonId) ?? history.reviewerName ?? "Участник", event: selectedEvents.find((event) => event.id === review.eventId)?.title ?? history.eventTitle ?? "Мероприятие вне выбранного плана", score: review.score, comment: review.comment, updatedAt: review.updatedAt };
    }),
  };
}

function calendarDate(value: string | null): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  const day = value.includes("T") ? new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow" }).format(instant) : value.slice(0, 10);
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}
function displayDate(value: string | null): string {
  const date = calendarDate(value);
  return date ? new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC" }).format(date) : "Не назначена";
}
function snapshotLabel(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/Moscow" }).format(new Date(value));
}

type Cell = string | number | Date | null;
type SheetData = { name: string; title?: string; columns: [string, number][]; rows: Cell[][] };
const planSheetNames: Record<PlanSectionKey, string> = {
  priorities: "ИПР Приоритеты", individualTopics: "ИПР Индивидуальные темы", sharedRoute: "ИПР Общий маршрут",
  requests: "ИПР Запросы", checkpoints: "ИПР Контрольные точки", selfContext: "ИПР Контекст",
};
const planColumnProportions: Record<PlanSectionKey, number[]> = {
  priorities: [18, 20, 23, 21, 18], individualTopics: [18, 22, 24, 20, 16], sharedRoute: [18, 26, 23, 21, 12],
  requests: [24, 23, 25, 18, 10], checkpoints: [13, 25, 23, 23, 16], selfContext: [16, 24, 24, 26, 10],
};
function detailedPlanSheets(data: ExportData): SheetData[] {
  const people = data.people.filter((person) => person.details !== undefined);
  if (!people.length) return [];
  return [
    { name: "ИПР Диагностика", title: "Диагностика компетенций ИПР — шкала 0–10", columns: [["ФИО", 32], ["Должность", 36], ["Компетенция", 38], ["Самооценка 0–10", 21], ["Внешняя оценка 0–10", 24], ["Комментарий сотрудника", 55], ["Ответ в плане развития", 55]], rows: people.flatMap((person) => person.details!.diagnostics.length ? person.details!.diagnostics.map((entry) => [person.name, person.title, entry.competency, entry.selfScore, entry.externalScore, entry.employeeComment, entry.planResponse]) : [[person.name, person.title, "", null, null, "", ""]]) },
    ...PLAN_SECTIONS.map(({ key, title, columns }): SheetData => ({
      name: planSheetNames[key], title,
      columns: [["ФИО", 32], ["Должность", 36], ...columns.map((label): [string, number] => [label, 42])],
      rows: people.flatMap((person) => person.details!.sections[key].length ? person.details!.sections[key].map((row) => [person.name, person.title, ...row.cells]) : [[person.name, person.title, "", "", "", "", ""]]),
    })),
  ];
}
export function exportSheets(data: ExportData): SheetData[] {
  return [
    { name: "Участники", columns: [["ФИО", 32], ["Должность", 38], ["Участие", 24]], rows: data.people.map((p) => [p.name, p.title, p.active ? "Активен" : "Приостановлено"]) },
    { name: "Мероприятия", columns: [["Дата", 15], ["Неделя", 12], ["Мероприятие", 42], ["Тип", 22], ["Участники и должности", 55], ["Навык", 30], ["Описание", 50], ["Формат", 30], ["Ожидаемый результат", 50], ["Этап", 24], ["Ответственный", 28], ["Статус", 20]], rows: data.events.map((e) => [calendarDate(e.date), e.week, e.title, e.type, e.participants, e.skill, e.description, e.format, e.expectedResult, e.stage, e.owner, e.status]) },
    { name: "ИПР", columns: [["ФИО", 32], ["Должность", 36], ["Цель развития", 55], ["Критерии успеха", 55], ["Поддержка и ресурсы", 45], ["Пересмотр ИПР", 18], ["Начало периода", 18], ["Конец периода", 18], ["Основание ИПР", 55], ["Источник самооценки", 50], ["Источник внешней оценки", 50]], rows: data.people.map((p) => [p.name, p.title, p.goal, p.successCriteria, p.support, calendarDate(p.reviewDate), calendarDate(p.details?.periodStart ?? null), calendarDate(p.details?.periodEnd ?? null), p.details?.sourceNote ?? "", p.details?.selfAssessmentSource ?? "", p.details?.externalAssessmentSource ?? ""]) },
    { name: "Практические задачи", columns: [["ФИО", 32], ["Задача", 45], ["Мероприятие", 40], ["Описание", 50], ["Срок", 15], ["Статус", 24], ["Результат и подтверждение", 50], ["Дата выполнения", 18], ["Оценка L&D 1–5", 19], ["Комментарий L&D", 50], ["Дата оценки", 18]], rows: data.tasks.map((t) => [t.name, t.title, t.event, t.description, calendarDate(t.dueDate), t.status, t.evidence, calendarDate(t.completedAt), t.rating, t.ratingComment, calendarDate(t.ratedAt)]) },
    { name: "Навыки", columns: [["ФИО", 32], ["Навык", 40], ["Старт 0–5", 15], ["Сейчас 0–5", 15], ["Цель 0–5", 15], ["Основание оценки", 60], ["Дата оценки", 18]], rows: data.skills.map((s) => [s.name, s.skill, s.baseline, s.current, s.target, s.evidence, calendarDate(s.date)]) },
    { name: "Посещение", columns: [["ФИО", 32], ["Мероприятие", 45], ["Дата", 15], ["Посещение", 24], ["Комментарий", 55]], rows: data.attendance.map((a) => [a.name, a.event, calendarDate(a.date), a.status, a.note]) },
    { name: "Оценки коллег", columns: [["Кого оценивают", 32], ["Кто оценивает", 32], ["Мероприятие", 45], ["Оценка 1–5", 16], ["Комментарий", 60], ["Дата оценки", 18]], rows: data.peerReviews.map((r) => [r.recipient, r.reviewer, r.event, r.score, r.comment, calendarDate(r.updatedAt)]) },
    ...detailedPlanSheets(data),
  ];
}

/** Dynamic libraries keep the initial CRM bundle small. No formulas or external links are created. */
export async function buildXlsx(data: ExportData): Promise<Uint8Array> {
  const excel = await import("exceljs");
  const Workbook = excel.Workbook ?? excel.default.Workbook;
  const workbook = new Workbook();
  workbook.creator = "Академия лидеров — Парк Сказка";
  workbook.created = new Date(data.generatedAt);
  workbook.modified = new Date(data.generatedAt);
  for (const spec of exportSheets(data)) {
    const sheet = workbook.addWorksheet(spec.name, { views: [{ state: "frozen", ySplit: 4 }], properties: { defaultRowHeight: 23 }, pageSetup: { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    sheet.columns = spec.columns.map(([, width]) => ({ width }));
    sheet.mergeCells(1, 1, 1, spec.columns.length);
    sheet.getCell(1, 1).value = spec.title ?? spec.name;
    sheet.getCell(1, 1).font = { name: "Arial", size: 19, bold: true, color: { argb: "FF233445" } };
    sheet.getRow(1).height = 34;
    sheet.mergeCells(2, 1, 2, spec.columns.length);
    sheet.getCell(2, 1).value = `${data.scope} · ${snapshotLabel(data.generatedAt)} МСК · Пустая оценка означает отсутствие данных`;
    sheet.getCell(2, 1).font = { name: "Arial", size: 10, color: { argb: "FF526575" } };
    sheet.getCell(2, 1).alignment = { wrapText: true, vertical: "middle" };
    sheet.getRow(2).height = spec.columns.length < 4 ? 45 : 30;
    const header = sheet.getRow(4);
    header.values = spec.columns.map(([name]) => name);
    header.height = Math.max(34, ...spec.columns.map(([label, width]) => Math.ceil(label.length / (width * 0.7)) * 15 + 10));
    header.eachCell((cell) => {
      cell.font = { name: "Arial", bold: true, size: 11, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF233445" } };
      cell.alignment = { wrapText: true, vertical: "middle" };
    });
    for (const values of spec.rows) {
      const row = sheet.addRow(values);
      let lines = 1;
      values.forEach((value, index) => {
        const cell = row.getCell(index + 1);
        // Assign strings directly. ExcelJS writes text cells, even for =, +, -, and @ prefixes.
        cell.value = value;
        cell.font = { name: "Arial", size: 11, color: { argb: "FF233445" } };
        cell.alignment = { vertical: "top", wrapText: true, horizontal: typeof value === "number" || value instanceof Date ? "center" : "left" };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: row.number % 2 ? "FFFFFFFF" : "FFF0F7FA" } };
        cell.border = { bottom: { style: "hair", color: { argb: "FFDCE5EB" } } };
        if (value instanceof Date) cell.numFmt = "dd.mm.yyyy";
        if (typeof value === "number") cell.numFmt = "0.##";
        if (typeof value === "string") lines = Math.max(lines, value.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / (spec.columns[index][1] * 0.85))), 0));
      });
      row.height = Math.min(409, Math.max(27, lines * 15 + 10));
    }
    if (spec.rows.length) sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4 + spec.rows.length, column: spec.columns.length } };
    sheet.pageSetup.printTitlesRow = "1:4";
    sheet.headerFooter.oddFooter = "&LАкадемия лидеров · Парк Сказка&RСтраница &P из &N";
  }
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

export async function buildDocx(data: ExportData): Promise<Uint8Array> {
  const d = await import("docx");
  const { Document, Paragraph, TextRun, Table, TableCell, TableRow, HeadingLevel, WidthType, BorderStyle, ShadingType, VerticalAlign } = d;
  const paragraph = (text: string, bold = false) => new Paragraph({ children: text.split("\n").flatMap((line, i) => [new TextRun({ text: line || " ", bold, ...(i ? { break: 1 } : {}) })]), spacing: { after: 110 } });
  const heading = (text: string, level: "h1" | "h2" = "h1") => new Paragraph({ text, heading: level === "h1" ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2, spacing: { before: 260, after: 140 }, keepNext: true });
  const border = { style: BorderStyle.SINGLE, size: 4, color: "D9D9D9" };
  const table = (headers: string[], rows: (string | number | null)[][], proportions: number[]) => new Table({
    width: { size: 100, type: WidthType.PERCENTAGE }, columnWidths: proportions.map((n) => Math.round(n * 96)), layout: d.TableLayoutType.FIXED,
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    rows: [headers, ...rows].map((row, index) => new TableRow({ tableHeader: index === 0, children: row.map((value, col) => new TableCell({
      width: { size: proportions[col], type: WidthType.PERCENTAGE }, verticalAlign: VerticalAlign.CENTER,
      shading: { type: ShadingType.CLEAR, fill: index === 0 ? "233445" : index % 2 === 0 ? "F0F5F8" : "FFFFFF" },
      margins: { top: 105, bottom: 105, left: 110, right: 110 },
      children: [new Paragraph({ children: String(value ?? "—").split("\n").map((line, i) => new TextRun({ text: line || " ", size: 20, bold: index === 0, color: index === 0 ? "FFFFFF" : "233445", ...(i ? { break: 1 } : {}) })), spacing: { after: 0, line: 250 } })],
    })) })),
  });
  const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [
    new Paragraph({ text: data.people.length === 1 ? "Индивидуальный план развития" : "Программа развития руководителей", heading: HeadingLevel.TITLE, spacing: { after: 200 } }),
    paragraph(`Академия лидеров парка Сказка. ${data.scope}.`),
    paragraph(`Состояние на ${snapshotLabel(data.generatedAt)} МСК. В отчете представлены планы, действия, подтвержденные результаты и оценки. Отсутствие оценки обозначено знаком «—».`),
    paragraph(`Участников: ${data.people.length}. Мероприятий: ${data.events.length}. Практических задач: ${data.tasks.length}.`),
  ];
  if (!data.people.length) children.push(paragraph("В выбранном наборе нет участников."));
  data.people.forEach((person) => {
    children.push(heading(person.name), paragraph(person.title || "Должность не указана"));
    if (!person.active) children.push(paragraph("Участие в программе приостановлено."));
    children.push(heading("Цель и результат развития", "h2"), paragraph(person.goal || "Цель развития пока не задана."), paragraph(`Критерии успеха: ${person.successCriteria || "не заданы"}.`), paragraph(`Поддержка и ресурсы: ${person.support || "не указаны"}.`), paragraph(`Дата пересмотра ИПР: ${displayDate(person.reviewDate)}.`));
    if (person.details) {
      const details = person.details;
      children.push(heading("Период и основания ИПР", "h2"), paragraph(`Период развития: ${details.periodStart ? displayDate(details.periodStart) : "начало не указано"} — ${details.periodEnd ? displayDate(details.periodEnd) : "окончание не указано"}.`));
      children.push(paragraph(`Основание ИПР: ${details.sourceNote || "не указано"}`), paragraph(`Источник самооценки: ${details.selfAssessmentSource || "не указан"}`), paragraph(`Источник внешней оценки: ${details.externalAssessmentSource || "не указан"}`));
      children.push(heading("Диагностика компетенций ИПР", "h2"), paragraph("Самооценка и внешняя оценка приведены по шкале от 0 до 10. Оценки навыков академии используют шкалу 0–5, практических задач L&D — 1–5; эти показатели учитываются отдельно."));
      if (details.diagnostics.length) children.push(table(["Компетенция", "Самооценка 0–10", "Внешняя оценка 0–10", "Комментарий сотрудника", "Ответ в плане развития"], details.diagnostics.map((entry) => [entry.competency, entry.selfScore, entry.externalScore, entry.employeeComment, entry.planResponse]), [21, 12, 12, 27, 28]));
      else children.push(paragraph("Диагностические оценки пока не внесены."));
      for (const section of PLAN_SECTIONS) {
        children.push(heading(section.title, "h2"));
        const rows = details.sections[section.key];
        if (rows.length) children.push(table([...section.columns], rows.map((row) => row.cells), planColumnProportions[section.key]));
        else children.push(paragraph("Раздел пока не заполнен."));
      }
    }
    const tasks = data.tasks.filter((task) => task.personId === person.id);
    children.push(heading("Практические действия", "h2"));
    if (tasks.length) {
      children.push(table(["Действие и мероприятие", "Срок и статус", "Результат", "L&D 1–5"], tasks.map((task) => [`${task.title}\n${task.event}${task.description ? `\n${task.description}` : ""}`, `${displayDate(task.dueDate)}\n${task.status}${task.completedAt ? `\nВыполнено ${displayDate(task.completedAt)}` : ""}`, task.evidence || "Подтверждение пока не добавлено", `${task.rating ?? "—"}${task.ratingComment ? `\n${task.ratingComment}` : ""}${task.ratedAt ? `\n${displayDate(task.ratedAt)}` : ""}`]), [35, 19, 29, 17]));
    } else children.push(paragraph("Практические задачи пока не назначены."));
    const skills = data.skills.filter((skill) => skill.personId === person.id);
    children.push(heading("Развитие навыков", "h2"));
    if (skills.length) children.push(table(["Навык", "Старт", "Сейчас", "Цель", "Основание и дата"], skills.map((skill) => [skill.skill, skill.baseline, skill.current, skill.target, `${skill.evidence || "Основание не указано"}${skill.date ? `\n${displayDate(skill.date)}` : ""}`]), [28, 10, 10, 10, 42]));
    else children.push(paragraph("Оценки навыков пока не внесены."));
    const attendance = data.attendance.filter((entry) => entry.personId === person.id);
    children.push(heading("Участие в мероприятиях", "h2"));
    if (attendance.length) children.push(table(["Дата", "Мероприятие", "Посещение и комментарий"], attendance.map((entry) => [displayDate(entry.date), entry.event, `${entry.status}${entry.note ? `\n${entry.note}` : ""}`]), [17, 43, 40]));
    else children.push(paragraph("Мероприятия в выбранном плане отсутствуют."));
    const reviews = data.peerReviews.filter((review) => review.recipientId === person.id || review.reviewerId === person.id);
    children.push(heading("Обратная связь коллег", "h2"));
    if (reviews.length) children.push(table(["Кого и кто оценивает", "Мероприятие и дата", "Оценка 1–5 и комментарий"], reviews.map((review) => [`${review.recipient}\nОценил: ${review.reviewer}`, `${review.event}\n${displayDate(review.updatedAt)}`, `${review.score}${review.comment ? `\n${review.comment}` : ""}`]), [32, 33, 35]));
    else children.push(paragraph("Оценки коллег пока не внесены."));
  });
  children.push(heading("План мероприятий"));
  if (!data.events.length) children.push(paragraph("Мероприятия в выбранном наборе отсутствуют."));
  data.events.forEach((event) => {
    children.push(heading(event.title, "h2"), paragraph(`${displayDate(event.date)} · ${event.type} · ${event.status}${event.week ? ` · Неделя ${event.week}` : ""}`));
    children.push(paragraph(`Участники: ${event.participants || "состав не указан"}.`));
    if (event.skill) children.push(paragraph(`Развиваемый навык: ${event.skill}.`));
    if (event.description) children.push(paragraph(event.description));
    if (event.format) children.push(paragraph(`Формат: ${event.format}.`));
    if (event.expectedResult) children.push(paragraph(`Ожидаемый результат: ${event.expectedResult}.`));
    if (event.stage || event.owner) children.push(paragraph([event.stage && `Этап: ${event.stage}`, event.owner && `Ответственный: ${event.owner}`].filter(Boolean).join(". ")));
  });
  const doc = new Document({ creator: "Академия лидеров — Парк Сказка", title: data.scope, description: "Планы развития, мероприятия и результаты", styles: { default: { document: { run: { font: "Arial", size: 22, color: "233445" }, paragraph: { spacing: { after: 110, line: 280 } } }, title: { run: { font: "Arial", size: 40, bold: true, color: "000000" } }, heading1: { run: { font: "Arial", size: 29, bold: true, color: "000000" } }, heading2: { run: { font: "Arial", size: 24, bold: true, color: "000000" } } } }, sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1000, right: 1100, bottom: 1000, left: 1100 } } }, children }] });
  return new Uint8Array(await d.Packer.toArrayBuffer(doc));
}

/** Call from a click handler. The workbook never leaves the current browser. */
export async function exportWorkspace(workspace: Workspace, options: ExportOptions): Promise<void> {
  const data = prepareExportData(workspace, options);
  const bytes = options.format === "xlsx" ? await buildXlsx(data) : await buildDocx(data);
  const mime = options.format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  const suffix = options.personId && data.people[0] ? `-${data.people[0].name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").slice(0, 80)}` : "";
  link.download = `Академия-Сказка${suffix}-${new Date(data.generatedAt).toLocaleDateString("sv-SE", { timeZone: "Europe/Moscow" })}.${options.format}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Keep the Blob URL alive long enough for mobile Safari to begin its download.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
