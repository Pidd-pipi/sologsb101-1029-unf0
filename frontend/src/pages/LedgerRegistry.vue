<script setup lang="ts">
/** /elements 连戏编号共同账：一个编号一份当前基准、挂多个场次 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { Plus, WarningFilled } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import HistoryTimeline from '@/components/common/HistoryTimeline.vue'
import { db, isSaveConflict, type ConflictRow, type LedgerRow, type RecordRow, type SceneRow, type SaveConflictResult } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useLedgerStore } from '@/stores/ledgerStore'
import { ELEMENT_CATEGORIES } from '@/types/element'
import { LEDGER_STATUSES, createEmptyLedger, type LedgerFields } from '@/types/ledger'
import type { FilterSelectConfig, FilterModel } from '@/types/filter'
import { filtersToQuery } from '@/utils/query'
import { ROUTES } from '@/router'

const route = useRoute()
const router = useRouter()
const store = useLedgerStore()

const { rows: ledgers, ready } = useIdbTable<LedgerRow>(() => db.ledgers, {
  compare: (a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN')
})
const { rows: scenes } = useIdbTable<SceneRow>(() => db.scenes, { compare: (a, b) => a.shootOrder - b.shootOrder })
const { rows: records } = useIdbTable<RecordRow>(() => db.records)
const { rows: conflicts } = useIdbTable<ConflictRow>(() => db.conflicts)

const selects = computed<FilterSelectConfig[]>(() => [
  { key: 'categories', label: '类别', options: ELEMENT_CATEGORIES.map((item: string) => ({ label: item, value: item })) },
  {
    key: 'statuses',
    label: '状态',
    options: LEDGER_STATUSES.map((item) => ({ label: item, value: item }))
  },
  { key: 'sceneIds', label: '关联场次', options: scenes.value.map((item) => ({ label: `第 ${item.sceneNo} 场`, value: item.id })) }
])

function sceneOf(sceneId: string): SceneRow | null {
  return scenes.value.find((item) => item.id === sceneId) ?? null
}

function sceneLabel(sceneId: string): string {
  const scene = sceneOf(sceneId)
  return scene ? `第 ${scene.sceneNo} 场` : '场次已撤'
}

function validRecordCountOf(ledgerId: string): number {
  return records.value.filter((item) => item.ledgerId === ledgerId && !item.voided).length
}

function openConflictsOf(ledgerId: string): ConflictRow[] {
  return conflicts.value.filter((item) => item.ledgerId === ledgerId && item.state === '待确认' && !item.stale)
}

function staleConflictsOf(ledgerId: string): ConflictRow[] {
  return conflicts.value.filter((item) => item.ledgerId === ledgerId && item.stale)
}

const filtered = computed(() => {
  const keyword = String(store.filters.keyword ?? '').trim().toLowerCase()
  const categories = Array.isArray(store.filters.categories) ? store.filters.categories : []
  const sceneIds = Array.isArray(store.filters.sceneIds) ? store.filters.sceneIds : []
  const statuses = Array.isArray(store.filters.statuses) ? store.filters.statuses : []
  return ledgers.value.filter((ledger) => {
    const label = `${ledger.code} ${ledger.name} ${ledger.baselineState} ${ledger.owner}`.toLowerCase()
    if (keyword && !label.includes(keyword)) return false
    if (categories.length > 0 && !categories.includes(ledger.category)) return false
    if (statuses.length > 0 && !statuses.includes(ledger.status)) return false
    if (sceneIds.length > 0 && !sceneIds.some((id) => ledger.sceneIds.includes(id))) return false
    return true
  })
})

const totals = computed(() => ({
  ledgerCount: ledgers.value.length,
  multiSceneCount: ledgers.value.filter((item) => item.sceneIds.length > 1).length,
  criticalCount: ledgers.value.filter((item) => item.critical).length,
  inactiveCount: ledgers.value.filter((item) => item.status === '停用').length,
  openConflictCount: conflicts.value.filter((item) => item.state === '待确认' && !item.stale).length,
  staleCount: conflicts.value.filter((item) => item.stale).length
}))

/* ------------------------------ 新增 / 编辑 ------------------------------ */
const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
/** 打开编辑时读到的存储版本（OCC 基准） */
const editingVersion = ref(1)
const formRef = ref<FormInstance>()
const form = reactive<LedgerFields>(createEmptyLedger())
/** 并发冲突面板数据（弹窗不关、草稿保留） */
const conflictData = ref<SaveConflictResult | null>(null)
const submitting = ref(false)

