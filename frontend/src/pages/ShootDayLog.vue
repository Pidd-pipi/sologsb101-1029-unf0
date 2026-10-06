<script setup lang="ts">
/** /shootdays 现场状态记录：按拍摄日与镜次逐条录入编号实际状态；记录更新后差异立即待重算 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Plus, WarningFilled } from '@element-plus/icons-vue'
import ConflictTag from '@/components/common/ConflictTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import {
  db,
  isSaveConflict,
  type ConflictRow,
  type LedgerRow,
  type RecordRow,
  type SceneRow,
  type ShootDayRow,
  type SaveConflictResult
} from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useRecordStore } from '@/stores/recordStore'
import { createEmptyShootDay, type ShootDay } from '@/types/shootDay'
import { createEmptyRecord, type Record as ContinuityRecord } from '@/types/record'
import type { FilterSelectConfig, FilterModel } from '@/types/filter'
import { filtersToQuery } from '@/utils/query'

const route = useRoute()
const router = useRouter()
const store = useRecordStore()

const { rows: shootDays, ready } = useIdbTable<ShootDayRow>(() => db.shootDays, {
  compare: (a, b) => b.date.localeCompare(a.date)
})
const { rows: records } = useIdbTable<RecordRow>(() => db.records)
const { rows: ledgers } = useIdbTable<LedgerRow>(() => db.ledgers, { compare: (a, b) => a.code.localeCompare(b.code) })
const { rows: scenes } = useIdbTable<SceneRow>(() => db.scenes, { compare: (a, b) => a.shootOrder - b.shootOrder })
const { rows: conflicts } = useIdbTable<ConflictRow>(() => db.conflicts)

const selects = computed<FilterSelectConfig[]>(() => [
  { key: 'sceneIds', label: '场次', options: scenes.value.map((item) => ({ label: `第 ${item.sceneNo} 场`, value: item.id })) },
  { key: 'takes', label: '镜次', options: [...new Set(records.value.filter((r) => !r.voided).map((item) => item.takeNo))].map((item) => ({ label: item, value: item })) }
])

function sceneLabel(sceneId: string): string {
  const scene = scenes.value.find((item) => item.id === sceneId)
  return scene ? `第 ${scene.sceneNo} 场 · ${scene.location}` : '场次已撤'
}

function ledgerOf(ledgerId: string): LedgerRow | null {
  return ledgers.value.find((item) => item.id === ledgerId) ?? null
}

const currentDay = computed<ShootDayRow | null>(
  () => shootDays.value.find((day) => day.id === store.currentShootDayId) ?? null
)

/** 当前拍摄日的有效现场记录（作废记录折叠到另一区块） */
const dayRecords = computed(() =>
  records.value
    .filter((record) => record.shootDayId === store.currentShootDayId && !record.voided)
    .filter((record) => {
      const keyword = String(store.filters.keyword ?? '').trim().toLowerCase()
      const sceneIds = Array.isArray(store.filters.sceneIds) ? store.filters.sceneIds : []
      const takes = Array.isArray(store.filters.takes) ? store.filters.takes : []
      const ledger = ledgerOf(record.ledgerId)
      const label = `${ledger ? `${ledger.code} ${ledger.name}` : ''} ${record.currentState} ${record.photoNote} ${record.recordedBy}`.toLowerCase()
      if (keyword && !label.includes(keyword)) return false
      if (sceneIds.length > 0 && !sceneIds.includes(record.sceneId)) return false
      if (takes.length > 0 && !takes.includes(record.takeNo)) return false
      return true
    })
    .sort((a, b) => a.takeNo.localeCompare(b.takeNo, 'zh-Hans-CN'))
)

const dayVoidedRecords = computed(() =>
  records.value.filter((record) => record.shootDayId === store.currentShootDayId && record.voided)
)

