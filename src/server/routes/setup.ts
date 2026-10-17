// The setup check (services/setup-check.ts): run again on request, the whole list with the summary.
import type { SetupChecks } from '../../services/setup-check.ts'
import { json, type Route } from '../http.ts'

export function setupRoute(setup: SetupChecks): Route {
  return {
    method: 'GET',
    path: '/api/setup',
    handle: async () => json(200, { checks: await setup.now(), ...setup.summary() }),
  }
}
