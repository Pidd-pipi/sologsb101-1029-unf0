/** 连戏要素类别 */
export type ElementCategory = '服装' | '道具' | '妆发' | '陈设'

/** 要素 / 道具状态：撤下走停用，现场记录与差异历史都保留 */
export type ElementStatus = '在用' | '停用'

export const ELEMENT_STATUSES: ElementStatus[] = ['在用', '停用']

/**
 * 连戏要素：归在某个连戏共同账（ledgerId）下的场次侧落点。
 * 同一连戏编号可在多个场次各有一条要素行，但基准只认 ledger 上的一份。
 */
export interface Element {
  id: string
  /** 所属场次 */
  sceneId: string
  /** 类别 */
  category: ElementCategory
  /** 名称 */
  name: string
  /** 初始状态（场次侧展示基准；共同账启用后以 ledger.baseline 为准） */
  initialState: string
  /** 责任人 */
  owner: string
  /** 是否关键要素（差异需单独高亮） */
  critical: boolean
  /** 所属连戏共同账（旧数据迁移后回填；缺编号的隔离档案为空串） */
  ledgerId: string
  /** 连戏编号冗余（便于列表直接展示与旧档识别） */
  continuityNo: string
  /** 在用 / 停用（停用道具的差异立即转待重算） */
  status: ElementStatus
}

export const ELEMENT_CATEGORIES: ElementCategory[] = ['服装', '道具', '妆发', '陈设']

export function createEmptyElement(): Omit<Element, 'id'> {
  return {
    sceneId: '',
    category: '服装',
    name: '',
    initialState: '',
    owner: '',
    critical: false,
    ledgerId: '',
    continuityNo: '',
    status: '在用'
  }
}