/** 该记录关联的现行/待重算差异 */
function conflictOf(recordId: string): ConflictRow | null {
  return conflicts.value.find((item) => (item.recordIdA === recordId || item.recordIdB === recordId) && !item.stale) ?? null
}
function staleConflictOf(recordId: string): ConflictRow | null {
  return conflicts.value.find((item) => (item.recordIdA === recordId || item.recordIdB === recordId) && item.stale) ?? null
}

const totals = computed(() => {
  const open = conflicts.value.filter((item) => item.state === '待确认' && !item.stale)
  return {
    shootDayCount: shootDays.value.length,
    recordCount: records.value.filter((item) => !item.voided).length,
    voidedCount: records.value.filter((item) => item.voided).length,
    dayRecordCount: dayRecords.value.length,
    openConflictCount: open.length,
    staleCount: conflicts.value.filter((item) => item.stale).length,
    blockingCount: open.filter((item) => item.severity === '阻断').length
  }
})

/** 当前拍摄日可录入的编号：当日场次关联且在用的共同账 */
const dayLedgers = computed(() => {
  if (!currentDay.value) return []
  const sceneIds = currentDay.value.sceneIds
  return ledgers.value.filter((item) => item.status === '在用' && item.sceneIds.some((id) => sceneIds.includes(id)))
})

/* ------------------------------ 拍摄日 ------------------------------ */
const dayDialog = ref(false)
const editingDayId = ref<string | null>(null)
const dayFormRef = ref<FormInstance>()
const dayForm = reactive<Omit<ShootDay, 'id'>>(createEmptyShootDay())

const dayRules: FormRules = {
  date: [{ required: true, message: '请选择拍摄日期', trigger: 'change' }]
}

function openCreateDay(): void {
  editingDayId.value = null
  Object.assign(dayForm, createEmptyShootDay())
  dayDialog.value = true
}

function openEditDay(day: ShootDayRow): void {
  editingDayId.value = day.id
  Object.assign(dayForm, {
    date: day.date,
    sceneIds: [...day.sceneIds],
    director: day.director,
    scripty: day.scripty,
    weatherNote: day.weatherNote
  })
  dayDialog.value = true
}

async function submitDay(): Promise<void> {
  const valid = await dayFormRef.value?.validate().catch(() => false)
  if (!valid) return
  try {
    if (editingDayId.value) {
      await store.updateShootDay(editingDayId.value, { ...dayForm })
      ElMessage.success('拍摄日已更新')
    } else {
      await store.createShootDay({ ...dayForm })
      ElMessage.success('拍摄日已建立')
    }
    dayDialog.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  }
}

async function removeDay(day: ShootDayRow): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `撤除拍摄日 ${day.date} 后，当日记录作废保留、相关差异立即转待重算（可在报告页从快照恢复），是否继续？`,
      '撤除确认',
      { type: 'warning', confirmButtonText: '确认撤除' }
    )
  } catch {
    return
  }
  await store.deleteShootDay(day.id)
  ElMessage.success('拍摄日已撤除，记录与痕迹保留')
}

/* ------------------------------ 现场记录 ------------------------------ */
const recordDialog = ref(false)
const editingRecordId = ref<string | null>(null)
const editingVersion = ref(1)
const recordFormRef = ref<FormInstance>()
const recordForm = reactive<Omit<ContinuityRecord, 'id' | 'voided'>>(createEmptyRecord())
const conflictData = ref<SaveConflictResult | null>(null)
const submitting = ref(false)

const recordRules: FormRules = {
  ledgerId: [{ required: true, message: '请选择连戏编号', trigger: 'change' }],
  takeNo: [{ required: true, message: '请填写镜次', trigger: 'blur' }],
  currentState: [{ required: true, message: '请填写当前状态', trigger: 'blur' }]
}

