import type { PublicSession } from './shared/types.ts'

export interface Me {
  isHost: boolean
  memberId: string | null
}
export interface SessionView {
  session: PublicSession
  me: Me
}
