/**
 * 共同账核心链路烟雾测试（Node + fake-indexeddb，不进浏览器）
 * 覆盖：v1→v2 迁移归并/隔离、OCC 双提交、撤场/停用/记录更新→待重算、
 * 重算恢复/归档、checkpoint 恢复、历史不丢。
 */
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import {
  db,
  saveLedger,
  saveRecord,
  isSaveConflict,
  saveShootDay,
  removeScene,
  removeShootDay,
  voidRecord,
  recomputeConflicts,
  resolveConflict,
  reopenConflict,
  restoreCheckpoint,
  listConflicts,
  listLedgers,
  listRecords,
  listHistory,
  listQuarantine,
  listCheckpoints,
  initDatabase
} from '../src/utils/db'
import { migrateV1ToV2, recognizeCode } from '../src/utils/migration'
import type { LegacyConflict, LegacyElement, LegacyRecord } from '../src/utils/migration'
import type { Scene } from '../src/types/scene'
import type { ShootDay } from '../src/types/shootDay'

let passed = 0
function check(name: string, cond: boolean): void {
  assert.ok(cond, name)
  passed += 1
  console.log(`  ✓ ${name}`)
}

async function freshDb(): Promise<void> {
  await db.open()
  await db.delete()
  await db.open()
}

/* ---------- 1. 纯迁移：重复档案按编号归并，缺编号隔离 ---------- */
function migrationSpec(): {
  scenes: Scene[]
  shootDays: ShootDay[]
  elements: LegacyElement[]
  records: LegacyRecord[]
  conflicts: LegacyConflict[]
} {
  const scenes: Scene[] = [
    { id: 's1', sceneNo: '1', place: '内景', timeOfDay: '日', location: '客厅', excerpt: '', shootOrder: 1, state: '未拍' },
    { id: 's2', sceneNo: '2', place: '内景', timeOfDay: '夜', location: '阁楼', excerpt: '', shootOrder: 2, state: '未拍' }
  ]
  const shootDays: ShootDay[] = [{ id: 'd1', date: '2024-01-01', sceneIds: ['s1', 's2'], director: '', scripty: '', weatherNote: '' }]
  const elements: LegacyElement[] = [
    { id: 'e1', sceneId: 's1', category: '服装', name: 'LX-001 风衣', initialState: '扣子缺失', owner: '甲', critical: true },
    { id: 'e2', sceneId: 's2', category: '服装', name: '风衣 LX-001', initialState: '扣子缺失（现场修订）', owner: '甲', critical: false },
    { id: 'e3', sceneId: 's1', category: '陈设', name: '墙上挂画', initialState: '卷边', owner: '乙', critical: false }
  ]
  const records: LegacyRecord[] = [
    { id: 'r1', shootDayId: 'd1', elementId: 'e1', sceneId: 's1', takeNo: '1/1', currentState: '扣子缺失', photoNote: '', recordedBy: '甲' },
    { id: 'r2', shootDayId: 'd1', elementId: 'e2', sceneId: 's2', takeNo: '1/2', currentState: '扣子缺失（现场修订）', photoNote: '', recordedBy: '甲' },
    { id: 'r3', shootDayId: 'd1', elementId: 'e3', sceneId: 's1', takeNo: '1/3', currentState: '卷边', photoNote: '', recordedBy: '乙' }
  ]
  const conflicts: LegacyConflict[] = [
    { id: 'c1', elementId: 'e1', recordIdA: 'r1', recordIdB: 'r2', diffDesc: '状态不同', severity: '阻断', state: '待确认', resolvedNote: '', resolvedAt: '' }
  ]
  return { scenes, shootDays, elements, records, conflicts }
}

