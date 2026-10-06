/**
 * 提交前账面快照（checkpoint）：
 * 每次写事务提交前，把涉及行的「提交前原样」与「事务内新增行 id」记下来。
 * - 提交前已存在的行：恢复时按原样写回（覆盖编辑、复活删除）；
 * - 事务内才新建的行：恢复时删除。
 * 这样无论写入中途失败、还是用户事后反悔，都能把账面恢复到提交前状态。
 * 恢复成功的 checkpoint 不删除，标记为「已恢复」留痕。
 */

export interface CheckpointTableSnapshot {
  /** 提交前已存在的行（恢复时原样写回） */
  put: Array<Record<string, unknown>>
  /** 事务内新建的行 id（恢复时删除） */
  delete: string[]
}

/** 快照覆盖的表 */
export interface CheckpointSnapshot {
  scenes: CheckpointTableSnapshot
  ledgers: CheckpointTableSnapshot
  records: CheckpointTableSnapshot
  conflicts: CheckpointTableSnapshot
  shootDays: CheckpointTableSnapshot
  quarantine: CheckpointTableSnapshot
}

export type CheckpointStatus = '可恢复' | '已恢复' | '已失效'

export interface Checkpoint {
  id: string
  createdAt: number
  /** 触发提交的动作说明，如「更新共同账 LX-012」 */
  label: string
  status: CheckpointStatus
  snapshot: CheckpointSnapshot
  /** 恢复留痕 */
  restoredAt: string
  restoreNote: string
}

export function emptyTableSnapshot(): CheckpointTableSnapshot {
  return { put: [], delete: [] }
}

export function emptyCheckpointSnapshot(): CheckpointSnapshot {
  return {
    scenes: emptyTableSnapshot(),
    ledgers: emptyTableSnapshot(),
    records: emptyTableSnapshot(),
    conflicts: emptyTableSnapshot(),
    shootDays: emptyTableSnapshot(),
    quarantine: emptyTableSnapshot()
  }
}
