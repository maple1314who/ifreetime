/**
 * Provider 抽象基类 —— 策略模式。
 * 每个供应商 = 一个实现类，统一暴露 synthesize / getVoices。
 * 调用方只面向这个接口编程，不知道具体供应商内部实现。
 */
export class Provider {
  constructor(name) {
    if (new.target === Provider) {
      throw new Error('Provider 是抽象类，不能直接实例化');
    }
    this.name = name;
  }

  /** 合成语音。options: { voice, rate, pitch, volume, format, language } */
  async synthesize() {
    throw new Error(`${this.name} 未实现 synthesize()`);
  }

  /** 拉取该供应商可用发音人列表 */
  async getVoices() {
    throw new Error(`${this.name} 未实现 getVoices()`);
  }
}