console.log('1) 迁移归并 / 隔离')
{
  const result = migrateV1ToV2(migrationSpec())
  check('两份同编号档案归并为一条共同账', result.ledgers.length === 1)
  const ledger = result.ledgers[0]
  check('归并后挂两个场次', ledger.sceneIds.length === 2)
  check('基准取最新非空值', ledger.baselineState === '扣子缺失（现场修订）')
  check('critical 归并取或', ledger.critical === true)
  check('编号归一为大写', ledger.code === 'LX-001')
  check('两条记录都转挂到同一 ledgerId', result.records.length === 2 && result.records.every((r) => r.ledgerId === ledger.id))
  check('差异转挂 ledgerId', result.conflicts.length === 1 && result.conflicts[0].ledgerId === ledger.id)
  check('缺编号档案进隔离区', result.quarantine.length === 1)
  check('隔离档案带随附记录', result.quarantine[0].recordSnapshot.length === 1)
  check('归并+隔离都有历史痕迹', result.history.filter((h) => h.action === '归并').length === 1 && result.history.some((h) => h.action === '隔离'))
  check('编号识别：名称前缀', recognizeCode('LX-017 风衣') === 'LX-017')
  check('编号识别：无编号返回空', recognizeCode('墙上挂画') === '')
}

/* ---------- 2. 实际 IndexedDB：播种 + OCC ---------- */
console.log('2) OCC 双标签页同编号提交')
await freshDb()
await initDatabase()
{
  const ledgers = await listLedgers()
  check('播种出共同账', ledgers.length >= 5)
  const target = ledgers.find((l) => l.code === 'LX-001')!
  const baseVersion = target.version

  // 标签页 A 先改
  const a = await saveLedger({ id: target.id, fields: { ...target, baselineState: 'A 改的基准' }, expectedVersion: baseVersion })
  assert.ok(a.kind === 'success'); passed++
  console.log('  ✓ A 提交成功，版本 +1')

  // 标签页 B 仍拿旧版本提交
  const b = await saveLedger({
    id: target.id,
    fields: { ...target, baselineState: 'B 改的基准' },
    expectedVersion: baseVersion,
    baseFields: target
  })
  check('B 拿到 conflict 而非覆盖', b.kind === 'conflict')
  if (b.kind === 'conflict') {
    check('冲突列出双方不同字段', b.fields.some((f) => f.field === 'baselineState'))
    check('冲突字段含 B 草稿与 A 现值', (b.fields[0].theirs as string).includes('B') && (b.fields[0].current as string).includes('A'))
    check('存储版本提示为新版本', b.storedVersion === baseVersion + 1)
  }
  const stored = await listLedgers()
  check('落后方未覆盖先落地方', stored.find((l) => l.id === target.id)!.baselineState === 'A 改的基准')

  // B 强制覆盖
  const bForce = await saveLedger({ id: target.id, fields: { ...target, baselineState: 'B 改的基准' }, force: true })
  check('强制覆盖成功且版本继续 +1', bForce.kind === 'success' && bForce.kind === 'success' && bForce.value.version === baseVersion + 2)
  void isSaveConflict
}

/* ---------- 3. 撤场：摘挂+作废记录+差异待重算 ---------- */
console.log('3) 撤场 → 差异待重算、记录作废留档')
{
  const ledgers = await listLedgers()
  const target = ledgers.find((l) => l.code === 'LX-001')!
  const beforeScenes = [...target.sceneIds]
  const recordsBefore = (await listRecords()).filter((r) => r.ledgerId === target.id)
  check('LX-001 挂多场', beforeScenes.length === 2)

  // sc-002 尚未开拍，先补一条该场记录，验证撤场时它会被作废留档
  const day = (await db.shootDays.toArray())[0]
  const added = await saveRecord({
    fields: { shootDayId: day.id, ledgerId: target.id, sceneId: 'sc-002', takeNo: '8/9', currentState: '风衣背影', photoNote: '', recordedBy: '测试' }
  })
  assert.ok(added.kind === 'success')

  // 先撤 s? 播种用 sc-001/sc-002
  await removeScene('sc-002')
  const after = (await listLedgers()).find((l) => l.id === target.id)!
  check('撤场后编号仍存在（基准保留）', !!after)
  check('撤场后摘挂', !after.sceneIds.includes('sc-002') && after.sceneIds.includes('sc-001'))
  const recs = (await listRecords()).filter((r) => r.ledgerId === target.id)
  check('撤场场次的记录软作废而非删除', recs.length === recordsBefore.length + 1 && recs.some((r) => r.voided && r.id === added.value!.id))
  const conflicts = await listConflicts()
  const related = conflicts.filter((c) => c.ledgerId === target.id)
  check('相关待确认差异转待重算', related.every((c) => c.state === '已解决' || c.stale))
  check('历史留下撤场痕迹', (await listHistory()).some((h) => h.action === '撤场'))
}

