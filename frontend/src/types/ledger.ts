/**
 * 连戏编号共同账（Ledger）：同一个连戏编号只认这一份档案。
 * 一个编号可挂多个场次（sceneIds），所有关联场次共享同一份当前基准
 * （baselineState），现场记录与差异处置都挂在编号下，不再每场各建一份档案。
 */
import type { ElementCategory } from './element'

/** 道具/要素使用状态 */
export type LedgerStatus = '在用' | '停用'

/** 共同账条目的可编辑字段（编号本身可改，改后仍保持唯一） */
export interface LedgerFields {
  /** 连戏编号，如 LX-017（全库唯一，重复编号的旧档案会归并到同一编号） */
  code: string
  /** 关联场次（一个编号可挂多场，至少一场） */
  sceneIds: string[]
  category: ElementCategory
  /** 道具/服装等名称 */
  name: string
  /** 当前基准：全编号唯一一份，现场改过以后以解决回写的最新状态为准 */
  baselineState: string
  /** 责任人 */
  owner: string
  /** 是否关键要素（差异按阻断处理） */
  critical: boolean
  /** 在用 / 停用（停用后新差异不再生成，既有差异转待重算） */
  status: LedgerStatus
}

export interface Ledger extends LedgerFields {
  id: string
  /**
   * 已处理痕迹：该编号历次差异处置记录，只追加。
   * 差异重新比对/归档不影响这里，保证「已处理痕迹不能丢」。
   */
  resolutions: LedgerResolution[]
}

export const LEDGER_STATUSES: LedgerStatus[] = ['在用', '停用']

export function createEmptyLedger(): Omit<Ledger, 'id' | 'resolutions'> {
  return {
    code: '',
    sceneIds: [],
    category: '服装',
    name: '',
    baselineState: '',
    owner: '',
    critical: false,
    status: '在用'
  }
}

/** 差异处置留痕（编号内的已处理痕迹，随共同账一起存活，不随差异重算丢失） */
export interface LedgerResolution {
  /** 被处置的旧差异 id（可能已归档不在当前差异表里） */
  conflictId: string
  note: string
  /** ISO 时间 */
  at: string
  /** 处置时回写的基准状态快照 */
  baselineState: string
}