const rules: FormRules = {
  code: [{ required: true, message: '请填写连戏编号', trigger: 'blur' }],
  name: [{ required: true, message: '请填写名称', trigger: 'blur' }],
  baselineState: [{ required: true, message: '请填写当前基准', trigger: 'blur' }]
}

function openCreate(presetSceneId?: string): void {
  editingId.value = null
  conflictData.value = null
  store.clearConflict()
  Object.assign(form, createEmptyLedger())
  const preset = presetSceneId ?? (typeof route.query.sceneIds === 'string' ? route.query.sceneIds.split(',')[0] : '')
  if (preset) form.sceneIds = [preset]
  dialogVisible.value = true
}

function openEdit(ledger: LedgerRow): void {
  editingId.value = ledger.id
  editingVersion.value = ledger.version
  conflictData.value = null
  store.clearConflict()
  Object.assign(form, {
    code: ledger.code,
    sceneIds: [...ledger.sceneIds],
    category: ledger.category,
    name: ledger.name,
    baselineState: ledger.baselineState,
    owner: ledger.owner,
    critical: ledger.critical,
    status: ledger.status
  })
  dialogVisible.value = true
}

async function submit(force = false): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  submitting.value = true
  try {
    const payload = {
      id: editingId.value ?? undefined,
      fields: { ...form, sceneIds: [...form.sceneIds] },
      expectedVersion: editingId.value ? editingVersion.value : undefined,
      force
    }
    const outcome = await store.save(payload)
    if (isSaveConflict(outcome)) {
      // 落后方：弹窗保持打开、表格草稿不动，列出双方不同字段
      conflictData.value = outcome
      ElMessage.warning(`编号 ${outcome.code} 已被另一标签页更新（存储版本 v${outcome.storedVersion}），草稿已保留`)
      return
    }
    ElMessage.success(editingId.value ? `共同账已更新（版本 v${outcome.version}）` : '连戏编号已建档')
    dialogVisible.value = false
    conflictData.value = null
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  } finally {
    submitting.value = false
  }
}

/** 冲突面板中「重新读取对方版本」 */
function adoptStored(): void {
  const current = ledgers.value.find((item) => item.id === conflictData.value?.id || item.code === conflictData.value?.code)
  if (!current) {
    ElMessage.warning('该编号当前不在列表中')
    return
  }
  editingId.value = current.id
  editingVersion.value = current.version
  Object.assign(form, {
    code: current.code,
    sceneIds: [...current.sceneIds],
    category: current.category,
    name: current.name,
    baselineState: current.baselineState,
    owner: current.owner,
    critical: current.critical,
    status: current.status
  })
  conflictData.value = null
  ElMessage.success('已载入最新账面版本，可在其基础上继续修改')
}

async function toggleStatus(ledger: LedgerRow): Promise<void> {
  const nextStatus = ledger.status === '在用' ? '停用' : '在用'
  try {
    await store.save({
      id: ledger.id,
      fields: {
        code: ledger.code,
        sceneIds: [...ledger.sceneIds],
        category: ledger.category,
        name: ledger.name,
        baselineState: ledger.baselineState,
        owner: ledger.owner,
        critical: ledger.critical,
        status: nextStatus
      },
      expectedVersion: ledger.version
    })
    ElMessage.success(nextStatus === '停用' ? '已停用，相关差异转待重算' : '已重新启用')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '操作失败')
  }
}

function gotoLog(ledger: LedgerRow): void {
  void router.push({ path: ROUTES.shootdays, query: { ledgerId: ledger.id } })
}

/* ------------------------------ 历史抽屉 ------------------------------ */
const historyVisible = ref(false)
const historyLedger = ref<LedgerRow | null>(null)

