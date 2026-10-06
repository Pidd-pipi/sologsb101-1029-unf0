<script setup lang="ts">
/**
 * /ledger 连戏共同账本：
 * - 一个连戏编号挂多场，只认一份当前基准（乐观版本号）
 * - 两个标签页并发提交：落后一方保留表格草稿并列出双方不同字段，可合并覆盖 / 放弃
 * - 撤下场次、停用道具、现场记录更新后涉及差异立即待重算，可一键重算
 * - 缺编号旧档案隔离待确认；全部变更留痕，历史不丢
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Plus, RefreshRight } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { db, type LedgerRow, type SceneRow, type ConflictRow, type LedgerHistoryRow } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useLedgerStore } from '@/stores/ledgerStore'
import { LEDGER_STATUSES, createEmptyLedger, type ContinuityLedger } from '@/types/ledger'
import { ELEMENT_CATEGORIES } from '@/types/element'
import { formatFieldValue } from '@/utils/ledgerMerge'

const store = useLedgerStore()

const { rows: scenes } = useIdbTable<SceneRow>(() => db.scenes, { compare: (a, b) => a.shootOrder - b.shootOrder })
const { rows: conflicts } = useIdbTable<ConflictRow>(() => db.conflicts)

const keyword = ref('')
const historyDialogVisible = ref(false)
const historyLedgerId = ref<string | null>(null)

const activeScenes = computed(() => scenes.value.filter((scene) => !scene.withdrawn))

function sceneLabels(ids: string[]): string {
  return ids
    .map((id) => scenes.value.find((scene) => scene.id === id))
    .filter((scene): scene is SceneRow => Boolean(scene))
    .map((scene) => `第 ${scene.sceneNo} 场`)
    .join('、')
}

function staleCountOf(ledgerId: string): number {
  return conflicts.value.filter((item) => item.ledgerId === ledgerId && item.stale === '待重算').length
}

function openRiskCountOf(ledgerId: string): number {
  return conflicts.value.filter(
    (item) => item.ledgerId === ledgerId && item.stale === '现行' && item.state === '待确认'
  ).length
}

const filteredLedgers = computed(() =>
  store.ledgers.filter((ledger) => {
    const key = keyword.value.trim().toLowerCase()
    if (!key) return true
    return `${ledger.code} ${ledger.name} ${ledger.owner} ${ledger.category}`.toLowerCase().includes(key)
  })
)

const pendingQuarantine = computed(() => store.quarantine.filter((item) => item.state === '待确认'))
const historyOfActive = computed<LedgerHistoryRow[]>(() =>
  historyLedgerId.value ? store.historyOf(historyLedgerId.value) : []
)

const totals = computed(() => ({
  ledgerCount: store.ledgers.filter((item) => item.status === '在用').length,
  disabledCount: store.ledgers.filter((item) => item.status === '停用').length,
  multiSceneCount: store.ledgers.filter((item) => item.sceneIds.length > 1).length,
  draftCount: store.drafts.length,
  staleCount: conflicts.value.filter((item) => item.stale === '待重算').length,
  quarantineCount: pendingQuarantine.value.length
}))

/* ------------------------------ 基准编辑（带版本） ------------------------------ */
const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
/** 打开编辑时读到的存储版本：并发提交时的比对依据 */
const expectedVersion = ref(0)
const formRef = ref<FormInstance>()
const form = reactive<Omit<ContinuityLedger, 'id' | 'version'>>(createEmptyLedger())

const rules: FormRules = {
  code: [{ required: true, message: '请填写连戏编号', trigger: 'blur' }],
  name: [{ required: true, message: '请填写名称', trigger: 'blur' }],
  'baseline.state': [{ required: true, message: '请填写基准状态', trigger: 'blur' }]
}

function resetForm(): void {
  Object.assign(form, createEmptyLedger())
  form.baseline = { state: '', photoNote: '' }
}

function openCreate(): void {
  editingId.value = null
  expectedVersion.value = 0
  resetForm()
  dialogVisible.value = true
}

function openEdit(ledger: LedgerRow): void {
  editingId.value = ledger.id
  expectedVersion.value = ledger.version
  Object.assign(form, {
    code: ledger.code,
    category: ledger.category,
    name: ledger.name,
    sceneIds: [...ledger.sceneIds],
    baseline: { ...ledger.baseline },
    owner: ledger.owner,
    critical: ledger.critical,
    status: ledger.status
  })
  dialogVisible.value = true
}

