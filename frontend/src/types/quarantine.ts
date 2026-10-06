/**
 * 隔离区：旧数据里无法识别连戏编号的档案先隔离待确认，
 * 不直接进入共同账，确认编号后再建档归并（原档案内容完整保留）。
 */
import type { ElementCategory } from './element'

export type QuarantineStatus = '待确认' | '已归并' | '已丢弃'

export interface QuarantineItem {
  id: string
  /** 原要素档案 id（历史可溯） */
  sourceElementId: string
  category: ElementCategory
  name: string
  initialState: string
  owner: string
  critical: boolean
  /** 旧档案所属场次（可能已随场次删除，保留 id 与解析出的场号文案） */
  sceneId: string
  sceneHint: string
  /** 现场识别出的疑似编号（没有则为空串） */
  suspectedCode: string
  /** 随旧档案带过来的现场记录（按 elementId 挂的），确认归并时一并转挂 */
  recordSnapshot: Array<{
    id: string
    shootDayId: string
    sceneId: string
    takeNo: string
    currentState: string
    photoNote: string
    recordedBy: string
  }>
  status: QuarantineStatus
  /** 处理留痕 */
  resolvedNote: string
  resolvedAt: string
  /** 归并后落到的共同账条目 id */
  resolvedLedgerId: string
  /** 进入隔离区的 ISO 时间 */
  quarantinedAt: string
}

export function createEmptyQuarantineResolution(): { code: string; sceneIds: string[] } {
  return { code: '', sceneIds: [] }
}
