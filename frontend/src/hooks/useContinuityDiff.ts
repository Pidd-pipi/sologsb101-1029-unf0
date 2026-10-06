/**
 * 按连戏编号取最近两次有效现场记录做字段级比对，派生差异列表与严重程度。
 * 撤场/停用/作废的记录（voided）不参与比对；停用编号不出候选。
 * 被差异比对页、现场记录页与报告页共同消费。
 */
import { computed, type ComputedRef, type Ref } from 'vue'
import type { ConflictSeverity } from '@/types/conflict'
import type { ElementCategory } from '@/types/element'
import type { ShootDayRow, LedgerRow, RecordRow } from '@/utils/db'
import { describeDiffs, diffRecords, severityOf, sortBySeverity, type FieldDiff } from '@/utils/diff'

/** 一条候选差异：同一编号最近两次有效记录之间的比对结果 */
export interface DiffCandidate {
  ledgerId: string
  ledgerCode: string
  elementName: string
  category: ElementCategory
  owner: string
  critical: boolean
  /** 候选涉及的全部关联场次（一个编号可挂多场） */
  sceneIds: string[]
  /** 较早的一次记录 */
  a: RecordRow
  /** 较晚的一次记录 */
  b: RecordRow
  diffs: FieldDiff[]
  severity: ConflictSeverity
  desc: string
}

export interface ContinuityDiffResult {
  /** 全部存在差异的候选条目（按严重程度倒序） */
  candidates: ComputedRef<DiffCandidate[]>
  /** 差异条目数 */
  diffCount: ComputedRef<number>
  /** 阻断级差异数 */
  blockingCount: ComputedRef<number>
  /** 指定编号是否存在差异 */
  hasDiff: (ledgerId: string) => boolean
  /** 指定场次涉及的差异条数（编号挂多场时各场都计入） */
  countByScene: (sceneId: string) => number
}

/** 记录时间轴：先按拍摄日日期，再按镜次排序 */
function buildTimeline(records: RecordRow[], shootDays: ShootDayRow[]): RecordRow[] {
  const dateOf = (record: RecordRow): string =>
    shootDays.find((day) => day.id === record.shootDayId)?.date ?? ''
  return [...records].sort(
    (a, b) =>
      dateOf(a).localeCompare(dateOf(b)) ||
      a.takeNo.localeCompare(b.takeNo, 'zh-Hans-CN')
  )
}

/**
 * @param records    全部现场记录（含作废，内部过滤）
 * @param ledgers    全部连戏编号共同账
 * @param shootDays  全部拍摄日（用于把记录排到时间轴上）
 */
export function useContinuityDiff(
  records: Ref<RecordRow[]>,
  ledgers: Ref<LedgerRow[]>,
  shootDays: Ref<ShootDayRow[]>
): ContinuityDiffResult {
  const candidates = computed<DiffCandidate[]>(() => {
    const activeRecords = records.value.filter((record) => !record.voided)
    const result: DiffCandidate[] = []
    ledgers.value
      .filter((ledger) => ledger.status === '在用')
      .forEach((ledger) => {
        const own = buildTimeline(
          activeRecords.filter((record) => record.ledgerId === ledger.id),
          shootDays.value
        )
        if (own.length < 2) return
        const a = own[own.length - 2]
        const b = own[own.length - 1]
        const diffs = diffRecords(a, b)
        const severity = severityOf(diffs, ledger.critical)
        if (!severity) return
        result.push({
          ledgerId: ledger.id,
          ledgerCode: ledger.code,
          elementName: ledger.name,
          category: ledger.category,
          owner: ledger.owner,
          critical: ledger.critical,
          sceneIds: [...ledger.sceneIds],
          a,
          b,
          diffs,
          severity,
          desc: describeDiffs(diffs)
        })
      })
    return sortBySeverity(result)
  })

  return {
    candidates,
    diffCount: computed(() => candidates.value.length),
    blockingCount: computed(() => candidates.value.filter((item) => item.severity === '阻断').length),
    hasDiff: (ledgerId: string) => candidates.value.some((item) => item.ledgerId === ledgerId),
    countByScene: (sceneId: string) => candidates.value.filter((item) => item.sceneIds.includes(sceneId)).length
  }
}
