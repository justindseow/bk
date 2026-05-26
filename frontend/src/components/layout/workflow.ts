import type { WorkflowStepId } from '../../types/session'

export interface WorkflowStep {
  id: WorkflowStepId
  number: string
  title: string
  shortTitle: string
  eyebrow: string
}

export const workflowSteps: WorkflowStep[] = [
  {
    id: 'collection',
    number: '01',
    title: 'Document Collection',
    shortTitle: 'Collection',
    eyebrow: 'Before tool starts',
  },
  {
    id: 'wp1',
    number: '02',
    title: 'WP1 Document Posting Ledger',
    shortTitle: 'WP1 Ledger',
    eyebrow: 'Source documents',
  },
  {
    id: 'wp2',
    number: '03',
    title: 'WP2 Bank Verification',
    shortTitle: 'WP2 Verify',
    eyebrow: 'Bank verification',
  },
  {
    id: 'adjusting',
    number: '04',
    title: 'Adjusting Entries',
    shortTitle: 'Adjusting',
    eyebrow: 'Period end',
  },
  {
    id: 'review',
    number: '05',
    title: 'Review and Validation',
    shortTitle: 'Review',
    eyebrow: 'Checks',
  },
  {
    id: 'journal',
    number: '06',
    title: 'Journal Voucher',
    shortTitle: 'JV',
    eyebrow: 'Posting output',
  },
  {
    id: 'handover',
    number: '07',
    title: 'Handover Note',
    shortTitle: 'Handover',
    eyebrow: 'Next session',
  },
  {
    id: 'download',
    number: '08',
    title: 'Excel Download',
    shortTitle: 'Download',
    eyebrow: 'Export',
  },
]
