// Tiny translation layer. Strings are written in English in the code and looked up in the Thai
// dictionary when Thai is on; {name} placeholders are filled from `vars`.
import { TH } from './th.ts'

export type Lang = 'en' | 'th'

let lang: Lang = 'en'

export const getLang = () => lang
export function setLang(l: Lang) {
  lang = l
}

export function t(en: string, vars?: Record<string, string | number>): string {
  const tpl = lang === 'th' ? (TH[en] ?? en) : en
  return vars ? tpl.replace(/\{(\w+)\}/g, (m: string, k: string) => (k in vars ? String(vars[k]) : m)) : tpl
}

const TYPE_NAME = { resident: 'Resident', staff: 'Staff', student: 'Student' } as const
/** A member type (resident / staff / student) as shown to people. */
export const typeName = (type: keyof typeof TYPE_NAME) => t(TYPE_NAME[type])

/** Weekday names in the current language (0 = Sunday). */
export const weekdayShort = () => (lang === 'th' ? ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])
export const weekdayLetter = () => (lang === 'th' ? ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'] : ['S', 'M', 'T', 'W', 'T', 'F', 'S'])
export const weekdayLong = () =>
  lang === 'th'
    ? ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์']
    : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