function openCreateRecord(): void {
  if (!currentDay.value) {
    ElMessage.warning('请先选择或新建拍摄日')
    return
  }
  editingRecordId.value = null
  conflictData.value = null
  store.clearConflict()
  Object.assign(recordForm, createEmptyRecord())
  recordForm.shootDayId = currentDay.value.id
  recordForm.recordedBy = currentDay.value.scripty
  const preset = typeof route.query.ledgerId === 'string' ? route.query.ledgerId : ''
  if (preset && dayLedgers.value.some((item) => item.id === preset)) {
    onElementChange(preset)
    recordForm.ledgerId = preset
  } else if (dayLedgers.value.length > 0) {
    onElementChange(dayLedgers.value[0].id)
    recordForm.ledgerId = dayLedgers.value[0].id
  }
  recordDialog.value = true
}

function openEditRecord(record: RecordRow): void {
  editingRecordId.value = record.id
  editingVersion.value = record.version
  conflictData.value = null
  store.clearConflict()
  Object.assign(recordForm, {
    shootDayId: record.shootDayId,
    ledgerId: record.ledgerId,
    sceneId: record.sceneId,
    takeNo: record.takeNo,
    currentState: record.currentState,
    photoNote: record.photoNote,
    recordedBy: record.recordedBy
  })
  recordDialog.value = true
}

/** 选中编号后自动带出所属场次与当前基准 */
function onElementChange(ledgerId: string): void {
  const ledger = ledgerOf(ledgerId)
  if (!ledger) return
  if (!recordForm.sceneId || !ledger.sceneIds.includes(recordForm.sceneId)) {
    recordForm.sceneId = ledger.sceneIds[0] ?? currentDay.value?.sceneIds.find((id) => ledger.sceneIds.includes(id)) ?? ''
  }
  if (!recordForm.currentState) recordForm.currentState = ledger.baselineState
}

async function submitRecord(force = false): Promise<void> {
  const valid = await recordFormRef.value?.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    const outcome = await store.saveEntry({
      id: editingRecordId.value ?? undefined,
      fields: { ...recordForm },
      expectedVersion: editingRecordId.value ? editingVersion.value : undefined,
      force
    })
    if (isSaveConflict(outcome)) {
      conflictData.value = outcome
      ElMessage.warning(`该记录已被另一标签页更新（存储版本 v${outcome.storedVersion}），草稿已保留`)
      return
    }
    ElMessage.success(editingRecordId.value ? '现场记录已更新，相关差异转待重算' : '现场记录已保存，可到差异页重新比对')
    recordDialog.value = false
    conflictData.value = null
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  } finally {
    submitting.value = false
  }
}

function adoptStoredRecord(): void {
  const current = records.value.find((item) => item.id === conflictData.value?.id)
  if (!current) {
    ElMessage.warning('该记录当前不在列表中')
    return
  }
  editingRecordId.value = current.id
  editingVersion.value = current.version
  Object.assign(recordForm, {
    shootDayId: current.shootDayId,
    ledgerId: current.ledgerId,
    sceneId: current.sceneId,
    takeNo: current.takeNo,
    currentState: current.currentState,
    photoNote: current.photoNote,
    recordedBy: current.recordedBy
  })
  conflictData.value = null
  ElMessage.success('已载入最新记录版本，可在其基础上继续修改')
}

async function removeRecord(record: RecordRow): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '作废后该记录保留在案但不再参与比对，相关差异立即转待重算。确认作废？',
      '作废确认',
      { type: 'warning', confirmButtonText: '确认作废' }
    )
  } catch {
    return
  }
  await store.deleteRecord(record.id)
  ElMessage.success('已作废，历史记录保留')
}

function renderValue(value: unknown): string {
  if (value === '' || value === null || value === undefined) return '空'
  return String(value)
}

function onFilterChange(next: FilterModel): void {
  store.setFilters(next)
}

onMounted(() => {
  store.applyQuery(route.query)
  if (!store.currentShootDayId && shootDays.value.length > 0) {
    store.selectShootDay(shootDays.value[0].id)
  }
})

watch(
  () => store.filters,
  (value) => {
    void router.replace({ path: route.path, query: filtersToQuery(value) })
  },
  { deep: true }
)

