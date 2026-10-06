/** 差异严重程度 */
export type ConflictSeverity = '轻微' | '需处理' | '阻断'
/** 差异处理状态 */
export type ConflictState = '待确认' | '已解决'

/**
 * 连戏差异：同一连戏编号两次现场记录之间的字段级偏差。
 * stale=true 表示「待重算」：关联场次被撤下、编号停用、现场记录更新后，
 * 这条差异所依据的账面已经变化，不再计入报告风险，直到重新比对。
 */
export interface Conflict {
  id: string
  /** 连戏编号共同账条目 */
  ledgerId: string
  /** 较早的记录 */
  recordIdA: string
  /** 较晚的记录 */
  recordIdB: string
  /** 差异描述 */
  diffDesc: string
  /** 严重程度 */
  severity: ConflictSeverity
  /** 处理状态 */
  state: ConflictState
  /** 解决留痕（解决时间与处理说明） */
  resolvedNote: string
  /** 解决时间（ISO，未解决为空串） */
  resolvedAt: string
  /** 待重算标记：依据变更后立即置真，重新比对期间由新条目取代 */
  stale: boolean
  /** 转为待重算的原因（撤场 / 停用 / 记录更新等） */
  staleReason: string
  /** 转为待重算的 ISO 时间 */
  staleAt: string
}

export const CONFLICT_SEVERITIES: ConflictSeverity[] = ['轻微', '需处理', '阻断']
export const CONFLICT_STATES: ConflictState[] = ['待确认', '已解决']

export function createEmptyConflict(): Omit<Conflict, 'id' | 'resolvedNote' | 'resolvedAt' | 'stale' | 'staleReason' | 'staleAt'> {
  return { ledgerId: '', recordIdA: '', recordIdB: '', diffDesc: '', severity: '轻微', state: '待确认' }
}