async function submit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  try {
    const result = await store.submit({
      id: editingId.value ?? undefined,
      data: JSON.parse(JSON.stringify(form)) as Omit<ContinuityLedger, 'id' | 'version'>,
      expectedVersion: expectedVersion.value
    })
    if (result.outcome === 'conflict') {
      const lines = (result.differingFields ?? [])
        .map((item) => `- ${item.label}：当前账面「${formatFieldValue(item.current)}」 vs 本页草稿「${formatFieldValue(item.draft)}」`)
        .join('\n')
      await ElMessageBox.alert(
        `编号 ${result.ledger.code} 已被另一标签页先提交到 v${result.draft?.currentVersion}，本页基于 v${result.draft?.baseVersion} 的修改未覆盖主账，表格草稿已保留。\n\n双方不同的字段：\n${lines || '（无字段级差异）'}\n\n请到下方「并发草稿」选择合并覆盖或放弃。`,
        '并发提交：草稿已保留',
        { type: 'warning', confirmButtonText: '我知道了' }
      )
    } else {
      ElMessage.success(result.outcome === 'created' ? '共同账已建立' : '共同账已更新，相关差异已按情况转待重算')
    }
    dialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? `写入失败，已恢复到提交前账面：${error.message}` : '写入失败，已恢复到提交前账面')
  }
}

/* ------------------------------ 并发草稿 ------------------------------ */
async function mergeDraft(draftId: string): Promise<void> {
  try {
    await ElMessageBox.confirm('将以本页草稿强制覆盖当前账面（版本顺延），是否继续？', '合并草稿', {
      type: 'warning',
      confirmButtonText: '合并覆盖'
    })
  } catch {
    return
  }
  await store.mergeDraft(draftId)
  ElMessage.success('草稿已合并覆盖，可到差异页重新比对')
}

async function dropDraft(draftId: string): Promise<void> {
  await store.dropDraft(draftId)
  ElMessage.success('草稿已放弃，主账未改动（已留痕）')
}

function draftRows(draftId: string) {
  const draft = store.drafts.find((item) => item.id === draftId)
  if (!draft) return []
  return draft.differingFields.map((field) => {
    const findValue = (source: Record<string, unknown> | null): unknown =>
      source ? field.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), source) : undefined
    return {
      field,
      label: draft.currentSnapshot ? labelOf(field) : field,
      current: findValue((draft.currentSnapshot ?? null) as Record<string, unknown>),
      mine: findValue((draft.payload ?? null) as Record<string, unknown>)
    }
  })
}

function labelOf(field: string): string {
  const labels: Record<string, string> = {
    code: '连戏编号',
    category: '类别',
    name: '名称',
    sceneIds: '关联场次',
    owner: '责任人',
    critical: '关键标记',
    status: '状态',
    'baseline.state': '基准状态',
    'baseline.photoNote': '基准照片说明'
  }
  return labels[field] ?? field
}

/* ------------------------------ 隔离确认 ------------------------------ */
const quarantineDialog = ref(false)
const quarantineTargetId = ref<string | null>(null)
const quarantineForm = reactive({ code: '', name: '' })

function openQuarantine(id: string): void {
  const item = store.quarantine.find((row) => row.id === id)
  quarantineTargetId.value = id
  quarantineForm.code = ''
  quarantineForm.name = String(item?.snapshot?.name ?? '')
  quarantineDialog.value = true
}

async function confirmQuarantineSubmit(): Promise<void> {
  if (!quarantineTargetId.value) return
  if (!quarantineForm.code.trim()) {
    ElMessage.warning('请填写连戏编号')
    return
  }
  try {
    await store.resolveQuarantine(quarantineTargetId.value, { code: quarantineForm.code, name: quarantineForm.name })
    ElMessage.success('已按指定编号归账，相关差异转为待重算')
    quarantineDialog.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '确认失败')
  }
}

/* ------------------------------ 重算 / 历史 ------------------------------ */
async function reconcile(): Promise<void> {
  const stats = await store.reconcile()
  ElMessage.success(`重算完成：新增 ${stats.created}、刷新 ${stats.updated}、自动关闭 ${stats.closed}（已处理痕迹保留）`)
}

function openHistory(ledgerId: string): void {
  historyLedgerId.value = ledgerId
  historyDialogVisible.value = true
}

onMounted(() => {
  void store.refresh()
})
</script>

