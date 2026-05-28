import { useEffect, useMemo, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import {
  buildGeneratedHandoverItems,
  nextPeriodLabel,
  refreshGeneratedHandoverItems,
  voucherReference,
} from '../../state/handoverBuilder'
import { buildValidationResults, calculateWp2Reconciliation } from '../../state/validation'
import type {
  HandoverCategory,
  HandoverItem,
  HandoverPriority,
  HandoverStatus,
  SampleSession,
} from '../../types/session'
import { WorkpaperFrame } from '../layout/WorkpaperFrame'

interface HandoverNoteProps {
  session: SampleSession
  onSessionChange: Dispatch<SetStateAction<SampleSession>>
}

type ManualFormState = {
  id?: string
  category: HandoverCategory
  priority: HandoverPriority
  description: string
  amount: string
  dueTiming: string
}

const categories: HandoverCategory[] = [
  'Must Do First Next Month',
  'Items to Watch in Next Bank Statement',
  'Recurring Monthly Entries',
  'Opening Balance Reference',
  'Schedules to Carry Forward',
  'Manual Notes',
]

const priorities: HandoverPriority[] = ['High', 'Medium', 'Low']

const emptyManualForm = (): ManualFormState => ({
  category: 'Manual Notes',
  priority: 'Medium',
  description: '',
  amount: '',
  dueTiming: 'Next session',
})

const formatMoney = (amount?: number) => {
  if (amount === undefined || Number.isNaN(amount)) return '-'
  return `RM ${new Intl.NumberFormat('en-MY', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)}`
}

const statusClass = (status: string) =>
  `badge badge-${status
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}`

const priorityClass = (priority: HandoverPriority) => `handover-priority ${priority.toLowerCase()}`

const sourceClass = (sourceStep: HandoverItem['sourceStep']) =>
  `handover-source handover-source-${sourceStep.toLowerCase()}`

const itemCountByCategory = (items: HandoverItem[], category: HandoverCategory) =>
  items.filter((item) => item.category === category).length

const buildPreviewText = (session: SampleSession, items: HandoverItem[]) => {
  const nextPeriod = nextPeriodLabel(session.client.period)
  const grouped = categories
    .map((category) => ({
      category,
      items: items.filter((item) => item.category === category),
    }))
    .filter((group) => group.items.length)

  const lines = [
    `${session.client.entityName}`,
    `Handover Note for ${nextPeriod}`,
    `Prepared from ${session.client.period} session`,
    '',
    ...grouped.flatMap((group) => [
      group.category,
      ...group.items.map(
        (item) =>
          `- [${item.priority}] ${item.description}${
            item.amount !== undefined ? ` (${formatMoney(item.amount)})` : ''
          } - ${item.dueTiming}`,
      ),
      '',
    ]),
  ]

  return lines.join('\n').trim()
}

export function HandoverNote({ session, onSessionChange }: HandoverNoteProps) {
  const [manualForm, setManualForm] = useState<ManualFormState>(emptyManualForm)
  const validation = useMemo(() => buildValidationResults(session), [session])
  const reconciliation = useMemo(() => calculateWp2Reconciliation(session), [session])
  const nextPeriod = nextPeriodLabel(session.client.period)

  useEffect(() => {
    if (session.handoverItems.length) return
    onSessionChange((current) => ({
      ...current,
      handoverItems: refreshGeneratedHandoverItems(current),
    }))
  }, [onSessionChange, session.handoverItems.length])

  const allItems = [...session.handoverItems, ...session.manualHandoverItems]
  const groupedItems = categories.map((category) => ({
    category,
    items: allItems.filter((handoverItem) => handoverItem.category === category),
  }))
  const previewText = buildPreviewText(session, allItems)

  const updateItemStatus = (id: string, generated: boolean, status: HandoverStatus) => {
    onSessionChange((current) => ({
      ...current,
      handoverItems: generated
        ? current.handoverItems.map((item) => (item.id === id ? { ...item, status } : item))
        : current.handoverItems,
      manualHandoverItems: generated
        ? current.manualHandoverItems
        : current.manualHandoverItems.map((item) => (item.id === id ? { ...item, status } : item)),
    }))
  }

  const resetGeneratedChecklist = () => {
    onSessionChange((current) => ({
      ...current,
      handoverItems: buildGeneratedHandoverItems(current),
    }))
  }

  const editManualItem = (item: HandoverItem) => {
    setManualForm({
      id: item.id,
      category: item.category,
      priority: item.priority,
      description: item.description,
      amount: item.amount === undefined ? '' : String(item.amount),
      dueTiming: item.dueTiming,
    })
  }

  const deleteManualItem = (id: string) => {
    onSessionChange((current) => ({
      ...current,
      manualHandoverItems: current.manualHandoverItems.filter((item) => item.id !== id),
    }))
    if (manualForm.id === id) setManualForm(emptyManualForm())
  }

  const saveManualItem = () => {
    const description = manualForm.description.trim()
    if (!description) return

    const amount = Number(manualForm.amount)
    const manualItem: HandoverItem = {
      id: manualForm.id ?? `manual-${Date.now()}`,
      category: manualForm.category,
      priority: manualForm.priority,
      description,
      sourceStep: 'Manual',
      amount: manualForm.amount.trim() ? amount : undefined,
      dueTiming: manualForm.dueTiming.trim() || 'Next session',
      status: 'Open',
      generated: false,
    }

    onSessionChange((current) => ({
      ...current,
      manualHandoverItems: manualForm.id
        ? current.manualHandoverItems.map((item) =>
            item.id === manualForm.id ? { ...manualItem, status: item.status } : item,
          )
        : [...current.manualHandoverItems, manualItem],
    }))
    setManualForm(emptyManualForm())
  }

  return (
    <>
      <section className="handover-warning-stack">
        {!session.journalVoucherFinalised ? (
          <div className="handover-warning">
            <strong>Journal Voucher has not been finalised yet.</strong>
            <span>Handover note can be prepared, but should be reviewed again after finalisation.</span>
          </div>
        ) : null}
        {!validation.ready ? (
          <div className="handover-warning critical">
            <strong>There are unresolved validation issues.</strong>
            <span>Complete Review and Validation before relying on this handover note.</span>
          </div>
        ) : null}
      </section>

      <div className="wp1-summary-grid handover-summary-grid">
        <SummaryCard label="Total Items" tone="blue" value={allItems.length.toString()} />
        <SummaryCard
          label="Must Do First"
          tone="red"
          value={itemCountByCategory(allItems, 'Must Do First Next Month').toString()}
        />
        <SummaryCard
          label="Bank Watch"
          tone="orange"
          value={itemCountByCategory(allItems, 'Items to Watch in Next Bank Statement').toString()}
        />
        <SummaryCard
          label="Recurring"
          tone="teal"
          value={itemCountByCategory(allItems, 'Recurring Monthly Entries').toString()}
        />
        <SummaryCard
          label="Schedules"
          tone="purple"
          value={itemCountByCategory(allItems, 'Schedules to Carry Forward').toString()}
        />
        <SummaryCard label="Manual Notes" value={session.manualHandoverItems.length.toString()} />
        <SummaryCard
          label="JV Status"
          tone={session.journalVoucherFinalised ? 'green' : 'orange'}
          value={session.journalVoucherFinalised ? 'Finalised' : 'Open'}
        />
      </div>

      <WorkpaperFrame
        period={nextPeriod}
        subtitle={`Generated from ${session.client.period} session continuity items.`}
        title="Handover Note - Next Session Checklist"
        footer={
          <>
            <div className="metric">
              <span>Adjusted Book</span>
              <strong>{formatMoney(reconciliation.adjustedBook)}</strong>
            </div>
            <div className="metric">
              <span>Validation</span>
              <strong className={validation.ready ? 'metric-ok' : 'metric-alert'}>
                {validation.ready ? 'Ready' : 'Review'}
              </strong>
            </div>
            <button className="secondary-button" onClick={resetGeneratedChecklist} type="button">
              Reset Generated Checklist
            </button>
          </>
        }
      >
        <OpeningBalanceReference
          adjustedBookBalance={reconciliation.adjustedBook}
          session={session}
          validationReady={validation.ready}
        />

        <div className="handover-layout">
          <section className="handover-checklist">
            {groupedItems.map((group) => (
              <ChecklistSection
                group={group}
                key={group.category}
                onDeleteManual={deleteManualItem}
                onEditManual={editManualItem}
                onStatusChange={updateItemStatus}
              />
            ))}
          </section>

          <aside className="handover-side-panel">
            <ManualNoteForm
              form={manualForm}
              onCancel={() => setManualForm(emptyManualForm())}
              onChange={setManualForm}
              onSave={saveManualItem}
            />
            <HandoverPreview previewText={previewText} />
          </aside>
        </div>
      </WorkpaperFrame>
    </>
  )
}

function SummaryCard({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: string
  tone?: 'neutral' | 'green' | 'orange' | 'purple' | 'red' | 'teal' | 'blue'
}) {
  return (
    <article className={`summary-card tone-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  )
}

function OpeningBalanceReference({
  adjustedBookBalance,
  session,
  validationReady,
}: {
  adjustedBookBalance: number
  session: SampleSession
  validationReady: boolean
}) {
  return (
    <section className="handover-opening-card">
      <div>
        <span>Entity</span>
        <strong>{session.client.entityName}</strong>
      </div>
      <div>
        <span>Closing Bank Balance</span>
        <strong>{formatMoney(48320)}</strong>
      </div>
      <div>
        <span>Adjusted Book Balance</span>
        <strong>{formatMoney(adjustedBookBalance)}</strong>
      </div>
      <div>
        <span>Journal Voucher</span>
        <strong>{session.journalVoucherFinalised ? voucherReference(session.client.period) : 'Not finalised'}</strong>
      </div>
      <div>
        <span>Validation</span>
        <strong className={validationReady ? 'amount-in' : 'amount-out'}>
          {validationReady ? 'Ready' : 'Review required'}
        </strong>
      </div>
      <div>
        <span>Prepared Date</span>
        <strong>{new Date().toLocaleDateString('en-MY')}</strong>
      </div>
    </section>
  )
}

function ChecklistSection({
  group,
  onDeleteManual,
  onEditManual,
  onStatusChange,
}: {
  group: { category: HandoverCategory; items: HandoverItem[] }
  onDeleteManual: (id: string) => void
  onEditManual: (item: HandoverItem) => void
  onStatusChange: (id: string, generated: boolean, status: HandoverStatus) => void
}) {
  return (
    <section className="handover-section">
      <div className="handover-section-head">
        <h3>{group.category}</h3>
        <span>{group.items.length}</span>
      </div>
      {group.items.length ? (
        <div className="table-scroll">
          <table className="data-table handover-table">
            <thead>
              <tr>
                <th>Priority</th>
                <th>Description</th>
                <th>Source</th>
                <th className="right">Amount</th>
                <th>Due Timing</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {group.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <span className={priorityClass(item.priority)}>{item.priority}</span>
                  </td>
                  <td>
                    <strong>{item.description}</strong>
                    {!item.generated ? <small>Manual note</small> : null}
                  </td>
                  <td>
                    <span className={sourceClass(item.sourceStep)}>{item.sourceStep}</span>
                  </td>
                  <td className="right">{formatMoney(item.amount)}</td>
                  <td>{item.dueTiming}</td>
                  <td>
                    <span className={statusClass(item.status)}>{item.status}</span>
                  </td>
                  <td>
                    <div className="action-group handover-actions">
                      <button
                        className="text-button"
                        disabled={item.status === 'Noted'}
                        onClick={() => onStatusChange(item.id, item.generated, 'Noted')}
                        type="button"
                      >
                        Mark Noted
                      </button>
                      <button
                        className="text-button"
                        disabled={item.status === 'Not applicable'}
                        onClick={() => onStatusChange(item.id, item.generated, 'Not applicable')}
                        type="button"
                      >
                        Not Applicable
                      </button>
                      {!item.generated ? (
                        <>
                          <button className="text-button" onClick={() => onEditManual(item)} type="button">
                            Edit
                          </button>
                          <button className="text-button" onClick={() => onDeleteManual(item.id)} type="button">
                            Delete
                          </button>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="handover-empty">No items in this section yet.</div>
      )}
    </section>
  )
}

function ManualNoteForm({
  form,
  onCancel,
  onChange,
  onSave,
}: {
  form: ManualFormState
  onCancel: () => void
  onChange: (form: ManualFormState) => void
  onSave: () => void
}) {
  const canSave = form.description.trim().length > 0

  return (
    <section className="handover-card manual-note-card">
      <div className="handover-card-head">
        <h3>{form.id ? 'Edit Manual Item' : 'Add Manual Item'}</h3>
        {form.id ? (
          <button className="text-button" onClick={onCancel} type="button">
            Cancel Edit
          </button>
        ) : null}
      </div>
      <label>
        <span>Category</span>
        <select
          value={form.category}
          onChange={(event) => onChange({ ...form, category: event.target.value as HandoverCategory })}
        >
          {categories.map((category) => (
            <option key={category}>{category}</option>
          ))}
        </select>
      </label>
      <label>
        <span>Priority</span>
        <select
          value={form.priority}
          onChange={(event) => onChange({ ...form, priority: event.target.value as HandoverPriority })}
        >
          {priorities.map((priority) => (
            <option key={priority}>{priority}</option>
          ))}
        </select>
      </label>
      <label>
        <span>Description</span>
        <textarea
          value={form.description}
          onChange={(event) => onChange({ ...form, description: event.target.value })}
          rows={3}
        />
      </label>
      <label>
        <span>Amount</span>
        <input
          min="0"
          type="number"
          value={form.amount}
          onChange={(event) => onChange({ ...form, amount: event.target.value })}
        />
      </label>
      <label>
        <span>Due Timing</span>
        <input
          value={form.dueTiming}
          onChange={(event) => onChange({ ...form, dueTiming: event.target.value })}
        />
      </label>
      <button className="primary-button" disabled={!canSave} onClick={onSave} type="button">
        {form.id ? 'Save Manual Item' : 'Add Manual Item'}
      </button>
    </section>
  )
}

function HandoverPreview({ previewText }: { previewText: string }) {
  return (
    <section className="handover-card handover-preview">
      <div className="handover-card-head">
        <h3>Handover Preview</h3>
      </div>
      <pre>{previewText}</pre>
    </section>
  )
}
