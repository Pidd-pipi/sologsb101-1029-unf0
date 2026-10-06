/**
 * 现场记录：某拍摄日某镜次下，一个连戏要素的实际状态。
 * 按连戏编号（ledgerId / continuityNo）归到共同账，跨场次的同编号记录进同一条时间轴。
 */
export interface Record {
  id: string
  /** 拍摄日 */
  shootDayId: string
  /** 连戏要素（场次侧落点） */
  elementId: string
  /** 所属场次（冗余存储，便于按场次统计） */
  sceneId: string
  /** 所属连戏共同账 */
  ledgerId: string
  /** 连戏编号冗余 */
  continuityNo: string
  /** 镜次 */
  takeNo: string
  /** 当前状态描述 */
  currentState: string
  /** 照片说明 */
  photoNote: string
  /** 记录人 */
  recordedBy: string
}

export function createEmptyRecord(): Omit<Record, 'id'> {
  return {
    shootDayId: '',
    elementId: '',
    sceneId: '',
    ledgerId: '',
    continuityNo: '',
    takeNo: '',
    currentState: '',
    photoNote: '',
    recordedBy: ''
  }
}