watch(currentDay, (day) => {
  if (day) {
    void router.replace({ path: route.path, query: { ...filtersToQuery(store.filters), shootDayId: day.id } })
  }
})
</script>

<template>
  <div class="page">
    <div class="page__head">
      <div>
        <h2 class="page__title">现场状态记录</h2>
        <p class="page__subtitle">按拍摄日与镜次录入连戏编号的实际状态；同一编号保留历次快照，记录更新后差异立即转待重算。</p>
      </div>
      <div>
        <el-button type="primary" :icon="Plus" @click="openCreateDay">新建拍摄日</el-button>
        <el-button :icon="Plus" @click="openCreateRecord">录入现场记录</el-button>
      </div>
    </div>

    <div class="badge-row">
      <StatBadge label="拍摄日" :value="totals.shootDayCount" suffix="天" icon="Files" tone="primary" />
      <StatBadge label="有效记录" :value="totals.recordCount" suffix="条" icon="DataLine" tone="info" />
      <StatBadge label="当日记录" :value="totals.dayRecordCount" suffix="条" icon="Grid" tone="success" />
      <StatBadge label="现行未解决" :value="totals.openConflictCount" suffix="条" icon="WarningFilled" tone="danger" />
      <StatBadge label="待重算" :value="totals.staleCount" suffix="条" icon="RefreshRight" tone="warning" />
      <StatBadge label="已作废留档" :value="totals.voidedCount" suffix="条" icon="Files" tone="info" />
    </div>

    <FilterBar
      :model-value="store.filters"
      :selects="selects"
      keyword-placeholder="搜索编号 / 当前状态 / 记录人…"
      @update:model-value="onFilterChange"
      @reset="store.resetFilters()"
    />

    <el-row :gutter="16">
      <el-col :span="9">
        <el-card shadow="never">
          <template #header>
            <div class="card-title"><span>拍摄日（{{ shootDays.length }}）</span><span class="muted">点击选择</span></div>
          </template>
          <EmptyPanel
            v-if="ready && shootDays.length === 0"
            title="暂无拍摄日"
            description="先建立拍摄日并勾选当日要拍的场次。"
            create-text="新建拍摄日"
            @create="openCreateDay"
          />
          <div v-else class="day-list">
            <div
              v-for="day in shootDays"
              :key="day.id"
              class="day-item"
              :class="{ 'is-active': day.id === store.currentShootDayId }"
              @click="store.selectShootDay(day.id)"
            >
              <div class="day-item__head">
                <strong>{{ day.date }}</strong>
                <el-tag size="small" effect="plain">{{ day.sceneIds.length }} 场</el-tag>
              </div>
              <div class="day-item__meta">
                导演 {{ day.director || '—' }} · 场记 {{ day.scripty || '—' }} ·
                {{ records.filter((item) => item.shootDayId === day.id && !item.voided).length }} 条记录
              </div>
              <div class="day-item__scenes">
                <el-tag v-for="sceneId in day.sceneIds" :key="sceneId" size="small" effect="plain">
                  {{ sceneLabel(sceneId) }}
                </el-tag>
              </div>
              <div class="day-item__note">{{ day.weatherNote }}</div>
              <div class="day-item__actions">
                <el-button link type="primary" size="small" @click.stop="openEditDay(day)">编辑</el-button>
                <el-button link type="danger" size="small" @click.stop="removeDay(day)">撤除</el-button>
              </div>
            </div>
          </div>
        </el-card>
      </el-col>

      <el-col :span="15">
        <el-card shadow="never">
          <template #header>
            <div class="card-title">
              <span>现场记录<template v-if="currentDay"> · {{ currentDay.date }}</template></span>
              <el-button type="primary" size="small" :icon="Plus" @click="openCreateRecord">录入记录</el-button>
            </div>
          </template>

          <EmptyPanel v-if="!currentDay" title="未选择拍摄日" description="在左侧选择一个拍摄日后即可录入当日现场记录。" :show-create="false" />
          <EmptyPanel
            v-else-if="dayRecords.length === 0"
            title="当日还没有有效现场记录"
            description="按镜次记录各连戏编号的实际状态，作为跨日比对的依据。"
            create-text="录入记录"
            @create="openCreateRecord"
          />
          <template v-else>
            <el-table :data="dayRecords" stripe border>
              <el-table-column label="连戏编号" min-width="180">
                <template #default="{ row }">
                  <div><strong>{{ ledgerOf(row.ledgerId)?.code ?? '编号已删' }}</strong> · {{ ledgerOf(row.ledgerId)?.name ?? '—' }}</div>
                  <div class="muted">{{ ledgerOf(row.ledgerId)?.category ?? '—' }} · {{ ledgerOf(row.ledgerId)?.owner ?? '—' }}</div>
                </template>
              </el-table-column>
              <el-table-column label="场次" width="150">
                <template #default="{ row }">{{ sceneLabel(row.sceneId) }}</template>
              </el-table-column>
              <el-table-column prop="takeNo" label="镜次" width="80" />
              <el-table-column prop="currentState" label="当前状态" min-width="190" />
              <el-table-column prop="photoNote" label="照片说明" min-width="130" />
              <el-table-column label="差异" width="150">
                <template #default="{ row }">
                  <ConflictTag v-if="conflictOf(row.id)" :severity="conflictOf(row.id)?.severity" :state="conflictOf(row.id)?.state" />
                  <el-tag v-else-if="staleConflictOf(row.id)" size="small" type="warning" effect="plain">待重算</el-tag>
                  <span v-else class="muted">—</span>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="120" fixed="right">
                <template #default="{ row }">
                  <el-button link type="primary" size="small" @click="openEditRecord(row)">编辑</el-button>
                  <el-button link type="danger" size="small" @click="removeRecord(row)">作废</el-button>
                </template>
              </el-table-column>
            </el-table>

            <el-collapse v-if="dayVoidedRecords.length > 0" class="voided-collapse">
              <el-collapse-item :title="`已作废记录（${dayVoidedRecords.length} 条，历史保留不参与比对）`" name="voided">
                <el-table :data="dayVoidedRecords" size="small" border>
                  <el-table-column label="连戏编号" min-width="160">
                    <template #default="{ row }">{{ ledgerOf(row.ledgerId)?.code ?? '编号已删' }} · {{ ledgerOf(row.ledgerId)?.name ?? '—' }}</template>
                  </el-table-column>
                  <el-table-column prop="takeNo" label="镜次" width="80" />
                  <el-table-column prop="currentState" label="作废时状态" min-width="180" />
                  <el-table-column label="版本" width="80">
                    <template #default="{ row }">v{{ row.version }}</template>
                  </el-table-column>
                </el-table>
              </el-collapse-item>
            </el-collapse>
          </template>
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="dayDialog" :title="editingDayId ? '编辑拍摄日' : '新建拍摄日'" width="580px">
      <el-form ref="dayFormRef" :model="dayForm" :rules="dayRules" label-width="100px">
        <el-form-item label="拍摄日期" prop="date">
          <el-date-picker v-model="dayForm.date" type="date" value-format="YYYY-MM-DD" class="full" />
        </el-form-item>
        <el-form-item label="当日场次">
          <el-select v-model="dayForm.sceneIds" class="full" multiple placeholder="勾选当日要拍的场次">
            <el-option v-for="item in scenes" :key="item.id" :label="`第 ${item.sceneNo} 场 · ${item.location}`" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="导演">
          <el-input v-model="dayForm.director" />
        </el-form-item>
        <el-form-item label="场记">
          <el-input v-model="dayForm.scripty" />
        </el-form-item>
        <el-form-item label="现场备注">
          <el-input v-model="dayForm.weatherNote" type="textarea" :rows="2" placeholder="天气、突发情况等" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dayDialog = false">取消</el-button>
        <el-button type="primary" @click="submitDay">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="recordDialog"
      :title="editingRecordId ? `编辑现场记录（当前存储版本 v${editingVersion}）` : '录入现场记录'"
      width="580px"
      :close-on-click-modal="false"
    >
      <el-alert
        v-if="conflictData"
        type="warning"
        :closable="false"
        show-icon
        :icon="WarningFilled"
        class="conflict-alert"
        title="另一标签页已先提交了这条记录（乐观锁冲突）"
      >
        <div class="conflict-body">
          <p>本页基于 v{{ conflictData.expectedVersion }} 编辑，对方已落地 v{{ conflictData.storedVersion }}，草稿已保留：</p>
          <el-table :data="conflictData.fields" size="small" border>
            <el-table-column prop="label" label="字段" width="100" />
            <el-table-column label="本页草稿" min-width="130">
              <template #default="{ row }"><span class="draft-val">{{ renderValue(row.theirs) }}</span></template>
            </el-table-column>
            <el-table-column label="对方已落地" min-width="130">
              <template #default="{ row }"><span class="stored-val">{{ renderValue(row.current) }}</span></template>
            </el-table-column>
          </el-table>
          <div class="conflict-actions">
            <el-button size="small" @click="adoptStoredRecord">读取对方版本后再改</el-button>
            <el-button size="small" type="warning" :loading="submitting" @click="submitRecord(true)">仍以本页强制覆盖</el-button>
          </div>
        </div>
      </el-alert>

      <el-form ref="recordFormRef" :model="recordForm" :rules="recordRules" label-width="100px">
        <el-form-item label="连戏编号" prop="ledgerId">
          <el-select v-model="recordForm.ledgerId" class="full" placeholder="选择当日场次下在用的编号" @change="onElementChange">
            <el-option
              v-for="item in dayLedgers"
              :key="item.id"
              :value="item.id"
              :label="`${item.code} ${item.name}（${item.category} · 挂 ${item.sceneIds.length} 场）`"
            />
          </el-select>
          <div v-if="dayLedgers.length === 0" class="muted">当日场次没有在用的编号，先到共同账登记</div>
        </el-form-item>
        <el-form-item label="场次">
          <el-select v-model="recordForm.sceneId" class="full">
            <el-option
              v-for="sceneId in ledgerOf(recordForm.ledgerId)?.sceneIds ?? []"
              :key="sceneId"
              :label="sceneLabel(sceneId)"
              :value="sceneId"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="镜次" prop="takeNo">
          <el-input v-model="recordForm.takeNo" placeholder="如：3/1" />
        </el-form-item>
        <el-form-item label="当前状态" prop="currentState">
          <el-input v-model="recordForm.currentState" type="textarea" :rows="2" placeholder="现场实际状态，越具体越好" />
        </el-form-item>
        <el-form-item label="照片说明">
          <el-input v-model="recordForm.photoNote" placeholder="如：正面全身 / 木箱标识特写" />
        </el-form-item>
        <el-form-item label="记录人">
          <el-input v-model="recordForm.recordedBy" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="recordDialog = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitRecord(false)">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.full {
  width: 100%;
}

.day-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 620px;
  overflow-y: auto;
}

.day-item {
  padding: 10px 12px;
  border: 1px solid #dde7ef;
  border-radius: 10px;
  background: #fbfcfe;
  cursor: pointer;
}

.day-item.is-active {
  border-color: #5b8bb8;
  background: #f0f5fa;
}

.day-item__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.day-item__meta {
  margin-top: 4px;
  font-size: 12px;
  color: #7d8b98;
}

.day-item__scenes {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.day-item__note {
  margin-top: 6px;
  font-size: 12px;
  color: #9aa5ad;
}

.voided-collapse {
  margin-top: 10px;
}

.conflict-alert {
  margin-bottom: 12px;
}

.conflict-body p {
  margin: 0 0 8px;
}

.conflict-actions {
  margin-top: 10px;
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.draft-val {
  color: #b8860b;
}

.stored-val {
  color: #1e8449;
}
</style>
