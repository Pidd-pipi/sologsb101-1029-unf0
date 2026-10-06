/**
 * 按连戏编号（共同账）取时间轴最近两次现场记录做字段级比对，
 * 派生差异列表与严重程度。一个编号跨多场时，各场记录进同一条时间轴，
 * 撤下场次的记录不参与现行比对。
 * 被差异比对页、现场记录页与报告页共同消费。
 */
import { computed, type ComputedRef, type Ref } from 'vue'
import type { ConflictSeverity } from '@/types/conflict'
import type { ElementCategory } from '@/types/element'
import type { ShootDayRow, ElementRow, RecordRow, LedgerRow, SceneRow } from '@/utils/db'
import { describeDiffs, diffRecords, severityOf, sortBySeverity, type FieldDiff } from '@/utils/diff'

/** 一条候选差异：同一连戏编号最近两次记录之间的比对结果 */
export interface DiffCandidate {
  ledgerId: string
  continuityNo: string
  elementId: string
  elementName: string
  category: ElementCategory | string
  owner: string
  critical: boolean
  sceneId: string
  /** 该编号关联的全部场次 */
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
  /** 指定场次的差异条数（按编号关联场次归集） */
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
 * @param records    全部现场记录
 * @param elements   全部连戏要素（场次侧落点）
 * @param shootDays  全部拍摄日（用于把记录排到时间轴上）
 * @param ledgers    共同账（一编号挂多场的现行基准）
 * @param scenes     场次（撤下场次不参与现行比对）
 */
export function useContinuityDiff(
  records: Ref<RecordRow[]>,
  elements: Ref<ElementRow[]>,
  shootDays: Ref<ShootDayRow[]>,
  ledgers?: Ref<LedgerRow[]>,
  scenes?: Ref<SceneRow[]>
): ContinuityDiffResult {
  const candidates = computed<DiffCandidate[]>(() => {
    const result: DiffCandidate[] = []
    const withdrawn = new Set((scenes?.value ?? []).filter((scene) => scene.withdrawn).map((scene) => scene.id))
    const ledgerList = ledgers?.value ?? []

    // 以共同账编号归组；没有共同账信息的旧记录退回要素归组
    const groups = new Map<string, RecordRow[]>()
    records.value.forEach((record) => {
      const key = record.ledgerId ? `lg:${record.ledgerId}` : `el:${record.elementId}`
      const list = groups.get(key) ?? []
      list.push(record)
      groups.set(key, list)
    })

    groups.forEach((groupRecords) => {
      const usable = groupRecords.filter((record) => !withdrawn.has(record.sceneId))
      const own = buildTimeline(usable, shootDays.value)
      if (own.length < 2) return
      const a = own[own.length - 2]
      const b = own[own.length - 1]
      const diffs = diffRecords(a, b)
      const ledger = ledgerList.find((item) => item.id === a.ledgerId)
      if (ledger && ledger.status === '停用') return
      const latestElement = elements.value.find((item) => item.id === b.elementId)
      const fallbackElement = elements.value.find((item) => item.id === a.elementId)
      const element = latestElement ?? fallbackElement
      const critical = ledger?.critical ?? element?.critical ?? false
      const severity = severityOf(diffs, critical)
      if (!severity) return
      result.push({
        ledgerId: a.ledgerId,
        continuityNo: a.continuityNo,
        elementId: b.elementId,
        elementName: ledger?.name ?? element?.name ?? '未命名要素',
        category: ledger?.category ?? element?.category ?? '道具',
        owner: ledger?.owner ?? element?.owner ?? '',
        critical,
        sceneId: b.sceneId,
        sceneIds: ledger?.sceneIds ?? [a.sceneId],
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
    countByScene: (sceneId: string) =>
      candidates.value.filter((item) => item.sceneIds.includes(sceneId)).length
  }
}
