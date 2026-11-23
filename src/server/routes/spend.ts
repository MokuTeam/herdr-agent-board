// On-demand token spend route (#636): GET /api/spend?[day=<d>|from=<d>&to=<d>][&lane=<id>]
import { t } from '../../core/lang.ts'
import { dateIn, isDate, MAX_SPEND_DAYS, spanLength } from '../../core/spend.ts'
import type { Config, Item } from '../../core/types.ts'
import type { Deps } from '../../services/deps.ts'
import { collectSpend, spendZone } from '../../services/spend.ts'
import { json, type Route } from '../http.ts'

export function spendRoutes({
  cfg,
  deps,
  items,
}: {
  cfg: Config
  deps: Pick<Deps, 'profiles' | 'homes' | 'codex'>
  items: () => Item[]
}): Route[] {
  return [
    {
      method: 'GET',
      path: '/api/spend',
      async handle(_req, ctx) {
        const url = ctx.url
        const zone = spendZone(cfg)
        const today = dateIn(Date.now(), zone)
        const day = url.searchParams.get('day')
        const from = url.searchParams.get('from')
        const to = url.searchParams.get('to')
        const lane = url.searchParams.get('lane')?.trim() || null

        let rangeFrom: string
        let rangeTo: string
        if (day !== null) {
          if (from !== null || to !== null || !isDate(day)) {
            return json(400, { ok: false, error: t('spend.err.usage') })
          }
          rangeFrom = day
          rangeTo = day
        } else if (from !== null || to !== null) {
          rangeFrom = from ?? ''
          rangeTo = to ?? today
          const len = isDate(rangeFrom) && isDate(rangeTo) ? spanLength(rangeFrom, rangeTo) : 0
          if (len < 1 || len > MAX_SPEND_DAYS) {
            return json(400, { ok: false, error: t('spend.err.usage') })
          }
        } else {
          rangeFrom = today
          rangeTo = today
        }

        const report = await collectSpend({
          cfg,
          deps,
          items: items(),
          from: rangeFrom,
          to: rangeTo,
          lane,
          zone,
        })
        return json(200, report)
      },
    },
  ]
}