/* ---------- 4. 停用 → 差异待重算 ---------- */
console.log('4) 停用编号')
{
  const target = (await listLedgers()).find((l) => l.code === 'LX-012')!
  const fields = { ...target, sceneIds: [...target.sceneIds] }
  fields.status = '停用'
  const r = await saveLedger({ id: target.id, fields, expectedVersion: target.version })
  check('停用成功', r.kind === 'success')
  const conflicts = (await listConflicts()).filter((c) => c.ledgerId === target.id)
  check('停用编号下待确认差异全部待重算', conflicts.filter((c) => c.state === '待确认').every((c) => c.stale))

  // 停用编号拒绝新记录
  const day = (await db.shootDays.toArray())[0]
  const err = await saveRecord({ fields: { shootDayId: day.id, ledgerId: target.id, sceneId: target.sceneIds[0], takeNo: 'x/1', currentState: 'x', photoNote: '', recordedBy: '' } }).catch((e: Error) => e)
  check('停用编号拒绝录入记录', err instanceof Error && err.message.includes('停用'))
}

/* ---------- 5. 记录更新 → 差异待重算 ---------- */
console.log('5) 记录更新 → 差异待重算')
{
  // 给只有一条记录的 LX-108 补一条新记录形成差异，再更新它验证待重算
  const lg = (await listLedgers()).find((l) => l.code === 'LX-108')!
  const day3 = (await db.shootDays.toArray()).find((d) => d.date === '2024-05-09')!
  const first = (await listRecords()).find((r) => r.ledgerId === lg.id)!
  const added = await saveRecord({
    fields: { shootDayId: day3.id, ledgerId: lg.id, sceneId: 'sc-003', takeNo: '9/2', currentState: '深灰夹克，左袖油污已洗净', photoNote: '补拍', recordedBy: '苏晚' }
  })
  assert.ok(added.kind === 'success')
  const candidates = [
    { ledgerId: lg.id, recordIdA: first.id, recordIdB: added.value!.id, diffDesc: '当前状态不同', severity: '轻微' as const }
  ]
  await recomputeConflicts(candidates)
  const created = (await listConflicts()).find((c) => c.ledgerId === lg.id && !c.stale)
  check('补记录重算生成差异', !!created)

  const rec = (await listRecords()).find((r) => r.id === added.value!.id)!
  const r = await saveRecord({
    id: rec.id,
    fields: { shootDayId: rec.shootDayId, ledgerId: rec.ledgerId, sceneId: rec.sceneId, takeNo: rec.takeNo, currentState: '深灰夹克，左袖油污仍在', photoNote: rec.photoNote, recordedBy: rec.recordedBy },
    expectedVersion: rec.version
  })
  check('记录更新成功', r.kind === 'success')
  const conflicts = (await listConflicts()).filter((c) => c.ledgerId === lg.id && c.state === '待确认')
  check('记录更新后相关差异待重算', conflicts.every((c) => c.stale))

  // 作废单条记录
  await voidRecord(rec.id, '测试作废')
  const reloaded = (await listRecords()).find((x) => x.id === rec.id)!
  check('作废不删除记录', !!reloaded && reloaded.voided === true)
}

