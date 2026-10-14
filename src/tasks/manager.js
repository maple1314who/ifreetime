/**
 * 异步任务管理器：提交 → 排队执行 → 状态查询 → 音频文件下载/删除，带 TTL 清理。
 * 进度/失败信息都存在内存 Map 里（个人自用够用；重启会丢，可接受）。
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { errors } from '../utils/errors.js';

export const STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
};

export class TaskManager {
  /**
   * @param {object} deps
   * @param {(payload: object) => Promise<{audio: Buffer, format: string, extension: string, contentType: string}>} deps.synthesize 合成函数（注入，方便测试/换实现）
   * @param {number} deps.concurrency 并发执行上限
   * @param {number} deps.ttlMs 音频文件保留时长
   * @param {string} deps.dataDir 文件存放目录
   * @param {number} deps.cleanupIntervalMs 清理定时器间隔
   */
  constructor({ synthesize, concurrency = 4, ttlMs, dataDir, cleanupIntervalMs }) {
    this.synthesize = synthesize;
    this.concurrency = concurrency;
    this.ttlMs = ttlMs;
    this.dataDir = dataDir;
    this.tasks = new Map();
    this.queue = []; // 等待执行的任务 ID
    this.active = 0;
    mkdir(dataDir, { recursive: true }).catch(() => {});
    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  /** 提交任务，立即返回 taskId（后台异步执行） */
  submit(payload) {
    const task = {
      id: randomUUID(),
      status: STATUS.PENDING,
      payload,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      result: null, // { format, extension, contentType, bytes }
      error: null,  // { code, message }
      filePath: null,
    };
    this.tasks.set(task.id, task);
    this._schedule(task);
    return task.id;
  }

  _schedule(task) {
    if (this.active < this.concurrency) {
      this.active += 1;
      this._run(task);
    } else {
      this.queue.push(task);
    }
  }

  async _run(task) {
    task.status = STATUS.RUNNING;
    task.updatedAt = Date.now();
    try {
      const { audio, format, extension, contentType } = await this.synthesize(task.payload);
      const filePath = path.join(this.dataDir, `${task.id}.${extension || 'bin'}`);
      await writeFile(filePath, audio);
      task.status = STATUS.SUCCEEDED;
      task.filePath = filePath;
      task.result = { format, extension, contentType, bytes: audio.length };
    } catch (err) {
      task.status = STATUS.FAILED;
      task.error = { code: err.code || 'internal_error', message: err.message };
      logger.error('任务合成失败', { taskId: task.id, error: err.message });
    } finally {
      task.updatedAt = Date.now();
      this.active -= 1;
      const next = this.queue.shift();
      if (next) this._run(next);
    }
  }

  /** 查询任务状态（详情），任务不存在抛 404 */
  status(id) {
    const t = this.tasks.get(id);
    if (!t) throw errors.taskNotFound(id);
    return {
      taskId: t.id,
      status: t.status,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      result: t.result,
      error: t.error,
    };
  }

  /** 成功任务的音频文件路径，未成功/不存在抛错 */
  audioPath(id) {
    const t = this.tasks.get(id);
    if (!t) throw errors.taskNotFound(id);
    if (t.status !== STATUS.SUCCEEDED) throw errors.taskNotReady(t.status);
    return t.filePath;
  }

  /** 删除任务及音频文件 */
  async remove(id) {
    const t = this.tasks.get(id);
    if (!t) throw errors.taskNotFound(id);
    this.tasks.delete(id);
    if (t.filePath) await unlink(t.filePath).catch(() => {});
  }

  /** TTL 清理：跑掉过期任务及其文件 */
  async cleanup() {
    const now = Date.now();
    let removed = 0;
    for (const t of this.tasks.values()) {
      if (t.status === STATUS.PENDING || t.status === STATUS.RUNNING) continue;
      if (now - t.updatedAt > this.ttlMs) {
        await this.remove(t.id).catch(() => {});
        removed += 1;
      }
    }
    if (removed > 0) logger.info('任务 TTL 清理', { removed });
  }

  stats() {
    return { total: this.tasks.size, active: this.active, queued: this.queue.length };
  }

  stop() {
    clearInterval(this.cleanupTimer);
  }
}