import type { PublicSession } from './shared/types.ts'

export interface Me {
  isHost: boolean
  memberId: string | null
  /** Waiting for the host to approve this device's join request. */
  pendingJoinId?: string | null
}
export interface SessionView {
  session: PublicSession
  me: Me
}