/* ---------- 6. 重算：恢复/归档/生成 ---------- */
console.log('6) 重新比对')
{
  // 造一个全新编号 + 两条不同记录，然后重算
  const day = (await db.shootDays.toArray())[0]
  const scene = (await db.scenes.toArray())[0]
  const lg = await saveLedger({
    fields: { code: 'LX-TEST', sceneIds: [scene.id], category: '道具', name: '测试道具', baselineState: '红', owner: '', critical: false, status: '在用' }
  })
  assert.ok(lg.kind === 'success')
  const r1 = await saveRecord({ fields: { shootDayId: day.id, ledgerId: lg.value.id, sceneId: scene.id, takeNo: '1/1', currentState: '红色', photoNote: '', recordedBy: '' } })
  const r2 = await saveRecord({ fields: { shootDayId: day.id, ledgerId: lg.value.id, sceneId: scene.id, takeNo: '1/2', currentState: '蓝色', photoNote: '', recordedBy: '' } })
  assert.ok(r1.kind === 'success' && r2.kind === 'success')

  // 用 hook 的算法构造候选（直接复刻：颜色 红≠蓝）
  const candidates = [
    { ledgerId: lg.value.id, recordIdA: r1.value.id, recordIdB: r2.value.id, diffDesc: '当前状态：「红色」→「蓝色」', severity: '需处理' as const }
  ]
  const stats = await recomputeConflicts(candidates)
  check('重算生成新差异', stats.created >= 1)
  const fresh = (await listConflicts()).find((c) => c.ledgerId === lg.value.id && !c.stale)
  check('新差异为现行待确认', !!fresh && fresh.state === '待确认')

  // 再重算相同候选 → 恢复/不重复
  const stats2 = await recomputeConflicts(candidates)
  check('同依据重复重算不重复生成', stats2.created === 0)
  check('现行差异保留', (await listConflicts()).filter((c) => c.ledgerId === lg.value.id).length === 1)

  // 作废最新记录后重算 → 旧差异归档（失去依据）
  await voidRecord(r2.value.id, '重算测试')
  const stats3 = await recomputeConflicts([])
  check('失去依据的差异归档（物理删除但进历史）', stats3.archived >= 1 && !(await listConflicts()).some((c) => c.ledgerId === lg.value.id))
  check('归档动作写历史', (await listHistory()).some((h) => h.action === '差异归档'))
}

/* ---------- 7. 解决留痕 + 基准回写；重开不丢痕迹 ---------- */
console.log('7) 冲突处置留痕')
{
  // 用活跃编号 LX-107（关键道具）造两条差异记录
  const lg = (await listLedgers()).find((l) => l.code === 'LX-107')!
  const day3 = (await db.shootDays.toArray()).find((d) => d.date === '2024-05-09')!
  const first = (await listRecords()).find((r) => r.ledgerId === lg.id)!
  const second = await saveRecord({
    fields: { shootDayId: day3.id, ledgerId: lg.id, sceneId: 'sc-003', takeNo: '9/3', currentState: '编号 A-17 木箱，破损已修补', photoNote: '', recordedBy: '苏晚' }
  })
  assert.ok(second.kind === 'success')
  const stats = await recomputeConflicts([
    { ledgerId: lg.id, recordIdA: first.id, recordIdB: second.value!.id, diffDesc: '木箱破损状态变化', severity: '阻断' }
  ])
  check('关键编号差异重算生成', stats.created >= 1)
  const cf = (await listConflicts()).find((c) => c.ledgerId === lg.id && !c.stale && c.state === '待确认')!
  check('待处置差异存在', !!cf)
  await resolveConflict(cf.id, '测试处置')
  const after = (await listLedgers()).find((l) => l.id === lg.id)!
  check('处置痕迹进共同账 resolutions', after.resolutions.some((x) => x.conflictId === cf.id && x.note === '测试处置'))
  check('处置后基准回写为最新记录', after.baselineState.includes('破损已修补'))
  const resolved = (await listConflicts()).find((c) => c.id === cf.id)!
  check('差异状态为已解决', resolved.state === '已解决')
  await reopenConflict(cf.id)
  const after2 = (await listLedgers()).find((l) => l.id === lg.id)!
  check('重开后已处理痕迹仍保留', after2.resolutions.some((x) => x.conflictId === cf.id))
  check('重开后差异回到待确认', (await listConflicts()).find((c) => c.id === cf.id)!.state === '待确认')
  // 已解决的差异不允许处置 stale：重开后若再作废记录，差异应转待重算且禁止解决
  await voidRecord(second.value!.id, '处置后又改记录')
  const staleCf = (await listConflicts()).find((c) => c.id === cf.id)!
  check('已处置后再动记录 → 待重算', staleCf.stale === true)
  const resolveErr = await resolveConflict(cf.id, '应被拒绝').catch((e: Error) => e)
  check('待重算差异禁止直接处置', resolveErr instanceof Error && resolveErr.message.includes('待重算'))
}

