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
  /** Dated places, e.g. Ward A 1–15 Nov then Ward B 16–30 Nov; on those dates they replace `jobs`. */
  periods?: PlacePeriod[]
}

/** "Covers this place (job) only, from `from` to `to`" (both dates included). */
export interface PlacePeriod {
  jobId: string
  from: string
  to: string
}

/** Job ids a member may cover on a date: their dated places if one covers it, else `jobs` (empty = any). */
export function jobsOn(m: Member, date: string): string[] {
  const dated = (m.periods ?? []).filter((p) => p.from <= date && date <= p.to)
  return dated.length ? dated.map((p) => p.jobId) : m.jobs
}

/** May this member cover a place with this job on this date? A place with no job takes anyone. */
export function coversJob(m: Member, jobId: string | undefined, date: string) {
  if (!jobId) return true
  const jobs = jobsOn(m, date)
  return jobs.length === 0 || jobs.includes(jobId)
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
  /** Hospital mode: fewest students this place must have (count is the most). */
  min?: number
}

export interface ShiftSlot {
  id: string
  name: string
  start: string // "08:00"
  end: string // "16:00"
  /**
   * Days after the start day that the shift ends: 0 same day, 1 next day (08:00 → 20:00 tomorrow is 1).
   * Missing = worked out from the times (an end at or before the start is the next day).
   */
  endDays?: number
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
  /** Shifts each student must do (unless `auto`). */
  shiftsPerStudent: number
  /** Share equally: fill every student place (up to its "at most") and split them evenly, ±1 shift. */
  auto?: boolean
  /** Points per shift (e.g. weekday 1, weekend 2), kept about equal between students. */
  points?: PointSettings
  /** Keep a student from working with the same resident twice. */
  avoidRepeatResident?: boolean
  /** Keep a student from working with the same staff member (อาจารย์) twice. */
  avoidRepeatStaff?: boolean
  /** Never put the same two students together twice. */
  avoidRepeatPartner?: boolean
  /** Try to give every student a fellow student on at least one shift. */
  wantPartner?: boolean
  /** Shift slot id -> exactly how many of that slot each student does (replaces the single total when set). */
  perSlot?: Record<string, number>
  /** Fewest days between two shifts of the same student, whatever they asked for themselves. */
  minGap?: number
  /** Shift slots that must be shared evenly (at most 1 apart in a group) — points can't make up for fewer of them. */
  evenSlots?: string[]
}

/** `fromShiftId` meaning "on any shift the day before". */
export const ANY_SHIFT = '*'

/** "At least `count` presenters from people on this shift (and place) the day before / the same day." */
export interface PresenterSource {
  /** A shift slot id, or ANY_SHIFT. */
  shiftId: string
  /** One place (requirement) of that shift; missing = any of its places. */
  placeId?: string
  /** A place by name (job), e.g. ward 17C, on whichever shift has it (with ANY_SHIFT). */
  jobId?: string
  /**
   * Other shifts that count the same, e.g. the weekend version of a weekday night: someone on any of them
   * qualifies. A place picked on the main shift means the same place (job) on these.
   */
  orShiftIds?: string[]
  count: number
  /** 'before' (default): on that shift the day before, e.g. post-call. 'same': on it that same day. */
  when?: 'before' | 'same'
}

/** "On these days, `count` presentations; at least `fromCount` by people who were on `fromShiftId` the day before." */
export interface PresentationRule {
  id: string
  name: string
  days: number[]
  count: number
  /** A shift slot id, or ANY_SHIFT. */
  fromShiftId: string
  fromCount: number
  /** Who may present (generate mode). With a hospital roster, presenters are always students. */
  types: MemberType[]
  /** Who must be among the presenters; replaces fromShiftId/fromCount when set (those mirror the first source). */
  sources?: PresenterSource[]
  /** Single dates it runs on besides its weekdays. A one-day presentation has no weekdays and one date. */
  dates?: string[]
  /** How far back "the day before" sources look, in days: [2, 3] = on that shift 2 or 3 days before. Missing = [1, 1]. */
  daysBack?: DaysBack
  /** How much one presentation counts when sharing them out (and towards points): missing = 1 weekly, 2 one-day. */
  points?: number
}

