import type { Me, SessionView } from '../api.ts'
import type { PublicSession } from '../shared/types.ts'

export interface SessionProps {
  code: string
  session: PublicSession
  me: Me
  mutate: (fn: () => Promise<SessionView>) => Promise<SessionView>
}

export const uid = () => Math.random().toString(36).slice(2, 10)
