'use client';

import { useEffect, useId, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { ArrowUpRight, BookOpen, CalendarDays, Check, CheckCircle2, ChevronDown, Download, FileText, Plus, Target, Users, X } from 'lucide-react';
import './development-plans.css';

type Row = Record<string, any>;
type ExportFormat = 'xlsx' | 'docx';
export type DevelopmentPlansProps = {
  data: Row;
  busy: boolean;
  initialPersonId?: string;
  onSave: (payload: Row) => Promise<boolean | undefined>;
  onEvent: (event: Row) => void;
  onTask: (task: Row) => void;
  onNewTask: (personId: string) => void;
  onExport: (format: ExportFormat, personId: string) => void | Promise<unknown>;
};

const eventTypes: Record<string, string> = { individual: 'Индивидуальное', group: 'Групповое', team: 'Командное' };
const taskStatuses: Record<string, string> = { todo: 'В работе', submitted: 'На проверке L&D', done: 'Подтверждено' };
const dateText = (value?: string | null) => value ? new Date(value.slice(0, 10) + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : 'Дата не назначена';
const initials = (name: string) => name.split(' ').filter(Boolean).slice(0, 2).map(part => part[0]).join('');
const rows = (value: unknown): Row[] => Array.isArray(value) ? value : [];

function personalData(data: Row, personId: string) {
  const events = rows(data.events).filter(event => !event.archived && rowsOfIds(event.participantIds).includes(personId));
  const assignedIds = new Set(events.map(event => event.id));
  const confirmedIds = new Set(rows(data.attendance).filter(entry => entry.personId === personId && entry.status === 'confirmed' && assignedIds.has(entry.eventId)).map(entry => entry.eventId));
  const tasks = rows(data.tasks).filter(task => task.personId === personId);
  const assessments = rows(data.assessments).filter(assessment => assessment.personId === personId);
  return { events, confirmedIds, tasks, assessments, progress: events.length ? Math.round(confirmedIds.size / events.length * 100) : 0 };
}

function rowsOfIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

function PersonHeading({ person }: { person: Row }) {
  return <div className="ipr-person-heading">
    <span className="avatar" style={{ '--person': person.color || '#008d95' } as CSSProperties}>{initials(person.name || 'Участник')}</span>
    <span><strong>{person.name}</strong><small>{person.title || 'Должность не указана'}</small></span>
  </div>;
}

export function DevelopmentPlans(props: DevelopmentPlansProps) {
  const { data, initialPersonId } = props;
  const admin = data.role === 'admin';
  const people = rows(data.people).filter(person => person.active !== false && (admin || person.userId === data.user?.id));
  const [selectedId, setSelectedId] = useState<string>(() => initialPersonId || (admin ? '' : people[0]?.id || ''));
  const selected = people.find(person => person.id === selectedId);
  useEffect(() => { if (initialPersonId) setSelectedId(initialPersonId); }, [initialPersonId]);

  return <section className="ipr-area" aria-label="Индивидуальные планы развития">
    <div className="ipr-intro">
      <div><h2>{admin ? 'Планы команды' : 'Личный маршрут развития'}</h2><p>Цели, действия и результаты в одном месте.</p></div>
      {admin && <span className="ipr-count"><Users size={17}/>{people.length} участников</span>}
    </div>
    {admin && <p className="ipr-admin-note">Должность можно указать в карточке участника в кабинете L&D.</p>}
    <div className="ipr-person-grid">
      {people.map(person => {
        const personal = personalData(data, person.id);
        const plan = rows(data.developmentPlans).find(item => item.personId === person.id);
        return <button key={person.id} type="button" className="panel ipr-person-card" onClick={() => setSelectedId(person.id)} aria-label={`Открыть ИПР: ${person.name}`}>
          <PersonHeading person={person}/>
          <span className="ipr-card-goal">{plan?.goal || 'Цель развития пока не согласована'}</span>
          <span className="ipr-card-counts"><span><CalendarDays size={15}/>{personal.events.length} мероприятий</span><span><CheckCircle2 size={15}/>{personal.tasks.filter(task => task.status === 'done').length} из {personal.tasks.length} задач</span></span>
          <span className="ipr-progress-label"><span>Выполнение плана</span><b>{personal.progress}%</b></span>
          <span className="progress-track"><span style={{ width: personal.progress + '%' }}/></span>
          <span className="ipr-card-footer"><span>{personal.confirmedIds.size} из {personal.events.length} участий подтверждено</span><ArrowUpRight size={18}/></span>
        </button>;
      })}
    </div>
    {!people.length && <div className="panel empty"><BookOpen size={28}/><p>{admin ? 'Добавьте участников в кабинете L&D, чтобы подготовить их планы.' : 'Личный план пока не подключён. Уточните доступ у L&D.'}</p></div>}
    {selected && <PersonalPlanWindow key={selected.id} {...props} person={selected} onClose={() => setSelectedId('')}/>}
  </section>;
}

function PersonalPlanWindow({ data, person, busy, onSave, onEvent, onTask, onNewTask, onExport, onClose }: DevelopmentPlansProps & { person: Row; onClose: () => void }) {
  const admin = data.role === 'admin';
  const personal = personalData(data, person.id);
  const plan = rows(data.developmentPlans).find(item => item.personId === person.id);
  const [draft, setDraft] = useState({ goal: plan?.goal || '', successCriteria: plan?.successCriteria || '', support: plan?.support || '', reviewDate: plan?.reviewDate || '' });
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [view, setView] = useState('goals');
  const [eventFilter, setEventFilter] = useState(personal.events.some(event => event.type === 'individual') ? 'individual' : 'all');
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => { if (element?.open) element.close(); };
  }, []);

  function change(field: keyof typeof draft, value: string) {
    setDraft(previous => ({ ...previous, [field]: value }));
    setDirty(true); setSaved(false); setError('');
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !admin) return;
    setError('');
    try {
      const successful = await onSave({ id: plan?.id, personId: person.id, ...draft, reviewDate: draft.reviewDate || null });
      if (successful) { setDirty(false); setSaved(true); }
      else setError('Цель не сохранена. Проверьте сообщение об ошибке и повторите попытку.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось сохранить цель. Повторите попытку.'); }
  }
  async function exportPlan(format: ExportFormat) {
    setExporting(format); setError('');
    try { await onExport(format, person.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось выгрузить ИПР. Повторите попытку.'); }
    finally { setExporting(null); }
  }
  const events = personal.events.filter(event => eventFilter === 'all' || event.type === eventFilter).sort((a, b) => {
    const priority = (a.type === 'individual' ? 0 : 1) - (b.type === 'individual' ? 0 : 1);
    return priority || String(a.date || '9999').localeCompare(String(b.date || '9999')) || String(a.id).localeCompare(String(b.id));
  });
  const skills = rows(data.skills);

  return <dialog ref={dialog} className="modal wide ipr-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal-heading ipr-modal-heading"><div><p>Индивидуальный план развития</p><h2 id={titleId}>{person.name}</h2><span>{person.title || 'Должность не указана'}</span></div><button type="button" className="icon-button" aria-label="Закрыть ИПР" onClick={onClose}><X size={21}/></button></div>
    <div className="ipr-window-body">
      <div className="ipr-summary">
        <div><span>Мероприятия</span><strong>{personal.confirmedIds.size}<small> / {personal.events.length}</small></strong><p>подтверждено</p></div>
        <div><span>Практические задачи</span><strong>{personal.tasks.filter(task => task.status === 'done').length}<small> / {personal.tasks.length}</small></strong><p>выполнено</p></div>
        <div><span>Навыки</span><strong>{new Set(personal.assessments.filter(item => item.current != null).map(item => item.skillId)).size}<small> / {skills.length}</small></strong><p>оценено</p></div>
        <div><span>Выполнение плана</span><strong>{personal.progress}%</strong><div className="progress-track"><span style={{ width: personal.progress + '%' }}/></div></div>
      </div>
      <div className="ipr-export-bar"><span><FileText size={16}/> Личный ИПР для обсуждения и работы</span><div><button type="button" className="button secondary" disabled={!!exporting || busy} onClick={() => exportPlan('xlsx')}><Download size={16}/>{exporting === 'xlsx' ? 'Готовим Excel…' : 'Excel'}</button><button type="button" className="button secondary" disabled={!!exporting || busy} onClick={() => exportPlan('docx')}><Download size={16}/>{exporting === 'docx' ? 'Готовим Word…' : 'Word'}</button></div></div>
      {dirty && <p className="ipr-unsaved-note">Изменения цели ещё не сохранены. В выгрузку попадёт сохранённая версия.</p>}
      <nav className="ipr-tabs" aria-label="Разделы ИПР">{[
        ['goals', 'Цель и поддержка'], ['actions', `План действий (${personal.events.length})`], ['tasks', `Практика (${personal.tasks.length})`], ['skills', 'Карта навыков'],
      ].map(([id, label]) => <button type="button" key={id} className={view === id ? 'is-active' : ''} aria-current={view === id ? 'page' : undefined} onClick={() => setView(id)}>{label}</button>)}</nav>
      {error && <p className="notice error" role="alert">{error}</p>}

      {view === 'goals' && <section className="ipr-content-section">
        <div className="section-heading"><div><h3>К чему идём</h3><p>{admin ? 'Зафиксируйте договорённости о развитии и способ проверки результата.' : 'Договорённости о развитии с L&D.'}</p></div><Target size={21}/></div>
        {admin ? <form className="edit-form ipr-goal-form" onSubmit={save}>
          <label>Цель развития<textarea name="goal" rows={3} required maxLength={10000} value={draft.goal} onChange={event => change('goal', event.target.value)} placeholder="Какое изменение в работе должно произойти?"/></label>
          <label>Критерий результата<textarea name="successCriteria" rows={3} maxLength={10000} value={draft.successCriteria} onChange={event => change('successCriteria', event.target.value)} placeholder="По какому наблюдаемому результату оценим развитие?"/></label>
          <div className="ipr-form-columns"><label>Необходимая поддержка<textarea name="support" rows={3} maxLength={10000} value={draft.support} onChange={event => change('support', event.target.value)} placeholder="Ресурсы, помощь, обратная связь"/></label><label>Дата обсуждения результата<input name="reviewDate" type="date" value={draft.reviewDate} onChange={event => change('reviewDate', event.target.value)}/><small>Оставьте пустой, если дата ещё не согласована.</small></label></div>
          <div className="ipr-save-row"><button type="submit" className="button primary" disabled={busy || !dirty || !draft.goal.trim()}><Check size={17}/>{busy ? 'Сохраняем…' : 'Сохранить цель'}</button><span aria-live="polite">{saved ? 'Цель и договорённости сохранены' : !plan?.goal && !dirty ? 'В мастер-плане нет единой личной цели — заполните её после обсуждения.' : ''}</span></div>
        </form> : <dl className="ipr-goal-readonly">{[['Цель развития', plan?.goal], ['Критерий результата', plan?.successCriteria], ['Необходимая поддержка', plan?.support], ['Дата обсуждения результата', plan?.reviewDate ? dateText(plan.reviewDate) : null]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd className={!value ? 'muted' : ''}>{value || 'Пока не согласовано'}</dd></div>)}</dl>}
      </section>}

      {view === 'actions' && <section className="ipr-content-section">
        <div className="section-heading"><div><h3>План действий</h3><p>Индивидуальная практика и назначенные мероприятия программы.</p></div><CalendarDays size={21}/></div>
        <div className="ipr-action-filters" aria-label="Тип действий">{[['individual', 'Индивидуальные'], ['all', 'Весь личный план'], ['group', 'Групповые'], ['team', 'Командные']].map(([type, label]) => <button type="button" key={type} className={eventFilter === type ? 'is-active' : ''} aria-pressed={eventFilter === type} onClick={() => setEventFilter(type)}>{label}<span>{personal.events.filter(event => type === 'all' || event.type === type).length}</span></button>)}</div>
        <div className="ipr-action-list">{events.map(event => <details className="ipr-action" key={event.id}>
          <summary><div className="ipr-action-date"><CalendarDays size={15}/>{dateText(event.date)}</div><div className="ipr-action-title"><span className={'badge ' + event.type}>{eventTypes[event.type] || event.type}</span><h4>{event.title}</h4><p>{event.skill || event.stage || 'Фокус не указан'}</p></div><span className={'ipr-attendance ' + (personal.confirmedIds.has(event.id) ? 'is-confirmed' : '')}>{personal.confirmedIds.has(event.id) ? 'Подтверждено' : event.status === 'draft' ? 'Черновик' : 'В плане'}</span><ChevronDown size={17}/></summary>
          <div className="ipr-action-details"><p>{event.description || 'Описание действия пока не заполнено.'}</p><dl>{[['Ожидаемый результат', event.expectedResult], ['Формат работы', event.format], ['Этап развития', event.stage], ['Связь с ИПР', event.planLink]].map(([label, value]) => value ? <div key={label}><dt>{label}</dt><dd>{value}</dd></div> : null)}</dl><button type="button" className="button secondary" onClick={() => onEvent(event)}>Открыть мероприятие<ArrowUpRight size={16}/></button></div>
        </details>)}</div>
        {!events.length && <div className="ipr-empty"><CalendarDays size={26}/><p>Действий этого типа пока нет в личном плане.</p></div>}
      </section>}

      {view === 'tasks' && <section className="ipr-content-section">
        <div className="section-heading"><div><h3>Практические задачи</h3><p>Применение в работе, подтверждение результата и оценка L&D по шкале 1–5.</p></div>{admin && <button type="button" className="button secondary" onClick={() => onNewTask(person.id)}><Plus size={17}/>Добавить задачу</button>}</div>
        <div className="ipr-task-list">{personal.tasks.map(task => <article className="ipr-task" key={task.id}>
          <div className="ipr-task-top"><span className={'status-badge ' + (task.status === 'done' ? 'success' : 'neutral')}>{taskStatuses[task.status] || 'Статус не указан'}</span><span>Срок: {dateText(task.dueDate)}</span></div><h4>{task.title}</h4>{task.description && <p>{task.description}</p>}
          {task.eventId && <p className="ipr-linked-event">Мероприятие: {personal.events.find(event => event.id === task.eventId)?.title || 'Связанное мероприятие недоступно в текущем плане'}</p>}
          <div className="ipr-task-result"><span>Оценка L&D</span><strong>{task.rating != null ? `${task.rating} / 5` : 'Пока не оценено'}</strong>{task.ratingComment && <p>{task.ratingComment}</p>}</div>
          {task.evidence && <details className="ipr-evidence"><summary>Подтверждение результата<ChevronDown size={15}/></summary><p>{task.evidence}</p></details>}
          <button type="button" className="button secondary" onClick={() => onTask(task)}>{admin ? 'Результат и оценка' : task.status === 'done' ? 'Посмотреть результат' : 'Отправить результат'}<ArrowUpRight size={16}/></button>
        </article>)}</div>
        {!personal.tasks.length && <div className="ipr-empty"><CheckCircle2 size={26}/><p>Практические задачи пока не добавлены.</p>{admin && <button type="button" className="button secondary" onClick={() => onNewTask(person.id)}><Plus size={17}/>Добавить первую задачу</button>}</div>}
      </section>}

      {view === 'skills' && <section className="ipr-content-section">
        <div className="section-heading"><div><h3>Карта навыков</h3><p>Оценка 0–5: стартовый уровень, текущий результат и цель.</p></div><Target size={21}/></div>
        <div className="ipr-skills-grid">{skills.map(skill => {
          const assessment = personal.assessments.find(entry => entry.skillId === skill.id);
          return <article className="ipr-skill" key={skill.id}><h4>{skill.name}</h4><div className="skill-scale" aria-label={assessment?.current != null ? `Текущий уровень ${assessment.current} из 5` : 'Навык пока не оценён'}>{[1, 2, 3, 4, 5].map(level => <i key={level} className={assessment?.current != null && assessment.current >= level ? 'filled' : ''}/>)}</div><div className="ipr-skill-values"><span>Старт<strong>{assessment?.baseline ?? '—'}</strong></span><span>Сейчас<strong>{assessment?.current ?? '—'}</strong></span><span>Цель<strong>{assessment?.target ?? '—'}</strong></span></div>{assessment?.evidence ? <p>{assessment.evidence}</p> : <p className="muted">Оценка и основание пока не внесены.</p>}{assessment?.date && <small>Дата оценки: {dateText(assessment.date)}</small>}</article>;
        })}</div>
        {!skills.length && <div className="ipr-empty"><Target size={26}/><p>Навыки программы пока не добавлены.</p></div>}
      </section>}
    </div>
  </dialog>;
}

export default DevelopmentPlans;
