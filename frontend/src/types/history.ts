/**
 * 共同账历史痕迹（只追加，永不删除/改写）。
 * 差异重新比对、条目停用、档案归并、冲突处置等动作都会落一条历史，
 * 「历史和已处理痕迹不能丢」靠这张表兜底。
 */

/** 历史动作类型 */
export type HistoryAction =
  | '归并' // 旧数据重复档案按编号归并
  | '隔离' // 缺编号的旧档案转入隔离区
  | '建档'
  | '编辑'
  | '更新基准'
  | '现场记录'
  | '撤场' // 从编号关联场次中撤下某场
  | '停用'
  | '重新启用'
  | '冲突处置'
  | '差异待重算'
  | '差异生成'
  | '差异归档'
  | '差异恢复'
  | '回滚恢复' // 从提交前 checkpoint 恢复账面
  | '隔离确认'
  | '导入'

export interface LedgerHistoryEntry {
  id: string
  /** ISO 时间 */
  at: string
  /** 关联的共同账条目；隔离阶段尚无条目的动作（隔离/导入）允许为空 */
  ledgerId: string
  /** 关联连戏编号，便于按编号检索（隔离条目用占位编号） */
  code: string
  action: HistoryAction
  /** 可读说明 */
  detail: string
  /** 动作涉及的旧值/新值等结构化快照（可选） */
  snapshot?: Record<string, unknown>
}
