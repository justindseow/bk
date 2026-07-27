import { tracker } from '@openreplay/tracker'

const projectKey = (import.meta.env.VITE_OPENREPLAY_PROJECT_KEY || '').trim()
const ingestPoint = (import.meta.env.VITE_OPENREPLAY_INGEST_POINT || '').trim()
const trackingEnabled = (import.meta.env.VITE_OPENREPLAY_TRACKING_ENABLED || 'true').trim().toLowerCase() !== 'false'

let initialized = false

type TelemetryPrimitive = string | number | boolean | null | undefined
type TelemetryPayload = Record<string, TelemetryPrimitive>

const normalizePayload = (payload: TelemetryPayload = {}) =>
  Object.fromEntries(
    Object.entries(payload)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 120) : value]),
  )

export const telemetryIsEnabled = () => trackingEnabled && Boolean(projectKey)

export const initTelemetry = async () => {
  if (!telemetryIsEnabled() || initialized) return

  tracker.configure({
    projectKey,
    ...(ingestPoint ? { ingestPoint } : {}),
    defaultInputMode: 1,
    obscureInputDates: true,
    obscureInputEmails: true,
    obscureInputNumbers: true,
    network: {
      capturePayload: false,
      captureInIframes: false,
      failuresOnly: false,
      ignoreHeaders: true,
      sessionTokenHeader: false,
    },
  })

  initialized = true

  try {
    const result = await tracker.start()
    if (result.success) {
      tracker.event('session_started', {
        session_id: result.sessionID,
        session_mode: 'browser_only',
      })
    }
  } catch {
    // Keep telemetry non-blocking for BK testing.
  }
}

export const telemetryEvent = (eventName: string, payload: TelemetryPayload = {}) => {
  if (!telemetryIsEnabled()) return
  try {
    tracker.event(eventName, normalizePayload(payload))
  } catch {
    // Ignore telemetry failures so bookkeeping flow is unaffected.
  }
}

export const telemetryIssue = (eventName: string, payload: TelemetryPayload = {}) => {
  if (!telemetryIsEnabled()) return
  try {
    tracker.issue(eventName, normalizePayload(payload))
  } catch {
    // Ignore telemetry failures so bookkeeping flow is unaffected.
  }
}

export const telemetryMetadata = (key: string, value: string | number | boolean | null | undefined) => {
  if (!telemetryIsEnabled() || value === undefined || value === null || value === '') return
  try {
    tracker.setMetadata(key, String(value).slice(0, 120))
  } catch {
    // Ignore telemetry failures so bookkeeping flow is unaffected.
  }
}

export const telemetrySessionUrl = () => {
  if (!telemetryIsEnabled()) return undefined
  try {
    return tracker.getSessionURL()
  } catch {
    return undefined
  }
}
