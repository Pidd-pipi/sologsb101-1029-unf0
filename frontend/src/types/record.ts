/** 现场记录：某拍摄日某镜次下，一个连戏编号的实际状态 */
export interface Record {
  id: string
  /** 拍摄日 */
  shootDayId: string
  /** 连戏编号共同账条目（旧字段 elementId 已迁移为 ledgerId） */
  ledgerId: string
  /** 记录时所属场次（冗余存储；撤场后保留为历史上下文） */
  sceneId: string
  /** 镜次 */
  takeNo: string
  /** 当前状态描述 */
  currentState: string
  /** 照片说明 */
  photoNote: string
  /** 记录人 */
  recordedBy: string
  /**
   * 软作废标记：撤场/停用等处置不再物理删除记录，历史快照保留，
   * 差异比对与报告统计会忽略 voided 记录。默认 false。
   */
  voided: boolean
}

export function createEmptyRecord(): Omit<Record, 'id'> {
  return {
    shootDayId: '',
    ledgerId: '',
    sceneId: '',
    takeNo: '',
    currentState: '',
    photoNote: '',
    recordedBy: '',
    voided: false
  }
}
