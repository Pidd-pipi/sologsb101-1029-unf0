/** 连戏要素类别（沿用，供共同账类别字段与旧档案使用） */
export type ElementCategory = '服装' | '道具' | '妆发' | '陈设'

export const ELEMENT_CATEGORIES: ElementCategory[] = ['服装', '道具', '妆发', '陈设']

/**
 * 旧版（数据结构 v1）连戏要素档案。
 * v2 已升级为「连戏编号共同账」（见 types/ledger.ts），此类型仅在
 * 旧库升级与 v1 备份导入时使用（utils/migration.ts）。
 */
export interface LegacyElement {
  id: string
  /** 所属场次 */
  sceneId: string
  /** 类别 */
  category: ElementCategory
  /** 名称 */
  name: string
  /** 初始状态（旧基准） */
  initialState: string
  /** 责任人 */
  owner: string
  /** 是否关键要素 */
  critical: boolean
  /**
   * 连戏编号：v1 正式结构里没有该字段，但现场可能以未建模方式（手工填进
   * 名称/备注）留下编号；迁移时若能识别则按编号归并，识别不到则进隔离区。
   */
  code?: string
}
