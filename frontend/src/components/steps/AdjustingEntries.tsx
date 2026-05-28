import { useMemo, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { findAccount } from '../../data/accounts'
import { generateDraftJournalLinesFromAdjustingEntries } from '../../state/journalBuilder'
import type {
  AccountOption,
  AdjustingEntry,
  DepreciationScheduleItem,
  FutureReversalItem,
  PriorAccrual,
  SampleSession,
} from '../../types/session'
import { WorkpaperFrame } from '../layout/WorkpaperFrame'

interface AdjustingEntriesProps {
  session: SampleSession
  onSessionChange: Dispatch<SetStateAction<SampleSession>>
}

type AdjustingTab = 'reversals' | 'accruals' | 'depreciation'

const expenseAccounts = ['6100', '6210', '6320', '6380', '6700']
  .map((code) => findAccount(code))
  .filter((account): account is AccountOption => Boolean(account))

const liabilityAccounts = ['2110']
  .map((code) => findAccount(code))
  .filter((account): account is AccountOption => Boolean(account))

const formatMoney = (amount: number) =>
  new Intl.NumberFormat('en-MY', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)

const statusKey = (status: string) =>
  status
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

const statusClass = (status: string) => `badge badge-${statusKey(status)}`

const nextAdjustingId = (entries: AdjustingEntry[]) =>
  `ADJ-${String(entries.length + 1).padStart(2, '0')}`

const buildDepreciationAssets = (session: SampleSession) => {
  const existingByDocument = new Map(session.depreciationSchedule.map((item) => [item.documentId, item]))

  const fromReclassifications = session.reclassifyDecisions
    .filter((decision) => decision.reclassifyType === 'Asset purchase')
    .map((decision) => {
      const document = session.documents.find((item) => item.id === decision.documentId)
      if (!document) return undefined
      const existing = existingByDocument.get(document.id)
      const usefulLifeMonths = decision.usefulLifeMonths ?? existing?.usefulLifeMonths ?? 60
      const monthlyDepreciation =
        existing?.monthlyDepreciation ?? Number((document.amount / usefulLifeMonths).toFixed(2))

      return {
        id: existing?.id ?? `DEP-${document.id}`,
        documentId: document.id,
        assetDescription: document.party,
        assetAccount: `${decision.accountCode} - ${decision.accountName}`,
        purchaseDate: document.date,
        cost: document.amount,
        usefulLifeMonths,
        monthlyDepreciation,
        accumulatedDepreciationAccount: existing?.accumulatedDepreciationAccount ?? '1590 - Accumulated Depreciation',
        depreciationExpenseAccount: existing?.depreciationExpenseAccount ?? '6700 - Depreciation Expense',
        status: existing?.status ?? 'Ready to Post',
      } satisfies DepreciationScheduleItem
    })
    .filter((item): item is DepreciationScheduleItem => Boolean(item))

  const reclassDocumentIds = new Set(fromReclassifications.map((item) => item.documentId))
  const scheduleOnly = session.depreciationSchedule.filter((item) => !reclassDocumentIds.has(item.documentId))
  return [...fromReclassifications, ...scheduleOnly]
}

export function AdjustingEntries({ session, onSessionChange }: AdjustingEntriesProps) {
  const [activeTab, setActiveTab] = useState<AdjustingTab>('reversals')
  const [accrualForm, setAccrualForm] = useState({
    date: '31 Jan',
    description: 'Salary accrual - last 3 days Jan paid 5 Feb',
    expenseCode: '6100',
    liabilityCode: '2110',
    amount: 1200,
    reverseNextMonth: true,
    notes: 'Reverse in February when payroll payment is posted.',
  })

  const adjustingLines = useMemo(() => generateDraftJournalLinesFromAdjustingEntries(session), [session])
  const depreciationAssets = useMemo(() => buildDepreciationAssets(session), [session])
  const totalDebit = adjustingLines.reduce((sum, line) => sum + line.debit, 0)
  const totalCredit = adjustingLines.reduce((sum, line) => sum + line.credit, 0)
  const difference = Number((totalDebit - totalCredit).toFixed(2))
  const pendingCount = session.adjustingEntries.filter((entry) => entry.status === 'Pending Review').length
  const reverseCount = session.adjustingEntries.filter((entry) => entry.reverseNextMonth).length

  const expenseAccount = findAccount(accrualForm.expenseCode)
  const liabilityAccount = findAccount(accrualForm.liabilityCode)
  const accrualAmount = Number(accrualForm.amount || 0)
  const accrualValid = Boolean(
    accrualForm.description.trim() && expenseAccount && liabilityAccount && accrualAmount > 0,
  )

  const confirmReversal = (priorAccrual: PriorAccrual) => {
    const entryId = nextAdjustingId(session.adjustingEntries)
    onSessionChange((current) => ({
      ...current,
      priorAccruals: current.priorAccruals.map((item) =>
        item.id === priorAccrual.id ? { ...item, status: 'Reversed' } : item,
      ),
      adjustingEntries: [
        ...current.adjustingEntries,
        {
          id: entryId,
          date: priorAccrual.reversalDate,
          type: 'Reversal',
          description: `Reverse ${priorAccrual.description}`,
          debitAccount: priorAccrual.creditAccount,
          creditAccount: priorAccrual.debitAccount,
          amount: priorAccrual.originalAmount,
          reverseNextMonth: false,
          status: 'Reversed',
          sourceId: priorAccrual.id,
        },
      ],
    }))
  }

  const saveAccrual = () => {
    if (!accrualValid || !expenseAccount || !liabilityAccount) return

    const entryId = nextAdjustingId(session.adjustingEntries)
    const futureReversal: FutureReversalItem | undefined = accrualForm.reverseNextMonth
      ? {
          id: `FR-${entryId}`,
          adjustingEntryId: entryId,
          action: `Reverse ${accrualForm.description}`,
          entryReference: `DR: ${liabilityAccount.code}  CR: ${expenseAccount.code}`,
          amount: accrualAmount,
          duePeriod: 'February 2025',
          notes: accrualForm.notes || 'Reverse at the start of next month.',
        }
      : undefined

    onSessionChange((current) => ({
      ...current,
      adjustingEntries: [
        ...current.adjustingEntries,
        {
          id: entryId,
          date: accrualForm.date,
          type: 'Accrual',
          description: accrualForm.description.trim(),
          debitAccount: `${expenseAccount.code} - ${expenseAccount.name}`,
          creditAccount: `${liabilityAccount.code} - ${liabilityAccount.name}`,
          amount: accrualAmount,
          reverseNextMonth: accrualForm.reverseNextMonth,
          status: 'Posted',
          notes: accrualForm.notes,
        },
      ],
      futureReversalItems: futureReversal
        ? [...current.futureReversalItems.filter((item) => item.adjustingEntryId !== entryId), futureReversal]
        : current.futureReversalItems,
    }))
  }

  const postDepreciation = (asset: DepreciationScheduleItem) => {
    const entryId = nextAdjustingId(session.adjustingEntries)
    onSessionChange((current) => {
      const nextSchedule = [
        ...current.depreciationSchedule.filter((item) => item.documentId !== asset.documentId),
        { ...asset, status: 'Depreciation Posted' as const },
      ]

      const alreadyPosted = current.adjustingEntries.some(
        (entry) => entry.type === 'Depreciation' && entry.sourceId === asset.documentId,
      )

      return {
        ...current,
        depreciationSchedule: nextSchedule,
        adjustingEntries: alreadyPosted
          ? current.adjustingEntries
          : [
              ...current.adjustingEntries,
              {
                id: entryId,
                date: '31 Jan',
                type: 'Depreciation',
                description: `Depreciation - ${asset.assetDescription}`,
                debitAccount: asset.depreciationExpenseAccount,
                creditAccount: asset.accumulatedDepreciationAccount,
                amount: asset.monthlyDepreciation,
                reverseNextMonth: false,
                status: 'Depreciation Posted',
                sourceId: asset.documentId,
              },
            ],
      }
    })
  }

  return (
    <>
      <div className="wp1-summary-grid">
        <SummaryCard label="Total Adjusting Entries" tone="teal" value={session.adjustingEntries.length.toString()} />
        <SummaryCard label="Total Debit" tone="green" value={`RM ${formatMoney(totalDebit)}`} />
        <SummaryCard label="Total Credit" tone="green" value={`RM ${formatMoney(totalCredit)}`} />
        <SummaryCard
          label="Difference"
          tone={Math.abs(difference) < 0.01 ? 'green' : 'red'}
          value={`RM ${formatMoney(Math.abs(difference))}`}
        />
        <SummaryCard label="Pending Review" tone="orange" value={pendingCount.toString()} />
        <SummaryCard label="Reverse Next Month" tone="purple" value={reverseCount.toString()} />
      </div>

      <WorkpaperFrame
        period={session.client.period}
        subtitle="Period-end entries with no bank movement. These feed directly into the journal voucher."
        title="Adjusting Entries"
        footer={
          <>
            <div className="metric">
              <span>Adjusting Lines</span>
              <strong>{adjustingLines.length}</strong>
            </div>
            <div className="metric">
              <span>Future Reversals</span>
              <strong>{session.futureReversalItems.length}</strong>
            </div>
            <div className="metric">
              <span>Balanced</span>
              <strong className={Math.abs(difference) < 0.01 ? 'metric-ok' : 'metric-alert'}>
                {Math.abs(difference) < 0.01 ? 'Yes' : 'No'}
              </strong>
            </div>
          </>
        }
      >
        <div className="adjusting-tabs" role="tablist">
          <button
            className={activeTab === 'reversals' ? 'active' : ''}
            onClick={() => setActiveTab('reversals')}
            type="button"
          >
            Reversals
          </button>
          <button
            className={activeTab === 'accruals' ? 'active' : ''}
            onClick={() => setActiveTab('accruals')}
            type="button"
          >
            New Accruals
          </button>
          <button
            className={activeTab === 'depreciation' ? 'active' : ''}
            onClick={() => setActiveTab('depreciation')}
            type="button"
          >
            Depreciation
          </button>
        </div>

        {activeTab === 'reversals' ? (
          <ReversalsTab priorAccruals={session.priorAccruals} onConfirm={confirmReversal} />
        ) : null}

        {activeTab === 'accruals' ? (
          <AccrualsTab
            accrualForm={accrualForm}
            accrualValid={accrualValid}
            expenseAccount={expenseAccount}
            liabilityAccount={liabilityAccount}
            onSave={saveAccrual}
            onUpdate={setAccrualForm}
          />
        ) : null}

        {activeTab === 'depreciation' ? (
          <DepreciationTab assets={depreciationAssets} onPost={postDepreciation} />
        ) : null}
      </WorkpaperFrame>

      <AdjustingEntryList entries={session.adjustingEntries} />
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
  tone?: 'neutral' | 'green' | 'orange' | 'purple' | 'red' | 'teal'
}) {
  return (
    <article className={`summary-card tone-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  )
}

function ReversalsTab({
  priorAccruals,
  onConfirm,
}: {
  priorAccruals: PriorAccrual[]
  onConfirm: (priorAccrual: PriorAccrual) => void
}) {
  return (
    <div className="table-scroll">
      <table className="data-table adjusting-table">
        <thead>
          <tr>
            <th>Original Period</th>
            <th>Description</th>
            <th className="right">Original Amount</th>
            <th>Debit Account</th>
            <th>Credit Account</th>
            <th>Reversal Date</th>
            <th>Status</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {priorAccruals.map((item) => (
            <tr key={item.id}>
              <td>{item.originalPeriod}</td>
              <td>
                <strong>{item.description}</strong>
              </td>
              <td className="right amount-out">RM {formatMoney(item.originalAmount)}</td>
              <td className="mono">{item.debitAccount}</td>
              <td className="mono">{item.creditAccount}</td>
              <td>{item.reversalDate}</td>
              <td>
                <span className={item.status === 'Reversed' ? 'badge badge-reversed' : 'badge badge-pending'}>
                  {item.status}
                </span>
              </td>
              <td>
                <button
                  className="text-button adjust-action"
                  disabled={item.status === 'Reversed'}
                  onClick={() => onConfirm(item)}
                  type="button"
                >
                  Confirm Reversal
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function AccrualsTab({
  accrualForm,
  accrualValid,
  expenseAccount,
  liabilityAccount,
  onSave,
  onUpdate,
}: {
  accrualForm: {
    date: string
    description: string
    expenseCode: string
    liabilityCode: string
    amount: number
    reverseNextMonth: boolean
    notes: string
  }
  accrualValid: boolean
  expenseAccount?: AccountOption
  liabilityAccount?: AccountOption
  onSave: () => void
  onUpdate: Dispatch<
    SetStateAction<{
      date: string
      description: string
      expenseCode: string
      liabilityCode: string
      amount: number
      reverseNextMonth: boolean
      notes: string
    }>
  >
}) {
  const amount = Number(accrualForm.amount || 0)
  const isBalanced = amount > 0 && Boolean(expenseAccount && liabilityAccount)

  return (
    <div className="accrual-grid">
      <section className="accrual-form-card">
        <label>
          <span>Accrual date</span>
          <input
            value={accrualForm.date}
            onChange={(event) => onUpdate((current) => ({ ...current, date: event.target.value }))}
          />
        </label>
        <label>
          <span>Description</span>
          <input
            value={accrualForm.description}
            onChange={(event) => onUpdate((current) => ({ ...current, description: event.target.value }))}
          />
        </label>
        <label>
          <span>Expense account</span>
          <select
            value={accrualForm.expenseCode}
            onChange={(event) => onUpdate((current) => ({ ...current, expenseCode: event.target.value }))}
          >
            {expenseAccounts.map((account) => (
              <option key={account.code} value={account.code}>
                {account.code} - {account.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Accrued liability account</span>
          <select
            value={accrualForm.liabilityCode}
            onChange={(event) => onUpdate((current) => ({ ...current, liabilityCode: event.target.value }))}
          >
            {liabilityAccounts.map((account) => (
              <option key={account.code} value={account.code}>
                {account.code} - {account.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Amount</span>
          <input
            min="0"
            step="0.01"
            type="number"
            value={accrualForm.amount}
            onChange={(event) => onUpdate((current) => ({ ...current, amount: Number(event.target.value) }))}
          />
        </label>
        <label>
          <span>Notes</span>
          <input
            value={accrualForm.notes}
            onChange={(event) => onUpdate((current) => ({ ...current, notes: event.target.value }))}
          />
        </label>
        <div className="reverse-toggle">
          <span>Reverse next month?</span>
          <button
            className={accrualForm.reverseNextMonth ? 'selected' : ''}
            onClick={() => onUpdate((current) => ({ ...current, reverseNextMonth: true }))}
            type="button"
          >
            Yes
          </button>
          <button
            className={!accrualForm.reverseNextMonth ? 'selected' : ''}
            onClick={() => onUpdate((current) => ({ ...current, reverseNextMonth: false }))}
            type="button"
          >
            No
          </button>
        </div>
      </section>

      <section className="preview-card">
        <h3>Debit / Credit Preview</h3>
        <div className="preview-line">
          <span>DR {expenseAccount ? `${expenseAccount.code} - ${expenseAccount.name}` : 'Expense account'}</span>
          <strong>RM {formatMoney(amount)}</strong>
        </div>
        <div className="preview-line">
          <span>CR {liabilityAccount ? `${liabilityAccount.code} - ${liabilityAccount.name}` : 'Liability account'}</span>
          <strong>RM {formatMoney(amount)}</strong>
        </div>
        <div className={isBalanced ? 'balance-box ok' : 'balance-box error'}>
          <span>Difference</span>
          <strong>RM {formatMoney(isBalanced ? 0 : amount)}</strong>
        </div>
        <button className="primary-button" disabled={!accrualValid || !isBalanced} onClick={onSave} type="button">
          Save Accrual
        </button>
      </section>
    </div>
  )
}

function DepreciationTab({
  assets,
  onPost,
}: {
  assets: DepreciationScheduleItem[]
  onPost: (asset: DepreciationScheduleItem) => void
}) {
  if (!assets.length) {
    return (
      <div className="info-panel green">
        <strong>No asset depreciation ready</strong>
        <p>Capitalise an asset in WP1 first. Confirmed asset purchases will appear here.</p>
      </div>
    )
  }

  return (
    <div className="table-scroll">
      <table className="data-table adjusting-table depreciation-table">
        <thead>
          <tr>
            <th>Asset Description</th>
            <th>Asset Account</th>
            <th>Purchase Date</th>
            <th className="right">Cost</th>
            <th>Useful Life</th>
            <th className="right">Monthly Dep.</th>
            <th>Accum. Dep. Account</th>
            <th>Dep. Expense Account</th>
            <th>Status</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {assets.map((asset) => (
            <tr key={asset.id}>
              <td>
                <strong>{asset.assetDescription}</strong>
              </td>
              <td className="mono">{asset.assetAccount}</td>
              <td>{asset.purchaseDate}</td>
              <td className="right amount-out">RM {formatMoney(asset.cost)}</td>
              <td>{asset.usefulLifeMonths} months</td>
              <td className="right amount-in">RM {formatMoney(asset.monthlyDepreciation)}</td>
              <td className="mono">{asset.accumulatedDepreciationAccount}</td>
              <td className="mono">{asset.depreciationExpenseAccount}</td>
              <td>
                <span className={statusClass(asset.status)}>{asset.status}</span>
              </td>
              <td>
                <button
                  className="text-button adjust-action"
                  disabled={asset.status === 'Depreciation Posted'}
                  onClick={() => onPost(asset)}
                  type="button"
                >
                  Post Depreciation
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function AdjustingEntryList({ entries }: { entries: AdjustingEntry[] }) {
  return (
    <WorkpaperFrame
      period="Current session"
      subtitle="All confirmed and pending period-end entries."
      title="Adjusting Entry List"
    >
      <div className="table-scroll">
        <table className="data-table adjusting-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Description</th>
              <th>Debit Account</th>
              <th>Credit Account</th>
              <th className="right">Amount</th>
              <th>Reverse Next Month</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>{entry.date}</td>
                <td>
                  <span className="source source-adjusting">{entry.type}</span>
                </td>
                <td>
                  <strong>{entry.description}</strong>
                  {entry.notes ? <small>{entry.notes}</small> : null}
                </td>
                <td className="mono">{entry.debitAccount}</td>
                <td className="mono">{entry.creditAccount}</td>
                <td className="right amount-in">RM {formatMoney(entry.amount)}</td>
                <td>{entry.reverseNextMonth ? 'Yes' : 'No'}</td>
                <td>
                  <span className={statusClass(entry.status)}>{entry.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </WorkpaperFrame>
  )
}