/** [nearest, farthest] days before a presentation, each 1–7. */
export type DaysBack = [number, number]
export const LAST_NIGHT: DaysBack = [1, 1]

/** A presentation that happens on one date only (e.g. a case discussion), rather than every week. */
export const isOneDay = (rule: PresentationRule) => rule.days.length === 0 && (rule.dates?.length ?? 0) > 0

/** How much presenting once at this presentation counts (a one-day one is more work than a weekly one). */
export const presentationPoints = (rule: PresentationRule) => rule.points ?? (isOneDay(rule) ? 2 : 1)

/** Was someone on `shiftId` the shift this rule takes presenters from? */
export const fromRuleShift = (rule: PresentationRule, shiftId: string) => rule.fromShiftId === ANY_SHIFT || rule.fromShiftId === shiftId

/** Who may present: with a hospital roster only students are arranged, so only students present. */
export const presenterTypes = (config: SessionConfig, rule: PresentationRule): MemberType[] =>
  config.rosterMode === 'hospital' ? ['student'] : rule.types

/** A one-off change to a presentation rule on a single date. */
export interface PresentationOverride {
  date: string
  ruleId: string
  active: boolean
  count?: number
  fromCount?: number
  /** This date's own "days before" for the rule's sources. */
  daysBack?: DaysBack
}

/**
 * 'hospital': residents and staff come from the hospital's roster (typed or pasted into `duty`);
 * Wayneday only arranges students and presenters.
 * 'generate': Wayneday also schedules residents and staff.
 */
export type RosterMode = 'hospital' | 'generate'

/** Requirement id used when a swap or edit refers to a student's place on a shift. */
export const STUDENT_SLOT = 'student'

/** A shift's points = its day's points (weekday, weekend/holiday, or that date's own) × its slot's multiplier. */
export interface PointSettings {
  on: boolean
  weekday: number
  weekend: number
  /** Shift slot id -> multiplier; missing = 1. */
  shifts?: Record<string, number>
  /**
   * Final points set by hand for one shift slot, replacing the calculation: `slotId|weekday`, `slotId|weekend`
   * (weekends and holidays) or `slotId|YYYY-MM-DD` (that date only).
   */
  fixed?: Record<string, number>
  /** Most students' points may differ, as a percentage of the average (e.g. 20); missing = no limit. */
  maxDiff?: number
  /** Presenting counts towards points too: whoever presents less gets heavier shifts, and the other way round. */
  presentations?: boolean
}

export const DEFAULT_POINTS: PointSettings = { on: false, weekday: 1, weekend: 2 }

export interface SessionConfig {
  title: string
  rosterMode: RosterMode
  /** The hospital's resident/staff roster (hospital mode). */
  duty: Assignment[]
  /** Hospital mode: the hospital roster is left blank (not known); students are arranged without it. */
  noDuty?: boolean
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
  presentationOverrides: PresentationOverride[]
  /** Free-text rules the built-in solver can't express. */
  extraConditions: string
  /** Points for a single date (e.g. 3 the day before an exam), replacing its weekday/weekend points. */
  datePoints?: Record<string, number>
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
  /** Dates they'd rather not work, by how much it matters: 3 = really need it off, 2 = important, 1 = would rather not. */
  avoid?: AvoidDate[]
  /** When they pressed "I'm ready!" (finished filling in); missing = not yet. */
  ready?: number
}

export type AvoidLevel = 1 | 2 | 3
export interface AvoidDate {
  date: string
  level: AvoidLevel
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
  /** Hospital mode: which student place (job) on the shift. */
  requirementId?: string
  memberId: string
}

/** Roles in the hospital roster (hospital mode); stored as an Assignment's requirementId. */
export const DUTY_ROLES = ['resident', 'staff'] as const
export type DutyRole = (typeof DUTY_ROLES)[number]

export interface PresenterAssignment {
  date: string
  ruleId: string
  memberId: string
  /** Was on the rule's shift the day before. */
  postCall: boolean
}

