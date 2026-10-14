/**
 * 供应商注册表 —— 工厂模式。
 * 按名字创建供应商实例，调用方不关心具体类；
 * 新增供应商 = 实现 Provider + 在这里登记一行。
 *
 * 注册表存的是工厂函数（懒加载），每次 createProvider 返回新实例 ——
 * 供应商实现保持无状态，天然适合并发请求。
 */
import { Provider } from './base.js';
import { EdgeProvider } from './edge/provider.js';
import { MimoProvider } from './mimo/provider.js';
import { errors } from '../utils/errors.js';

const factories = new Map();

export function registerProvider(name, factory) {
  if (typeof factory !== 'function') {
    throw new Error(`registerProvider('${name}') 需要工厂函数`);
  }
  factories.set(name, factory);
}

export function createProvider(name) {
  const factory = factories.get(name);
  if (!factory) throw errors.providerNotFound(name);
  return factory();
}

export function listProviders() {
  return [...factories.keys()];
}

// 内置供应商登记：Edge（微软大声朗读）、MiMo（小米官方 API）
registerProvider('edge', () => new EdgeProvider());
registerProvider('mimo', () => new MimoProvider());