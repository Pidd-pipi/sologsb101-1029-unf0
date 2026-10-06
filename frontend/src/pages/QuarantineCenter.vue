<script setup lang="ts">
/** /quarantine 隔离区：旧数据里缺连戏编号的档案先隔离待确认，确认编号后归并进共同账 */
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import HistoryTimeline from '@/components/common/HistoryTimeline.vue'
import { db, resolveQuarantine, discardQuarantine, type QuarantineRow, type SceneRow } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'

const router = useRouter()

const { rows: quarantine, ready } = useIdbTable<QuarantineRow>(() => db.quarantine)
const { rows: scenes } = useIdbTable<SceneRow>(() => db.scenes, { compare: (a, b) => a.shootOrder - b.shootOrder })

const pending = computed(() => quarantine.value.filter((item) => item.status === '待确认'))
const handled = computed(() => quarantine.value.filter((item) => item.status !== '待确认'))

const totals = computed(() => ({
  pending: pending.value.length,
  merged: quarantine.value.filter((item) => item.status === '已归并').length,
  discarded: quarantine.value.filter((item) => item.status === '已丢弃').length
}))

/* ------------------------------ 确认归并 ------------------------------ */
const dialogVisible = ref(false)
const editing = ref<QuarantineRow | null>(null)
const form = reactive<{ code: string; sceneIds: string[]; note: string }>({ code: '', sceneIds: [], note: '' })

function openResolve(item: QuarantineRow): void {
  editing.value = item
  form.code = item.suspectedCode
  form.sceneIds = item.sceneId ? [item.sceneId] : []
  form.note = ''
  dialogVisible.value = true
}

async function submitResolve(): Promise<void> {
  if (!editing.value) return
  if (!form.code.trim()) {
    ElMessage.warning('请确认连戏编号')
    return
  }
  if (form.sceneIds.length === 0) {
    ElMessage.warning('请至少选择一个关联场次')
    return
  }
  try {
    await resolveQuarantine(editing.value.id, {
      code: form.code.trim(),
      sceneIds: [...form.sceneIds],
      note: form.note || undefined
    })
    ElMessage.success(`已归并进共同账，编号 ${form.code.trim()}`)
    dialogVisible.value = false
    void router.push({ path: '/elements', query: { keyword: form.code.trim() } })
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '归并失败')
  }
}

async function discard(item: QuarantineRow): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt(
      `确认「${item.name}」不需要建立连戏编号？原档案仍保留在隔离区并标记为已丢弃。`,
      '丢弃确认',
      { inputValue: '确认无编号、无需追踪', confirmButtonText: '确认丢弃', cancelButtonText: '取消' }
    )
    await discardQuarantine(item.id, value || '确认无编号')
    ElMessage.success('已标记为已丢弃（原档保留可查）')
  } catch (error) {
    if (error instanceof Error && error.message) ElMessage.error(error.message)
  }
}
</script>

<template>
  <div class="page">
    <div class="page__head">
      <div>
        <h2 class="page__title">缺编号隔离区</h2>
        <p class="page__subtitle">旧数据里识别不出连戏编号的档案先隔离待确认，不直接进共同账；原档与随附现场记录完整保留。</p>
      </div>
    </div>

    <div class="badge-row">
      <StatBadge label="待确认" :value="totals.pending" suffix="份" icon="WarningFilled" tone="danger" />
      <StatBadge label="已归并" :value="totals.merged" suffix="份" icon="CircleCheck" tone="success" />
      <StatBadge label="已丢弃" :value="totals.discarded" suffix="份" icon="CircleClose" tone="info" />
    </div>

    <EmptyPanel
      v-if="ready && pending.length === 0"
      title="没有待确认的隔离档案"
      description="旧数据里缺编号的档案会出现在这里，确认编号后即可归并进共同账。"
      :show-create="false"
    />

    <template v-else>
      <h3 class="section-title">待确认（{{ pending.length }}）</h3>
      <el-table :data="pending" border stripe size="small">
        <el-table-column prop="category" label="类别" width="80" />
        <el-table-column min-width="150" label="名称 / 原档">
          <template #default="{ row }">
            <div>{{ row.name }}</div>
            <div class="muted">原要素 id：{{ row.sourceElementId }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="initialState" label="旧基准描述" min-width="180" />
        <el-table-column label="原所属场次" min-width="140">
          <template #default="{ row }">{{ row.sceneHint }}</template>
        </el-table-column>
        <el-table-column label="随附记录" width="170">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.recordSnapshot.length }} 条历史记录</el-tag>
            <div v-for="snap in row.recordSnapshot.slice(0, 2)" :key="snap.id" class="muted snap-line">
              {{ snap.takeNo }}：{{ snap.currentState }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="疑似编号" width="110">
          <template #default="{ row }">
            <el-tag v-if="row.suspectedCode" size="small" type="warning">{{ row.suspectedCode }}</el-tag>
            <span v-else class="muted">未能识别</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="170" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="openResolve(row)">确认编号</el-button>
            <el-button link type="danger" size="small" @click="discard(row)">丢弃</el-button>
          </template>
        </el-table-column>
      </el-table>
    </template>

    <template v-if="handled.length > 0">
      <h3 class="section-title">已处理（{{ handled.length }}，痕迹保留）</h3>
      <el-table :data="handled" border size="small">
        <el-table-column prop="category" label="类别" width="80" />
        <el-table-column prop="name" label="名称" min-width="140" />
        <el-table-column label="处理结果" width="110">
          <template #default="{ row }">
            <el-tag :type="row.status === '已归并' ? 'success' : 'info'" size="small">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="resolvedNote" label="处理说明" min-width="180" />
        <el-table-column label="处理时间" width="170">
          <template #default="{ row }">{{ row.resolvedAt ? row.resolvedAt.slice(0, 19).replace('T', ' ') : '—' }}</template>
        </el-table-column>
      </el-table>
    </template>

    <el-row :gutter="16" class="history-row">
      <el-col :span="24">
        <el-card shadow="never">
          <template #header>
            <div class="card-title"><span>隔离与归并痕迹（只追加，不删除）</span></div>
          </template>
          <HistoryTimeline />
        </el-card>
      </el-col>
    </el-row>

    <el-dialog v-model="dialogVisible" :title="`确认隔离档案编号${editing ? `：${editing.name}` : ''}`" width="520px">
      <el-form label-width="100px">
        <el-form-item label="连戏编号" required>
          <el-input v-model="form.code" placeholder="如：LX-204（同编号已存在则归并）" />
        </el-form-item>
        <el-form-item label="关联场次" required>
          <el-select v-model="form.sceneIds" multiple class="full" placeholder="归并后挂到哪些场次">
            <el-option v-for="item in scenes" :key="item.id" :label="`第 ${item.sceneNo} 场 · ${item.location}`" :value="item.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="处理说明">
          <el-input v-model="form.note" type="textarea" :rows="2" placeholder="可选" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitResolve">确认归并</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.full {
  width: 100%;
}

.section-title {
  margin: 18px 0 10px;
  font-size: 14px;
}

.snap-line {
  font-size: 11px;
  line-height: 1.5;
}

.history-row {
  margin-top: 18px;
}
</style>
