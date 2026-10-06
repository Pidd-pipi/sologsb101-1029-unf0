/**
 * 首次打开应用时灌入的演示数据（共同账结构 v2）
 * 只在 scenes 表为空时执行。
 * 场次 → 连戏编号共同账（一个编号可挂多场）→ 拍摄日 → 现场记录 → 差异/历史，
 * 预置：跨场共用编号、阻断待确认差异、已解决差异（含已处理痕迹）、
 * 待重算差异、隔离区缺编号档案，保证每个页面打开都有内容。
 */
import type { SceneRow, LedgerRow, ShootDayRow, RecordRow, ConflictRow, HistoryRow, QuarantineRow } from './db'
import { db, ROW_REVISION } from './db'

const NOW = Date.now()
const ISO = '2024-05-09T12:00:00.000Z'

function scene(row: Omit<SceneRow, 'revision' | 'createdAt' | 'updatedAt'>, offset: number): SceneRow {
  return { ...row, revision: ROW_REVISION, createdAt: NOW + offset, updatedAt: NOW + offset }
}
function ledger(row: Omit<LedgerRow, 'revision' | 'createdAt' | 'updatedAt' | 'version'>, offset: number): LedgerRow {
  return { ...row, version: 1, revision: ROW_REVISION, createdAt: NOW + offset, updatedAt: NOW + offset }
}
function shootDay(row: Omit<ShootDayRow, 'revision' | 'createdAt' | 'updatedAt'>, offset: number): ShootDayRow {
  return { ...row, revision: ROW_REVISION, createdAt: NOW + offset, updatedAt: NOW + offset }
}
function record(row: Omit<RecordRow, 'revision' | 'createdAt' | 'updatedAt' | 'version'>, offset: number): RecordRow {
  return { ...row, version: 1, revision: ROW_REVISION, createdAt: NOW + offset, updatedAt: NOW + offset }
}
function conflict(row: Omit<ConflictRow, 'revision' | 'createdAt' | 'updatedAt'>, offset: number): ConflictRow {
  return { ...row, revision: ROW_REVISION, createdAt: NOW + offset, updatedAt: NOW + offset }
}

const SCENES: SceneRow[] = [
  scene(
    {
      id: 'sc-001',
      sceneNo: '12A',
      place: '内景',
      timeOfDay: '夜',
      location: '老宅客厅',
      excerpt: '女主在台灯下翻找旧信，听到门外脚步后把信塞回抽屉。',
      shootOrder: 1,
      state: '拍摄中'
    },
    1
  ),
  scene(
    {
      id: 'sc-002',
      sceneNo: '12B',
      place: '内景',
      timeOfDay: '夜',
      location: '老宅阁楼',
      excerpt: '女主披同一件风衣登阁楼取箱，镜位只拍背影。',
      shootOrder: 2,
      state: '未拍'
    },
    2
  ),
  scene(
    {
      id: 'sc-003',
      sceneNo: '15',
      place: '外景',
      timeOfDay: '日',
      location: '江边码头',
      excerpt: '男主拖着木箱走下码头栈桥，与船老大交接货物。',
      shootOrder: 3,
      state: '未拍'
    },
    3
  ),
  scene(
    {
      id: 'sc-004',
      sceneNo: '3',
      place: '内景',
      timeOfDay: '晨',
      location: '女主卧室',
      excerpt: '晨光里女主对镜盘发，墙上全家福入画。',
      shootOrder: 4,
      state: '已过'
    },
    4
  )
]

const LEDGERS: LedgerRow[] = [
  ledger(
    {
      id: 'lg-001',
      code: 'LX-001',
      sceneIds: ['sc-001', 'sc-002'],
      category: '服装',
      name: '女主蓝色风衣',
      baselineState: '深蓝风衣，第二颗扣子缺失',
      owner: '服化组-林岚',
      critical: true,
      status: '在用',
      resolutions: []
    },
    10
  ),
  ledger(
    {
      id: 'lg-002',
      code: 'LX-012',
      sceneIds: ['sc-001'],
      category: '道具',
      name: '铜制台灯',
      baselineState: '铜制台灯，灯罩左下有裂纹',
      owner: '道具组-周迟',
      critical: false,
      status: '在用',
      resolutions: []
    },
    11
  ),
  ledger(
    {
      id: 'lg-003',
      code: 'LX-021',
      sceneIds: ['sc-001'],
      category: '妆发',
      name: '女主发型',
      // 处置差异后基准已回写为最新现场状态（只认这一份当前基准）
      baselineState: '高马尾，无碎发',
      owner: '妆发组-许静',
      critical: true,
      status: '在用',
      resolutions: [
        {
          conflictId: 'cf-002',
          note: '已按第 7 场重新盘发并补拍侧脸特写',
          at: '2024-05-08T02:10:00.000Z',
          baselineState: '高马尾，无碎发'
        }
      ]
    },
    12
  ),
  ledger(
    {
      id: 'lg-004',
      code: 'LX-107',
      sceneIds: ['sc-003'],
      category: '道具',
      name: '编号木箱',
      baselineState: '编号 A-17 木箱，右上角有破损',
      owner: '道具组-周迟',
      critical: true,
      status: '在用',
      resolutions: []
    },
    13
  ),
  ledger(
    {
      id: 'lg-005',
      code: 'LX-108',
      sceneIds: ['sc-003'],
      category: '服装',
      name: '男主夹克',
      baselineState: '深灰夹克，左袖有油污',
      owner: '服化组-林岚',
      critical: false,
      status: '在用',
      resolutions: []
    },
    14
  )
]