<template>
  <div class="page">
    <div class="page__head">
      <div>
        <h2 class="page__title">连戏共同账本</h2>
        <p class="page__subtitle">一个连戏编号可挂多个场次，全场只认一份当前基准；编号、现场记录与差异处置都在这本账上。</p>
      </div>
      <div>
        <el-button :icon="RefreshRight" @click="reconcile">一键重算待处理差异</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新建共同账</el-button>
      </div>
    </div>

    <div class="badge-row">
      <StatBadge label="在用编号" :value="totals.ledgerCount" suffix="个" icon="CollectionTag" tone="primary" />
      <StatBadge label="跨场编号" :value="totals.multiSceneCount" suffix="个" icon="Connection" tone="primary" />
      <StatBadge label="停用道具" :value="totals.disabledCount" suffix="个" icon="Remove" tone="info" />
      <StatBadge label="并发草稿" :value="totals.draftCount" suffix="份" icon="EditPen" tone="warning" />
      <StatBadge label="待重算差异" :value="totals.staleCount" suffix="条" icon="RefreshRight" tone="danger" />
      <StatBadge label="隔离待确认" :value="totals.quarantineCount" suffix="份" icon="Lock" tone="warning" />
    </div>

    <el-card shadow="never" class="block">
      <template #header>
        <div class="card-title">
          <span>共同账（{{ filteredLedgers.length }}）</span>
          <el-input v-model="keyword" placeholder="搜索编号 / 名称 / 责任人" clearable class="search" />
        </div>
      </template>
      <EmptyPanel
        v-if="store.ready && filteredLedgers.length === 0"
        title="还没有共同账"
        description="新建一个连戏编号并勾选它沿用的场次；旧数据里的重复档案会在升级时自动按编号归并。"
        create-text="新建共同账"
        @create="openCreate"
      />
      <el-table v-else :data="filteredLedgers" border stripe row-key="id">
        <el-table-column prop="code" label="连戏编号" width="110">
          <template #default="{ row }"><strong>{{ row.code }}</strong></template>
        </el-table-column>
        <el-table-column prop="name" label="名称" min-width="150" />
        <el-table-column prop="category" label="类别" width="80" />
        <el-table-column label="关联场次（一个编号挂多场）" min-width="200">
          <template #default="{ row }">
            <el-tag v-for="sceneId in row.sceneIds" :key="sceneId" size="small" effect="plain" class="scene-tag">
              {{ sceneLabels([sceneId]) || '场次已删除' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="当前基准（唯一）" min-width="220">
          <template #default="{ row }">
            <div>{{ row.baseline.state }}</div>
            <div class="muted">照片：{{ row.baseline.photoNote || '—' }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="owner" label="责任人" width="120" />
        <el-table-column label="版本 / 状态" width="120">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">v{{ row.version }}</el-tag>
            <el-tag :type="row.status === '停用' ? 'info' : 'success'" size="small" effect="plain">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="风险 / 待重算" width="130">
          <template #default="{ row }">
            <el-tag :type="openRiskCountOf(row.id) > 0 ? 'danger' : 'success'" size="small" effect="plain">
              现行 {{ openRiskCountOf(row.id) }}
            </el-tag>
            <el-tag v-if="staleCountOf(row.id) > 0" type="warning" size="small" effect="dark">
              待重算 {{ staleCountOf(row.id) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openEdit(row)">改基准/场次</el-button>
            <el-button link size="small" @click="openHistory(row.id)">历史</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 并发草稿：落后一方的表格草稿 -->
    <el-card v-if="store.drafts.length > 0" shadow="never" class="block">
      <template #header>
        <div class="card-title">
          <span>并发提交草稿（{{ store.drafts.length }}）</span>
          <span class="muted">两个标签页同时改了同一编号，落后方的表格修改保留在此，主账未被覆盖</span>
        </div>
      </template>
      <el-collapse>
        <el-collapse-item v-for="draft in store.drafts" :key="draft.id" :name="draft.id">
          <template #title>
            <el-tag type="warning" size="small" effect="dark">{{ draft.code }}</el-tag>
            <span class="draft-title">
              {{ draft.actor }} 基于 v{{ draft.baseVersion }} 的提交落后于已落地 v{{ draft.currentVersion }}，差异字段 {{ draft.differingFields.length }} 项
            </span>
          </template>
          <el-table :data="draftRows(draft.id)" border size="small">
            <el-table-column prop="label" label="不同字段" width="150" />
            <el-table-column label="已落地（先提交方）" min-width="180">
              <template #default="{ row }">{{ formatFieldValue(row.current) }}</template>
            </el-table-column>
            <el-table-column label="本草稿（落后方）" min-width="180">
              <template #default="{ row }">{{ formatFieldValue(row.mine) }}</template>
            </el-table-column>
          </el-table>
          <div class="btn-row">
            <el-button type="primary" size="small" @click="mergeDraft(draft.id)">用草稿合并覆盖</el-button>
            <el-button size="small" @click="dropDraft(draft.id)">放弃草稿</el-button>
          </div>
        </el-collapse-item>
      </el-collapse>
    </el-card>

    <!-- 隔离区：缺编号旧档案 -->
    <el-card v-if="pendingQuarantine.length > 0" shadow="never" class="block">
      <template #header>
        <div class="card-title">
          <span>隔离区 · 缺编号待确认（{{ pendingQuarantine.length }}）</span>
          <span class="muted">旧数据里没有编号的档案先隔离，不自动并账也不删除</span>
        </div>
      </template>
      <el-table :data="pendingQuarantine" border size="small">
        <el-table-column prop="sourceElementId" label="原档案 ID" width="160" />
        <el-table-column label="快照内容" min-width="260">
          <template #default="{ row }">
            <div>{{ row.snapshot.category }} · 责任人 {{ row.snapshot.owner || '—' }}</div>
            <div class="muted">{{ row.snapshot.initialState }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="reason" label="隔离原因" min-width="200" />
        <el-table-column label="操作" width="140">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openQuarantine(row.id)">指定编号并归账</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 基准编辑对话框 -->
    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑共同账基准' : '新建共同账'" width="620px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="120px">
        <el-form-item label="连戏编号" prop="code">
          <el-input v-model="form.code" placeholder="如：LX-001" />
        </el-form-item>
        <el-form-item label="名称" prop="name">
          <el-input v-model="form.name" placeholder="如：女主蓝色风衣" />
        </el-form-item>
        <el-form-item label="类别">
          <el-radio-group v-model="form.category">
            <el-radio-button v-for="item in ELEMENT_CATEGORIES" :key="item" :value="item">{{ item }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="关联场次">
          <el-select v-model="form.sceneIds" class="full" multiple placeholder="同一编号沿用的场次全部勾选">
            <el-option
              v-for="item in activeScenes"
              :key="item.id"
              :label="`第 ${item.sceneNo} 场 · ${item.location}`"
              :value="item.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="基准状态" prop="baseline.state">
          <el-input v-model="form.baseline.state" type="textarea" :rows="2" placeholder="全场次只认这一份基准状态" />
        </el-form-item>
        <el-form-item label="基准照片说明">
          <el-input v-model="form.baseline.photoNote" placeholder="如：正面全身" />
        </el-form-item>
        <el-form-item label="责任人">
          <el-input v-model="form.owner" />
        </el-form-item>
        <el-form-item label="关键 / 状态">
          <el-switch v-model="form.critical" active-text="关键" />
          <el-select v-model="form.status" style="margin-left: 16px; width: 110px">
            <el-option v-for="item in LEDGER_STATUSES" :key="item" :label="item" :value="item" />
          </el-select>
        </el-form-item>
        <el-alert
          v-if="editingId"
          type="info"
          :closable="false"
          show-icon
          :title="`提交基于本页打开时读到的 v${expectedVersion}；若另一标签页已先行提交，本页会保留为草稿而不是覆盖。`"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <!-- 隔离确认对话框 -->
    <el-dialog v-model="quarantineDialog" title="隔离档案指定编号" width="480px">
      <el-form label-width="90px">
        <el-form-item label="连戏编号" required>
          <el-input v-model="quarantineForm.code" placeholder="已有编号则并入，新编号则建账" />
        </el-form-item>
        <el-form-item label="名称（可选）">
          <el-input v-model="quarantineForm.name" placeholder="新编号时建议填写" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="quarantineDialog = false">取消</el-button>
        <el-button type="primary" @click="confirmQuarantineSubmit">确认归账</el-button>
      </template>
    </el-dialog>

    <!-- 历史留痕对话框 -->
    <el-dialog v-model="historyDialogVisible" title="共同账变更历史（不可删除）" width="680px">
      <el-empty v-if="historyOfActive.length === 0" description="暂无历史" />
      <el-timeline v-else>
        <el-timeline-item v-for="entry in historyOfActive" :key="entry.id" :timestamp="`${entry.at.slice(0, 19).replace('T', ' ')} · ${entry.actor}`" placement="top">
          <el-tag size="small" effect="plain">{{ entry.action }}</el-tag>
          <div class="history-detail">{{ entry.detail }}</div>
        </el-timeline-item>
      </el-timeline>
    </el-dialog>
  </div>
</template>

<style scoped>
.block {
  margin-bottom: 16px;
}

.card-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.search {
  width: 260px;
}

.scene-tag {
  margin: 2px 4px 2px 0;
}

.draft-title {
  margin-left: 8px;
  font-size: 13px;
}

.btn-row {
  margin-top: 10px;
  display: flex;
  gap: 8px;
}

.history-detail {
  margin-top: 4px;
  font-size: 13px;
  color: #5f6b76;
}
</style>
