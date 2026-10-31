import type { PublicSession } from './shared/types.ts'
import type { Account } from './account.ts'

export interface Me {
  isHost: boolean
  /** owner: made the session (or holds its host link); cohost: added by the owner. */
  hostRole?: 'owner' | 'cohost' | null
  memberId: string | null
  /** Waiting for the host to approve this device's join request. */
  pendingJoinId?: string | null
}
export interface HostInfo {
  email: string
  name: string
  role: 'owner' | 'cohost'
  addedAt: number
}
/** Who runs the session, as everyone sees it: names only, no emails. */
export interface Organizer {
  /** Their Google name; empty for a co-host who hasn't signed in yet (only their email is known). */
  name: string
  role: 'owner' | 'cohost'
}
export interface SessionView {
  session: PublicSession
  me: Me
  /** Only sent to hosts. */
  hosts?: HostInfo[]
  organizers?: Organizer[]
}
export interface MySession {
  code: string
  title: string
  startDate: string
  endDate: string
  role: 'owner' | 'cohost'
  status: 'collecting' | 'review' | 'final'
}
export type { Account }
