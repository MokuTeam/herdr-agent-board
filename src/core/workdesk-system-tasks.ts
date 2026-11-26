export type WorkdeskSystemTask = {
  key: string
  title: string
  status: 'doing' | 'waiting' | 'done' | 'failed' | 'cancelled'
  updatedAt: number
  executor: string
  url: string
}

export type WorkdeskSystemTasksPayload =
  | { state: 'loading' | 'unavailable' }
  | { state: 'ready'; tasks: WorkdeskSystemTask[] }
