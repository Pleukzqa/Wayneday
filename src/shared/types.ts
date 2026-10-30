// Data model shared by the browser app and the API server.

export type MemberType = 'resident' | 'staff'

export interface Member {
  id: string
  name: string
  type: MemberType
  /** Job ids this member may cover. Empty = any job. */
  jobs: string[]
  /** Optional hard cap on the number of shifts for this member. */
  maxShifts?: number
}

export interface Job {
  id: string
  name: string
}

/** One position inside a shift: e.g. "ER, 1 resident". */
export interface Requirement {
  id: string
  jobId: string
  memberType: MemberType | 'any'
  count: number
}

export interface ShiftSlot {
  id: string
  name: string
  start: string // "08:00"
  end: string // "16:00"
  /** Weekdays this shift runs (0 = Sunday). */
  days: number[]
  requirements: Requirement[]
}

export interface SessionConfig {
  title: string
  startDate: string // YYYY-MM-DD
  endDate: string // YYYY-MM-DD
  /** Dates treated like weekends for fairness (public holidays). */
  holidays: string[]
  jobs: Job[]
  shifts: ShiftSlot[]
  members: Member[]
  /** Free-text rules the built-in solver can't express (e.g. morning round). */
  extraConditions: string
}

export type Preference = 'distributed' | 'dense'

export interface MemberResponse {
  preference: Preference
  /** Minimum number of days between the dates of two shifts (1 = consecutive days allowed). */
  minInterval: number
  /** Dates (YYYY-MM-DD) the member can't work at all. */
  unavailable: string[]
  /** Cells the member must be assigned to. */
  locks: Lock[]
  note: string
  updatedAt: number
}

export interface Lock {
  date: string
  shiftId: string
}

export interface Assignment {
  date: string
  shiftId: string
  requirementId: string
  memberId: string
}

export type ScheduleStatus = 'review' | 'final'

export interface Schedule {
  status: ScheduleStatus
  assignments: Assignment[]
  generatedAt: number
  /** End of the concern period (ms epoch). */
  reviewUntil: number
  source: 'solver' | 'ai' | 'manual'
}

export interface Concern {
  id: string
  memberId: string
  text: string
  date?: string
  shiftId?: string
  createdAt: number
  resolved: boolean
}

/** What the API returns to every participant (no secrets). */
export interface PublicSession {
  code: string
  createdAt: number
  version: number
  config: SessionConfig
  /** Member ids that have been claimed by someone logging in. */
  claimed: string[]
  responses: Record<string, MemberResponse>
  schedule: Schedule | null
  concerns: Concern[]
}

export const DEFAULT_RESPONSE: MemberResponse = {
  preference: 'distributed',
  minInterval: 2,
  unavailable: [],
  locks: [],
  note: '',
  updatedAt: 0,
}
