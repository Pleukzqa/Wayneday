// Data model shared by the browser app and the API server.

/** Students are never placed by the main roster; they're arranged afterwards around the residents/staff. */
export type MemberType = 'resident' | 'staff' | 'student'
export type WorkerType = 'resident' | 'staff'

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

/** One position inside a shift: e.g. "ER, 1 resident". 'any' = resident or staff. */
export interface Requirement {
  id: string
  jobId: string
  memberType: WorkerType | 'any'
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

/** A one-off change to the weekly pattern on a single date. */
export interface DateOverride {
  date: string
  shiftId: string
  /** Whether the shift runs that day (can switch on a shift that normally doesn't run). */
  active: boolean
  /** Requirement id -> how many people that day. Missing = the usual count. */
  counts?: Record<string, number>
}

export interface StudentSettings {
  /** Shift slots students join. */
  shiftIds: string[]
  /** Most students on one shift at once. */
  maxPerShift: number
  /** Shifts each student must do. */
  shiftsPerStudent: number
}

/** "On these days, `count` presentations; at least `fromCount` by people who were on `fromShiftId` the day before." */
export interface PresentationRule {
  id: string
  name: string
  days: number[]
  count: number
  fromShiftId: string
  fromCount: number
  types: MemberType[]
}

export interface SessionConfig {
  title: string
  startDate: string // YYYY-MM-DD
  endDate: string // YYYY-MM-DD
  /** Dates treated like weekends for fairness (public holidays). */
  holidays: string[]
  jobs: Job[]
  shifts: ShiftSlot[]
  overrides: DateOverride[]
  members: Member[]
  students: StudentSettings
  presentations: PresentationRule[]
  /** Free-text rules the built-in solver can't express. */
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
  /** Set when the host last changed this member's answers. */
  editedByHost?: number
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

export interface StudentAssignment {
  date: string
  shiftId: string
  memberId: string
}

export interface PresenterAssignment {
  date: string
  ruleId: string
  memberId: string
  /** Was on the rule's shift the day before. */
  postCall: boolean
}

export type ScheduleStatus = 'review' | 'final'

export interface Schedule {
  status: ScheduleStatus
  assignments: Assignment[]
  students: StudentAssignment[]
  presenters: PresenterAssignment[]
  generatedAt: number
  /** End of the concern period (ms epoch). */
  reviewUntil: number
  source: 'solver' | 'ai' | 'manual'
}

/** Everything a roster contains, published or not. */
export interface Roster {
  assignments: Assignment[]
  students: StudentAssignment[]
  presenters: PresenterAssignment[]
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

export interface SwapOffer {
  id: string
  memberId: string
  /** The offerer's own shift given in exchange; absent = they simply take the shift. */
  give?: { date: string; shiftId: string; requirementId: string }
  createdAt: number
}

export type SwapStatus = 'open' | 'agreed' | 'approved' | 'declined' | 'cancelled'

export interface SwapRequest {
  id: string
  memberId: string
  date: string
  shiftId: string
  requirementId: string
  note: string
  status: SwapStatus
  offers: SwapOffer[]
  acceptedOfferId?: string
  createdAt: number
  resolvedAt?: number
}

export interface JoinRequest {
  id: string
  name: string
  type: MemberType
  status: 'pending' | 'approved' | 'rejected'
  memberId?: string
  createdAt: number
}

/** A host change to someone else's answers, kept so the member can see and undo it. */
export interface AnswerChange {
  id: string
  memberId: string
  at: number
  before: MemberResponse | null
  summary: string
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
  swaps: SwapRequest[]
  joinRequests: JoinRequest[]
  changes: AnswerChange[]
}

export const DEFAULT_RESPONSE: MemberResponse = {
  preference: 'distributed',
  minInterval: 2,
  unavailable: [],
  locks: [],
  note: '',
  updatedAt: 0,
}

export const DEFAULT_STUDENTS: StudentSettings = { shiftIds: [], maxPerShift: 1, shiftsPerStudent: 4 }

/** Fill fields added after a session was created. */
export function normalizeSession(s: PublicSession): PublicSession {
  return {
    ...s,
    config: {
      ...s.config,
      overrides: s.config.overrides ?? [],
      students: { ...DEFAULT_STUDENTS, ...s.config.students },
      presentations: s.config.presentations ?? [],
    },
    schedule: s.schedule ? { ...s.schedule, students: s.schedule.students ?? [], presenters: s.schedule.presenters ?? [] } : null,
    swaps: s.swaps ?? [],
    joinRequests: s.joinRequests ?? [],
    changes: s.changes ?? [],
  }
}