const SHOOT_DAYS: ShootDayRow[] = [
  shootDay(
    {
      id: 'sd-001',
      date: '2024-05-06',
      sceneIds: ['sc-001'],
      director: '郑一鸣',
      scripty: '苏晚',
      weatherNote: '棚内夜戏，空调稳定，无异常。'
    },
    20
  ),
  shootDay(
    {
      id: 'sd-002',
      date: '2024-05-07',
      sceneIds: ['sc-001', 'sc-004'],
      director: '郑一鸣',
      scripty: '苏晚',
      weatherNote: '补拍 12A 特写；妆发临时调整，需复核。'
    },
    21
  ),
  shootDay(
    {
      id: 'sd-003',
      date: '2024-05-09',
      sceneIds: ['sc-003'],
      director: '郑一鸣',
      scripty: '苏晚',
      weatherNote: '江边风大，木箱贴纸被吹起一角。'
    },
    22
  )
]

const RECORDS: RecordRow[] = [
  record(
    { id: 'rec-001', shootDayId: 'sd-001', ledgerId: 'lg-001', sceneId: 'sc-001', takeNo: '3/1', currentState: '深蓝风衣，第二颗扣子缺失', photoNote: '正面全身', recordedBy: '苏晚', voided: false },
    30
  ),
  record(
    { id: 'rec-002', shootDayId: 'sd-001', ledgerId: 'lg-002', sceneId: 'sc-001', takeNo: '3/1', currentState: '铜制台灯，灯罩左下有裂纹', photoNote: '台灯特写', recordedBy: '苏晚', voided: false },
    31
  ),
  record(
    { id: 'rec-003', shootDayId: 'sd-001', ledgerId: 'lg-003', sceneId: 'sc-001', takeNo: '3/1', currentState: '低盘发，右侧留碎发', photoNote: '侧脸发际', recordedBy: '苏晚', voided: false },
    32
  ),
  record(
    { id: 'rec-004', shootDayId: 'sd-002', ledgerId: 'lg-001', sceneId: 'sc-001', takeNo: '7/2', currentState: '深蓝风衣，第三颗扣子缺失', photoNote: '正面全身（补）', recordedBy: '苏晚', voided: false },
    33
  ),
  record(
    { id: 'rec-005', shootDayId: 'sd-002', ledgerId: 'lg-002', sceneId: 'sc-001', takeNo: '7/2', currentState: '铜制台灯，灯罩左下有裂纹', photoNote: '台灯特写（第二次）', recordedBy: '苏晚', voided: false },
    34
  ),
  record(
    { id: 'rec-006', shootDayId: 'sd-002', ledgerId: 'lg-003', sceneId: 'sc-001', takeNo: '7/2', currentState: '高马尾，无碎发', photoNote: '侧脸发际', recordedBy: '苏晚', voided: false },
    35
  ),
  record(
    { id: 'rec-008', shootDayId: 'sd-003', ledgerId: 'lg-004', sceneId: 'sc-003', takeNo: '9/1', currentState: '编号 A-17 木箱，右上角有破损', photoNote: '木箱标识', recordedBy: '苏晚', voided: false },
    36
  ),
  record(
    { id: 'rec-009', shootDayId: 'sd-003', ledgerId: 'lg-005', sceneId: 'sc-003', takeNo: '9/1', currentState: '深灰夹克，左袖有油污', photoNote: '男主半身', recordedBy: '苏晚', voided: false },
    37
  )
]

