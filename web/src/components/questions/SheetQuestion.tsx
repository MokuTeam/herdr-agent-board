// The form in the session sheet's #sheet-question: the question form or the permission prompt the
// session waits on (hooks/useQuestions.ts), drawn again whenever what is picked on it changes.
import { useMediaQuery } from '../../hooks/useMediaQuery.ts'
import type { Questions } from '../../hooks/useQuestions.ts'
import { useBoardContext } from '../../state/BoardProvider.tsx'
import { useStore } from '../../state/store.ts'
import { PermissionPrompt } from './PermissionPrompt.tsx'
import { QuestionForm } from './QuestionForm.tsx'

/** The keys are offered only where there is a keyboard to press them on. */
const POINTER_FINE = '(pointer: fine)'

export function SheetQuestion({ questions }: { questions: Questions }) {
  useStore(questions.version)
  const { canMutate } = useBoardContext()
  const pointerFine = useMediaQuery(POINTER_FINE)
  const { desk } = questions
  const view = desk.view()
  if (!view) return null
  const { shown, form, peek } = view
  if (shown.kind === 'permission') return <PermissionPrompt shown={shown} form={form} canMutate={canMutate} on={desk} />
  return (
    <QuestionForm shown={shown} form={form} peek={peek} canMutate={canMutate} pointerFine={pointerFine} on={desk} />
  )
}
