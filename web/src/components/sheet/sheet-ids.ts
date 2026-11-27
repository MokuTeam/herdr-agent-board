import { createContext, useContext } from 'react'

/** Page shortcuts address the foreground sheet. The retained sidebar uses its own document IDs. */
export const SheetIds = createContext('')

export function useSheetId(): (part: string) => string {
  const prefix = useContext(SheetIds)
  return part => prefix + part
}
