/**
 * 连戏共同账（Continuity Ledger）
 * 一个连戏编号 = 一份共同账：可挂多个场次，只认一份当前基准（baseline）。
 * 现场记录按编号归到账下，差异处置也只挂在账上，避免同编号每场各建一份档案、各拿旧基准。
 */

/** 共同账状态 */
export type LedgerStatus = '在用' | '停用'

/** 差异 / 报告风险的重算状态 */
export type StaleState = '现行' | '待重算'

/** 待重算的触发原因 */
export type StaleReason = '场次撤下' | '道具停用' | '现场记录更新' | '旧档归并' | '基准变更' | '差异处置'

/** 隔离待确认数据的处理状态 */
export type QuarantineState = '待确认' | '已确认'

export const LEDGER_STATUSES: LedgerStatus[] = ['在用', '停用']
export const STALE_STATES: StaleState[] = ['现行', '待重算']
export const QUARANTINE_STATES: QuarantineState[] = ['待确认', '已确认']

/** 共同账当前基准的字段口径（与现场记录对齐） */
export interface LedgerBaseline {
  /** 基准状态描述 */
  state: string
  /** 基准照片说明 */
  photoNote: string
}

/** 连戏共同账：一个连戏编号挂多场，只认一份当前基准 */
export interface ContinuityLedger {
  id: string
  /** 连戏编号（共同账唯一，同编号旧档案按它归并） */
  code: string
  /** 要素类别 服装 / 道具 / 妆发 / 陈设 */
  category: string
  /** 要素 / 道具名称 */
  name: string
  /** 关联场次（一个编号可挂多场） */
  sceneIds: string[]
  /** 当前基准（全场次只认这一份） */
  baseline: LedgerBaseline
  /** 责任人 */
  owner: string
  /** 是否关键 */
  critical: boolean
  /** 在用 / 停用（撤下道具走停用，历史与差异痕迹保留） */
  status: LedgerStatus
  /** 乐观锁版本：打开编辑时读到的存储版本，落后写入即判为并发 */
  version: number
}

/** 共同账变更历史（基准变更、场次挂接、停用等都留痕，不可物理删除） */
export interface LedgerHistoryEntry {
  id: string
  /** 所属共同账 */
  ledgerId: string
  /** 连戏编号冗余，便于账被删后仍可读 */
  code: string
  /** 动作：创建 / 更新基准 / 挂接场次 / 撤下场次 / 停用 / 重新启用 / 旧档归并 / 隔离确认 / 差异处置 */
  action: string
  /** 变更说明 */
  detail: string
  /** 操作人（现场标签页身份） */
  actor: string
  /** 变更前的字段快照（用于追溯与恢复） */
  before: Partial<ContinuityLedger> | null
  /** 变更后的字段快照 */
  after: Partial<ContinuityLedger> | null
  /** ISO 时间 */
  at: string
}

/**
 * 两个标签页同时提交同一编号时，落后一方保留下来的表格草稿。
 * 草稿不入主账，只在此表等待「合并 / 覆盖 / 放弃」。
 */
export interface LedgerDraft {
  id: string
  /** 目标共同账（新账并发时为空，按 code 匹配） */
  ledgerId: string
  /** 连戏编号 */
  code: string
  /** 落后方编辑时所依据的版本 */
  baseVersion: number
  /** 先落地一方写入后的版本 */
  currentVersion: number
  /** 落后方提交的字段（表格草稿） */
  payload: Partial<ContinuityLedger>
  /** 双方不同的字段名列表 */
  differingFields: string[]
  /** 先落地一方的字段值快照（便于对照） */
  currentSnapshot: Partial<ContinuityLedger> | null
  /** 落后方标签页身份 */
  actor: string
  /** 创建时间 */
  createdAt: number
}

/** 缺编号的旧档案先隔离待确认，不自动并账也不删除 */
export interface QuarantineItem {
  id: string
  /** 来源旧要素档案 id */
  sourceElementId: string
  /** 来源旧要素档案的完整快照 */
  snapshot: Record<string, unknown>
  /** 待确认 / 已确认 */
  state: QuarantineState
  /** 隔离原因 */
  reason: string
  createdAt: number
  updatedAt: number
}

/** 提交共同账前的账面快照：写入失败时按它恢复到提交前状态 */
export interface LedgerCommitSnapshot {
  ledger: ContinuityLedger | null
  history: LedgerHistoryEntry[]
  /** 本次提交涉及的差异处置回滚信息（由 db 层填充） */
  conflicts?: Array<{ id: string; before: Record<string, unknown> | null }>
}

export function createEmptyLedger(): Omit<ContinuityLedger, 'id' | 'version'> {
  return {
    code: '',
    category: '道具',
    name: '',
    sceneIds: [],
    baseline: { state: '', photoNote: '' },
    owner: '',
    critical: false,
    status: '在用'
  }
}

/** 字段中文标签（并发差异列表、历史留痕复用） */
export const LEDGER_FIELD_LABELS: Record<string, string> = {
  code: '连戏编号',
  category: '类别',
  name: '名称',
  sceneIds: '关联场次',
  owner: '责任人',
  critical: '关键标记',
  status: '状态',
  'baseline.state': '基准状态',
  'baseline.photoNote': '基准照片说明'
}