/** The hospital roster students are arranged around: none when it's left blank. */
export const dutyOf = (config: SessionConfig): Assignment[] => (config.noDuty ? [] : config.duty)

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
  /** Only the poster and the hosts see it. */
  private?: boolean
  replies?: ConcernReply[]
  /** Member id → 1 (agree) or -1 (disagree). Stored in full; a viewer only gets their own (see visibleConcerns). */
  votes?: Record<string, 1 | -1>
  /** Filled in for the viewer: how many agree and disagree. */
  up?: number
  down?: number
}

export interface ConcernReply {
  id: string
  /** The member who replied, or 'host'. */
  memberId: string
  /** A host's name and role, when a host replied. */
  by?: string
  role?: 'owner' | 'cohost'
  text: string
  at: number
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
  /** Why the host changed them (e.g. it can't be fitted into the roster); the member sees it. */
  reason?: string
}

/** A host's private message to one member, shown on that member's page until they read it. */
export interface HostNote {
  id: string
  memberId: string
  text: string
  /** The host's name as everyone sees it ('' if unknown), and whether they're the host or a co-host. */
  by: string
  role: 'owner' | 'cohost'
  at: number
  /** When the member pressed "Got it". */
  readAt?: number
  /** Set when the note explains a host change to the member's answers: that change's id and what changed. */
  change?: { id: string; summary: string }
}

/** After the roster is final, everyone rates how it went (1–5 stars) and can write a comment. */
export const FEEDBACK_QUESTIONS = [
  { id: 'fair', text: 'How fair was your share of shifts?' },
  { id: 'days', text: 'How well were your days off and avoid requests respected?' },
  { id: 'pattern', text: 'How well did your shifts fit your pattern (spread out or grouped)?' },
  { id: 'easy', text: 'How easy was Wayneday to use?' },
  { id: 'overall', text: 'Overall, how happy are you with the final roster?' },
] as const

export interface Feedback {
  /** '' when a host is shown an anonymous answer. */
  memberId: string
  /** Question id -> 1–5 stars; a skipped question is missing. */
  ratings: Record<string, number>
  text: string
  /** Hosts see it without the name. */
  anonymous?: boolean
  at: number
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
  /** Host notes this viewer may see: all of them for hosts, their own for a member. */
  notes: HostNote[]
  /** Feedback this viewer may see: everyone's for hosts (anonymous ones without a name), their own for a member. */
  feedback: Feedback[]
  /** The hosts' unpublished arrangement (a practice run or preview), kept for next time. Only sent to hosts. */
  draft?: Draft | null
  /** Arrangements the hosts saved to look at again later (newest last). Only sent to hosts. */
  saved?: SavedArrangement[]
}

export interface SavedArrangement extends Draft {
  id: string
  name: string
}

export interface Draft {
  roster: Roster
  source: Schedule['source']
  /** Which arrangement it is, as shown to the host: "Option 3", a saved arrangement's name, "AI reply"… */
  name?: string
  /** The arranger's notes about it (e.g. presentations short on some days). */
  notes: string[]
  savedAt: number
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
      rosterMode: s.config.rosterMode ?? 'hospital',
      duty: s.config.duty ?? [],
      presentationOverrides: s.config.presentationOverrides ?? [],
      overrides: s.config.overrides ?? [],
      students: { ...DEFAULT_STUDENTS, ...s.config.students },
      presentations: s.config.presentations ?? [],
    },
    schedule: s.schedule ? { ...s.schedule, students: s.schedule.students ?? [], presenters: s.schedule.presenters ?? [] } : null,
    swaps: s.swaps ?? [],
    joinRequests: s.joinRequests ?? [],
    changes: s.changes ?? [],
    notes: s.notes ?? [],
    feedback: s.feedback ?? [],
  }
}

/** A colour (hue, 0–360) for each person, spread around the wheel in roster order so neighbours differ. */
export function personHue(config: Pick<SessionConfig, 'members'>, id: string): number | null {
  const i = config.members.findIndex((m) => m.id === id)
  return i < 0 ? null : Math.round((i * 137.508) % 360)
}