const CONFLICTS: ConflictRow[] = [
  conflict(
    {
      id: 'cf-001',
      ledgerId: 'lg-001',
      recordIdA: 'rec-001',
      recordIdB: 'rec-004',
      diffDesc: '当前状态：「深蓝风衣，第二颗扣子缺失」→「深蓝风衣，第三颗扣子缺失」',
      severity: '阻断',
      state: '待确认',
      resolvedNote: '',
      resolvedAt: '',
      stale: false,
      staleReason: '',
      staleAt: ''
    },
    40
  ),
  conflict(
    {
      id: 'cf-002',
      ledgerId: 'lg-003',
      recordIdA: 'rec-003',
      recordIdB: 'rec-006',
      diffDesc: '当前状态：「低盘发，右侧留碎发」→「高马尾，无碎发」',
      severity: '需处理',
      state: '已解决',
      resolvedNote: '已按第 7 场重新盘发并补拍侧脸特写',
      resolvedAt: '2024-05-08T02:10:00.000Z',
      stale: false,
      staleReason: '',
      staleAt: ''
    },
    41
  ),
  conflict(
    {
      id: 'cf-003',
      ledgerId: 'lg-002',
      recordIdA: 'rec-002',
      recordIdB: 'rec-005',
      diffDesc: '照片说明：「台灯特写」→「台灯特写（第二次）」',
      severity: '轻微',
      state: '待确认',
      resolvedNote: '',
      resolvedAt: '',
      stale: false,
      staleReason: '',
      staleAt: ''
    },
    42
  )
]

/** 缺编号的旧陈设档案：进隔离区待确认（原档与随附记录完整保留） */
const QUARANTINE: QuarantineRow[] = [
  {
    id: 'qu-001',
    sourceElementId: 'el-006',
    category: '陈设',
    name: '墙上全家福',
    initialState: '全家福相框右下角卷边',
    owner: '陈设组-孟舟',
    critical: false,
    sceneId: 'sc-004',
    sceneHint: '第 3 场 · 女主卧室',
    suspectedCode: '',
    recordSnapshot: [
      {
        id: 'rec-007',
        shootDayId: 'sd-002',
        sceneId: 'sc-004',
        takeNo: '7/5',
        currentState: '全家福相框右下角卷边',
        photoNote: '墙面全景',
        recordedBy: '苏晚'
      }
    ],
    status: '待确认',
    resolvedNote: '',
    resolvedAt: '',
    resolvedLedgerId: '',
    quarantinedAt: ISO
  }
]

const HISTORY: HistoryRow[] = [
  { id: 'h-001', at: '2024-05-05T08:00:00.000Z', ledgerId: 'lg-001', code: 'LX-001', action: '归并', detail: '12A、12B 两场各自登记的「女主蓝色风衣」按编号 LX-001 归并为一份共同账，基准只认 12A 首拍记录' },
  { id: 'h-002', at: '2024-05-05T08:05:00.000Z', ledgerId: 'lg-002', code: 'LX-012', action: '建档', detail: '建立连戏编号 LX-012，关联 1 个场次' },
  { id: 'h-003', at: '2024-05-05T08:06:00.000Z', ledgerId: 'lg-003', code: 'LX-021', action: '建档', detail: '建立连戏编号 LX-021，关联 1 个场次' },
  { id: 'h-004', at: '2024-05-05T08:07:00.000Z', ledgerId: 'lg-004', code: 'LX-107', action: '建档', detail: '建立连戏编号 LX-107，关联 1 个场次' },
  { id: 'h-005', at: '2024-05-05T08:08:00.000Z', ledgerId: 'lg-005', code: 'LX-108', action: '建档', detail: '建立连戏编号 LX-108，关联 1 个场次' },
  { id: 'h-006', at: ISO, ledgerId: '', code: '（缺编号）', action: '隔离', detail: '旧档案「墙上全家福」缺少连戏编号，连同 1 条现场记录隔离待确认' },
  { id: 'h-007', at: '2024-05-08T02:10:00.000Z', ledgerId: 'lg-003', code: 'LX-021', action: '冲突处置', detail: '差异已解决：已按第 7 场重新盘发并补拍侧脸特写；当前基准回写为「高马尾，无碎发」' }
]

/** 灌入演示数据（共同账 v2） */
export async function seedDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.scenes, db.ledgers, db.shootDays, db.records, db.conflicts, db.history, db.quarantine],
    async () => {
      await db.scenes.bulkPut(SCENES)
      await db.ledgers.bulkPut(LEDGERS)
      await db.shootDays.bulkPut(SHOOT_DAYS)
      await db.records.bulkPut(RECORDS)
      await db.conflicts.bulkPut(CONFLICTS)
      await db.quarantine.bulkPut(QUARANTINE)
      await db.history.bulkPut(HISTORY)
    }
  )
}
