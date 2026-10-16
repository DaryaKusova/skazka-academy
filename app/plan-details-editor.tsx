'use client';

import { Plus, Trash2, ChevronDown, Check, ClipboardList } from 'lucide-react';
import { PLAN_SECTIONS, type PlanDetails, type PlanDiagnostic, type PlanSectionKey } from '../lib/development-plan';

type Props = { value: PlanDetails; editable: boolean; busy: boolean; dirty: boolean; saved: boolean; onChange: (value: PlanDetails) => void; onSave: () => void };
const showDate = (date: string | null) => date ? new Date(date + 'T12:00:00').toLocaleDateString('ru-RU') : 'Не указан';

export default function PlanDetailsEditor({ value, editable, busy, dirty, saved, onChange, onSave }: Props) {
  function field(key: keyof PlanDetails, next: unknown) { onChange({ ...value, [key]: next }); }
  function updateCell(key: PlanSectionKey, id: string, column: number, text: string) {
    field('sections', { ...value.sections, [key]: value.sections[key].map(row => row.id === id ? { ...row, cells: row.cells.map((cell, index) => index === column ? text : cell) } : row) });
  }
  function addRow(key: PlanSectionKey) { field('sections', { ...value.sections, [key]: [...value.sections[key], { id: crypto.randomUUID(), cells: ['', '', '', '', ''] }] }); }
  function removeRow(key: PlanSectionKey, id: string) { field('sections', { ...value.sections, [key]: value.sections[key].filter(row => row.id !== id) }); }
  function diagnostic(id: string, key: keyof PlanDiagnostic, next: string | number | null) { field('diagnostics', value.diagnostics.map(row => row.id === id ? { ...row, [key]: next } : row)); }
  const count = PLAN_SECTIONS.reduce((sum, section) => sum + value.sections[section.key].length, 0);

  return <section className="ipr-content-section ipr-details-editor">
    <div className="section-heading"><div><h3>Подробный план развития</h3><p>Приоритеты, рабочая практика и контрольные точки.</p></div><ClipboardList size={21}/></div>
    {editable && <p className="ipr-template-note">Единая структура для команды. Заполняйте содержание под сотрудника; мероприятия его календаря уже доступны в разделе «План действий».</p>}
    <form onSubmit={event => { event.preventDefault(); onSave(); }} onInvalidCapture={event => { const section = (event.target as HTMLElement).closest('details'); if (section) section.open = true; }}>
    <fieldset disabled={busy} className="ipr-details-fields">
      <div className="ipr-period">
        {editable ? <><label>Начало периода<input type="date" value={value.periodStart || ''} onChange={event => field('periodStart', event.target.value || null)}/></label><label>Конец периода<input type="date" value={value.periodEnd || ''} onChange={event => field('periodEnd', event.target.value || null)}/></label></> : <><div><span>Начало периода</span><strong>{showDate(value.periodStart)}</strong></div><div><span>Конец периода</span><strong>{showDate(value.periodEnd)}</strong></div></>}
        <div className="ipr-filled-count"><span>Содержание ИПР</span><strong>{count} записей</strong></div>
      </div>
      {PLAN_SECTIONS.map(section => <details className="ipr-plan-section" key={section.key} open={section.key === 'priorities' ? true : undefined}>
        <summary><span>{section.title}</span><b>{value.sections[section.key].length}</b><ChevronDown size={18}/></summary>
        <div className="ipr-plan-section-body">
          {!value.sections[section.key].length && <p className="ipr-section-empty">{editable ? 'Добавьте первую запись в этот раздел.' : 'Раздел пока не заполнен.'}</p>}
          {value.sections[section.key].map((row, index) => <article className="ipr-detail-row" key={row.id}>
            <div className="ipr-row-heading"><span>Запись {String(index + 1).padStart(2, '0')}</span>{editable && <button type="button" className="icon-button" aria-label={`Удалить запись ${index + 1}: ${section.title}`} onClick={() => removeRow(section.key, row.id)}><Trash2 size={16}/></button>}</div>
            <div className="ipr-detail-grid">{section.columns.map((label, column) => editable ? <label key={column} className={column === 0 ? 'ipr-wide-field' : ''}>{label}<textarea rows={column === 0 ? 2 : 4} maxLength={10000} value={row.cells[column] || ''} onChange={event => updateCell(section.key, row.id, column, event.target.value)} placeholder={section.key === 'checkpoints' && column === 0 ? 'Дата или срок — если согласованы' : 'Заполните после обсуждения'}/></label> : <div key={column} className={'ipr-read-field ' + (column === 0 ? 'ipr-wide-field' : '')}><span>{label}</span><p className={!row.cells[column] ? 'muted' : ''}>{row.cells[column] || 'Пока не согласовано'}</p></div>)}</div>
          </article>)}
          {editable && <button type="button" className="button secondary" onClick={() => addRow(section.key)} disabled={value.sections[section.key].length >= 50}><Plus size={17}/>Добавить запись</button>}
        </div>
      </details>)}
      <details className="ipr-plan-section ipr-diagnostic-section">
        <summary><span>Самооценка и внешняя оценка</span><b>{value.diagnostics.length}</b><ChevronDown size={18}/></summary>
        <div className="ipr-plan-section-body">
          <p className="ipr-scale-note">Оценки из оснований ИПР — до 10 баллов. Самооценка и внешняя оценка сохраняются раздельно. Они не меняют автоматически карту навыков и XP.</p>
          <div className="ipr-detail-grid ipr-source-fields">{(['selfAssessmentSource', 'externalAssessmentSource'] as const).map((key, i) => editable ? <label key={key}>{i === 0 ? 'Источник самооценки' : 'Источник внешней оценки'}<textarea rows={2} maxLength={10000} value={value[key]} onChange={event => field(key, event.target.value)}/></label> : <div className="ipr-read-field" key={key}><span>{i === 0 ? 'Источник самооценки' : 'Источник внешней оценки'}</span><p>{value[key] || 'Не указан'}</p></div>)}</div>
          {!value.diagnostics.length && <p className="ipr-section-empty">Оценки ещё не внесены.</p>}
          {value.diagnostics.map((row, index) => <article className="ipr-detail-row" key={row.id}>
            <div className="ipr-row-heading"><span>Компетенция {index + 1}</span>{editable && <button type="button" className="icon-button" aria-label={`Удалить оценку ${index + 1}`} onClick={() => field('diagnostics', value.diagnostics.filter(item => item.id !== row.id))}><Trash2 size={16}/></button>}</div>
            <div className="ipr-detail-grid">
              {editable ? <label className="ipr-wide-field">Компетенция<input required value={row.competency} maxLength={600} onChange={event => diagnostic(row.id, 'competency', event.target.value)}/></label> : <h4 className="ipr-wide-field">{row.competency || 'Компетенция не указана'}</h4>}
              <div className="ipr-diagnostic-scores ipr-wide-field">{(['selfScore', 'externalScore'] as const).map((key, i) => editable ? <label key={key}>{i === 0 ? 'Самооценка / 10' : 'Оценка CEO / внешняя / 10'}<input type="number" min={0} max={10} step="any" value={row[key] ?? ''} onChange={event => diagnostic(row.id, key, event.target.value === '' ? null : Number(event.target.value))} placeholder="Не оценено"/></label> : <div key={key}><span>{i === 0 ? 'Самооценка' : 'CEO / внешняя'}</span><strong>{row[key] == null ? 'Не оценено' : `${row[key]} / 10`}</strong></div>)}</div>
              {(['employeeComment', 'planResponse'] as const).map((key, i) => editable ? <label key={key}>{i === 0 ? 'Что указывает сотрудник' : 'Как учтено в ИПР'}<textarea rows={4} maxLength={10000} value={row[key]} onChange={event => diagnostic(row.id, key, event.target.value)}/></label> : <div className="ipr-read-field" key={key}><span>{i === 0 ? 'Что указывает сотрудник' : 'Как учтено в ИПР'}</span><p>{row[key] || 'Не заполнено'}</p></div>)}
            </div>
          </article>)}
          {editable && <button type="button" className="button secondary" disabled={value.diagnostics.length >= 50} onClick={() => field('diagnostics', [...value.diagnostics, { id: crypto.randomUUID(), competency: '', selfScore: null, externalScore: null, employeeComment: '', planResponse: '' }])}><Plus size={17}/>Добавить компетенцию</button>}
        </div>
      </details>
      <details className="ipr-plan-section"><summary><span>Источник и примечания</span><ChevronDown size={18}/></summary><div className="ipr-plan-section-body">{editable ? <label>Источник и примечания<textarea rows={4} maxLength={10000} value={value.sourceNote} onChange={event => field('sourceNote', event.target.value)}/></label> : <p className="ipr-source-note">{value.sourceNote || 'Не указаны'}</p>}</div></details>
    </fieldset>
    {editable && <div className="ipr-save-row ipr-details-save"><button type="submit" className="button primary" disabled={busy || !dirty}><Check size={17}/>{busy ? 'Сохраняем…' : 'Сохранить ИПР'}</button><span role="status">{saved ? 'ИПР сохранён' : dirty ? 'Есть несохранённые изменения' : 'Изменения доступны сотруднику после сохранения'}</span></div>}
    </form>
  </section>;
}