function openHistory(ledger: LedgerRow): void {
  historyLedger.value = ledger
  historyVisible.value = true
}

function onFilterChange(next: FilterModel): void {
  store.setFilters(next)
}

onMounted(() => {
  store.applyQuery(route.query)
})

watch(
  () => store.filters,
  (value) => {
    void router.replace({ path: route.path, query: filtersToQuery(value) })
  },
  { deep: true }
)

function renderValue(value: unknown): string {
  if (Array.isArray(value)) return (value as string[]).map(sceneLabel).join('、') || '空'
  if (value === '' || value === null || value === undefined) return '空'
  return String(value)
}
</script>

<template>
  <div class="page">
    <div class="page__head">
      <div>
        <h2 class="page__title">连戏编号共同账</h2>
        <p class="page__subtitle">同一编号跨场共用一份档案、只认一份当前基准；现场改动与差异处置都在编号账上留痕。</p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openCreate()">登记连戏编号</el-button>
    </div>

    <div class="badge-row">
      <StatBadge label="编号总数" :value="totals.ledgerCount" suffix="个" icon="Files" tone="primary" />
      <StatBadge label="跨场编号" :value="totals.multiSceneCount" suffix="个" icon="Grid" tone="success" />
      <StatBadge label="关键编号" :value="totals.criticalCount" suffix="个" icon="WarningFilled" tone="danger" />
      <StatBadge label="现行未解决" :value="totals.openConflictCount" suffix="条" icon="WarningFilled" tone="warning" />
      <StatBadge label="待重算" :value="totals.staleCount" suffix="条" icon="RefreshRight" tone="info" />
      <StatBadge label="已停用" :value="totals.inactiveCount" suffix="个" icon="CircleClose" tone="info" />
    </div>

    <FilterBar
      :model-value="store.filters"
      :selects="selects"
      keyword-placeholder="搜索编号 / 名称 / 基准 / 责任人…"
      @update:model-value="onFilterChange"
      @reset="store.resetFilters()"
    />

    <EmptyPanel
      v-if="ready && filtered.length === 0"
      title="还没有连戏编号"
      description="按编号建立共同账并勾选关联场次，后续现场记录与差异都挂到编号上。"
      create-text="登记连戏编号"
      @create="openCreate()"
    />

    <el-table v-else :data="filtered" stripe border size="small" row-key="id">
      <el-table-column prop="code" label="连戏编号" width="110">
        <template #default="{ row }">
          <strong>{{ row.code }}</strong>
          <el-tag v-if="row.sceneIds.length > 1" size="small" type="success" effect="plain" class="multi-tag">
            跨 {{ row.sceneIds.length }} 场
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column min-width="150" label="名称 / 类别">
        <template #default="{ row }">
          <div>{{ row.name }}</div>
          <div class="muted">{{ row.category }} · {{ row.owner || '—' }}</div>
        </template>
      </el-table-column>
      <el-table-column label="关联场次" min-width="150">
        <template #default="{ row }">
          <el-tag v-for="sceneId in row.sceneIds" :key="sceneId" size="small" effect="plain" class="scene-tag">
            {{ sceneLabel(sceneId) }}
          </el-tag>
          <span v-if="row.sceneIds.length === 0" class="warn-text">已无关联场次</span>
        </template>
      </el-table-column>
      <el-table-column prop="baselineState" label="当前基准（唯一一份）" min-width="210" />
      <el-table-column label="关键 / 状态" width="120">
        <template #default="{ row }">
          <el-tag :type="row.critical ? 'danger' : 'info'" size="small" effect="plain" class="block-tag">
            {{ row.critical ? '关键' : '一般' }}
          </el-tag>
          <el-tag :type="row.status === '停用' ? 'info' : 'success'" size="small" effect="plain" class="block-tag">
            {{ row.status }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="记录 / 差异" width="150">
        <template #default="{ row }">
          <div class="muted">有效记录 {{ validRecordCountOf(row.id) }} 次 · 处置 {{ row.resolutions.length }} 次</div>
          <div class="diff-line">
            <el-tag v-if="openConflictsOf(row.id).length > 0" type="danger" size="small" effect="plain">
              现行 {{ openConflictsOf(row.id).length }}
            </el-tag>
            <el-tag v-if="staleConflictsOf(row.id).length > 0" type="warning" size="small" effect="plain">
              待重算 {{ staleConflictsOf(row.id).length }}
            </el-tag>
            <span v-if="openConflictsOf(row.id).length === 0 && staleConflictsOf(row.id).length === 0" class="muted">—</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="250" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="gotoLog(row)">去记录</el-button>
          <el-button link size="small" @click="openHistory(row)">痕迹</el-button>
          <el-button link size="small" @click="toggleStatus(row)">{{ row.status === '在用' ? '停用' : '启用' }}</el-button>
          <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? `编辑连戏编号 ${form.code || ''}` : '登记连戏编号'"
      width="600px"
      :close-on-click-modal="false"
    >
      <el-alert
        v-if="conflictData"
        type="warning"
        :closable="false"
        show-icon
        :icon="WarningFilled"
        class="conflict-alert"
        title="另一标签页已先提交了同一编号（乐观锁冲突）"
      >
        <template #default>
          <div class="conflict-body">
            <p>
              本页基于存储版本 v{{ conflictData.expectedVersion }} 编辑，对方已落地到
              v{{ conflictData.storedVersion }}。你的表格草稿已保留，双方不同字段如下：
            </p>
            <el-table :data="conflictData.fields" size="small" border>
              <el-table-column prop="label" label="字段" width="110" />
              <el-table-column label="本页草稿（落后方）" width="150">
                <template #default="{ row }">
                  <span class="draft-val">{{ renderValue(row.theirs) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="对方已落地" width="150">
                <template #default="{ row }">
                  <span class="stored-val">{{ renderValue(row.current) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="我读到的旧值">
                <template #default="{ row }">
                  <span class="muted">{{ renderValue(row.base) }}</span>
                </template>
              </el-table-column>
            </el-table>
            <div class="conflict-actions">
              <el-button size="small" @click="adoptStored">读取对方版本后再改</el-button>
              <el-button size="small" type="warning" :loading="submitting" @click="submit(true)">
                仍以本页草稿强制覆盖
              </el-button>
            </div>
          </div>
        </template>
      </el-alert>

      <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
        <el-form-item label="连戏编号" prop="code">
          <el-input v-model="form.code" placeholder="如：LX-017" />
        </el-form-item>
        <el-form-item label="关联场次" required>
          <el-select v-model="form.sceneIds" class="full" multiple placeholder="一个编号可挂多个场次">
            <el-option v-for="item in scenes" :key="item.id" :label="`第 ${item.sceneNo} 场 · ${item.location}`" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="类别">
          <el-radio-group v-model="form.category">
            <el-radio-button v-for="item in ELEMENT_CATEGORIES" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="名称" prop="name">
          <el-input v-model="form.name" placeholder="如：女主蓝色风衣" />
        </el-form-item>
        <el-form-item label="当前基准" prop="baselineState">
          <el-input v-model="form.baselineState" type="textarea" :rows="2" placeholder="全编号唯一一份连戏基准" />
        </el-form-item>
        <el-form-item label="责任人">
          <el-input v-model="form.owner" placeholder="如：服化组-林岚" />
        </el-form-item>
        <el-form-item label="关键要素">
          <el-switch v-model="form.critical" active-text="关键（差异按阻断处理）" />
        </el-form-item>
        <el-form-item label="使用状态">
          <el-radio-group v-model="form.status">
            <el-radio-button v-for="item in LEDGER_STATUSES" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit(false)">保存</el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="historyVisible" size="46%" :title="historyLedger ? `${historyLedger.code} · 编号台账痕迹` : '台账痕迹'" destroy-on-close>
      <HistoryTimeline v-if="historyLedger" :ledger-id="historyLedger.id" />
    </el-drawer>
  </div>
</template>

<style scoped>
.full {
  width: 100%;
}

.multi-tag,
.scene-tag,
.block-tag {
  margin: 2px 4px 2px 0;
}

.diff-line {
  margin-top: 2px;
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.warn-text {
  color: #c0392b;
  font-size: 12px;
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
