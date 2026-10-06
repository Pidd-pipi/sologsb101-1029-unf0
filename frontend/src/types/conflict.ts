/** 差异严重程度 */
export type ConflictSeverity = '轻微' | '需处理' | '阻断'
/** 差异处理状态 */
export type ConflictState = '待确认' | '已解决'
/** 重算状态：现场改动后涉及差异立即转待重算，报告风险同步剔除 */
export type ConflictStaleState = '现行' | '待重算'

/**
 * 连戏差异：同一连戏编号（共同账）两次现场记录之间的字段级偏差。
 * 场次撤下、道具停用、记录更新后，涉及它的差异立即转为「待重算」，
 * 不删除旧条目：重算后更新或保留，无法重算的自动关闭并留痕。
 */
export interface Conflict {
  id: string
  /** 连戏共同账（旧数据迁移后回填） */
  ledgerId: string
  /** 连戏编号冗余 */
  continuityNo: string
  /** 连戏要素（场次侧落点，保留兼容） */
  elementId: string
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
  /** 现行 / 待重算 */
  stale: ConflictStaleState
  /** 待重算原因：场次撤下 / 道具停用 / 现场记录更新 / 旧档归并 / 基准变更 */
  staleReason: string
  /** 解决留痕（解决时间与处理说明） */
  resolvedNote: string
  /** 解决时间（ISO，未解决为空串） */
  resolvedAt: string
}

export const CONFLICT_SEVERITIES: ConflictSeverity[] = ['轻微', '需处理', '阻断']
export const CONFLICT_STATES: ConflictState[] = ['待确认', '已解决']
export const CONFLICT_STALE_STATES: ConflictStaleState[] = ['现行', '待重算']

export function createEmptyConflict(): Omit<Conflict, 'id' | 'resolvedNote' | 'resolvedAt'> {
  return {
    ledgerId: '',
    continuityNo: '',
    elementId: '',
    recordIdA: '',
    recordIdB: '',
    diffDesc: '',
    severity: '轻微',
    state: '待确认',
    stale: '现行',
    staleReason: ''
  }
}
