// The form of an AskUserQuestion call, as the board can answer it.
// The most a form the board answers may hold. Beyond that it is left to the terminal: a question
// or a label cut short would differ from what the screen shows.
export const LIMITS = {
  questions: 4,
  options: 8,
  question: 2000,
  header: 100,
  label: 500,
  description: 2000,
  preview: 8000,
}

export interface FormOption {
  label: string
  description: string
  preview?: string
}

export interface FormQuestion {
  question: string
  header: string
  multiSelect: boolean
  preview: boolean
  options: FormOption[]
}

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' ? (v as Rec) : null)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * The questions of an AskUserQuestion call: { question, header, multiSelect, preview, options:
 * [{ label, description, preview? }] }. null when the board cannot answer it for sure: no
 * questions, one without text or options, more or longer than LIMITS, two questions with the
 * same text (the answers are keyed by it) or two options with the same label.
 */
export function questionsOf(input: unknown): FormQuestion[] | null {
  const raw = rec(input)?.questions
  const list: unknown[] = Array.isArray(raw) ? raw : []
  if (!list.length || list.length > LIMITS.questions) return null
  const out: FormQuestion[] = []
  for (const q of list) {
    const rq = rec(q)
    const rawOptions: unknown[] = Array.isArray(rq?.options) ? rq.options : []
    if (!rawOptions.length || rawOptions.length > LIMITS.options) return null
    const options: FormOption[] = rawOptions.map(o => {
      const ro = rec(o)
      return {
        label: str(ro?.label).trim(),
        description: str(ro?.description).trim(),
        ...(str(ro?.preview).trim() ? { preview: str(ro?.preview) } : {}),
      }
    })
    const question: FormQuestion = {
      question: str(rq?.question).trim(),
      header: str(rq?.header).trim(),
      multiSelect: rq?.multiSelect === true,
      preview: options.some(o => o.preview),
      options,
    }
    const fits =
      question.question &&
      question.question.length <= LIMITS.question &&
      question.header.length <= LIMITS.header &&
      options.every(
        o =>
          o.label &&
          o.label.length <= LIMITS.label &&
          o.description.length <= LIMITS.description &&
          (o.preview ?? '').length <= LIMITS.preview,
      ) &&
      new Set(options.map(o => o.label)).size === options.length
    if (!fits) return null
    out.push(question)
  }
  return new Set(out.map(q => q.question)).size === out.length ? out : null
}