/* ---------- 8. checkpoint 恢复 ---------- */
console.log('8) 提交前快照恢复')
{
  const target = (await listLedgers()).find((l) => l.code === 'LX-012')!
  const before = target.baselineState
  const cps = await listCheckpoints()
  check('提交都留了快照', cps.length > 0)

  // 改基准，再从该次提交的快照恢复
  const edit = await saveLedger({
    id: target.id,
    fields: { ...target, sceneIds: [...target.sceneIds], baselineState: '被错误改动的基准' },
    expectedVersion: target.version
  })
  assert.ok(edit.kind === 'success')
  check('错误改动已落地', (await listLedgers()).find((l) => l.id === target.id)!.baselineState === '被错误改动的基准')

  const cp = (await listCheckpoints()).find((c) => c.label.includes('LX-012'))!
  await restoreCheckpoint(cp.id, '测试恢复')
  const restored = (await listLedgers()).find((l) => l.id === target.id)!
  check('恢复后基准回到提交前', restored.baselineState === before && restored.version === target.version)
  const cpAfter = (await listCheckpoints()).find((c) => c.id === cp.id)!
  check('用过的快照标记为已恢复（不删除）', cpAfter.status === '已恢复')
  check('恢复动作进历史', (await listHistory()).some((h) => h.action === '回滚恢复'))
}

/* ---------- 9. 删除拍摄日：记录作废、差异待重算、可恢复 ---------- */
console.log('9) 删除拍摄日 + 恢复')
{
  const days = await db.shootDays.toArray()
  const day = days.find((d) => d.date === '2024-05-09')!
  const dayRecsBefore = (await listRecords()).filter((r) => r.shootDayId === day.id).length
  await removeShootDay(day.id)
  check('拍摄日已删除', !(await db.shootDays.get(day.id)))
  const dayRecs = (await listRecords()).filter((r) => r.shootDayId === day.id)
  check('当日记录全部作废保留', dayRecs.length === dayRecsBefore && dayRecs.every((r) => r.voided))

  const cp = (await listCheckpoints()).find((c) => c.label === '删除拍摄日')!
  await restoreCheckpoint(cp.id, '误撤恢复')
  check('恢复后拍摄日回来', !!(await db.shootDays.get(day.id)))
  const dayRecs2 = (await listRecords()).filter((r) => r.shootDayId === day.id)
  check('恢复后记录复活（voided 回退）', dayRecs2.some((r) => !r.voided))
}

/* ---------- 10. 隔离区播种存在 + 历史只增 ---------- */
console.log('10) 隔离区 / 历史')
{
  const quar = await listQuarantine()
  check('播种含隔离待确认', quar.some((q) => q.status === '待确认'))
  const historyCount = (await listHistory()).length
  check('历史条目充足（归并/隔离/处置/恢复）', historyCount >= 8)
}

console.log(`\n全部 ${passed} 项断言通过`)
