import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppError, DEFAULTS, validateConfig } from './core.mjs';
import { runProcess } from './providers.mjs';

export class Storage {
  constructor(runtimeDir) { this.dir = runtimeDir; this.config = { ...DEFAULTS }; this.key = process.env.OPENAI_API_KEY || ''; this.keySource = this.key ? 'environment' : 'none'; }
  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    try { this.config = validateConfig(JSON.parse(await fs.readFile(path.join(this.dir, 'config.json'), 'utf8'))); } catch (error) { if (error.code !== 'ENOENT') throw new AppError('本机配置文件损坏，请检查 work 运行目录中的 config.json。', 500); }
    const tokenFile = path.join(this.dir, 'pairing-token.txt');
    try { this.token = (await fs.readFile(tokenFile, 'utf8')).trim(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.token = randomBytes(32).toString('hex'); await fs.writeFile(tokenFile, this.token, { mode: 0o600 }); }
    if (!/^[a-f0-9]{64}$/.test(this.token)) throw new AppError('本机配对文件损坏。', 500);
    if (!this.key && process.platform === 'win32') {
      try {
        const encrypted = await fs.readFile(path.join(this.dir, 'api-key.dpapi'), 'utf8');
        this.key = await this.dpapi('Unprotect', encrypted); this.keySource = 'windows-dpapi';
      } catch (error) { if (error.code !== 'ENOENT') this.keySource = 'decrypt-failed'; }
    }
    return this;
  }
  async dpapi(action, value) {
    const helper = path.join(import.meta.dirname, 'secrets.ps1');
    const result = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Action', action], { input: value, timeout: 15000, maxOutput: 65536 });
    if (result.code !== 0) throw new AppError('Windows 密钥保护失败，请选择仅本次运行保存。', 500, 'SECRET_STORAGE_FAILED');
    return result.stdout.trim();
  }
  async save(input) {
    const config = validateConfig(input, this.config);
    if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 4096 || /[\r\n]/.test(input.apiKey))) throw new AppError('API 密钥格式无效。');
    if (input.clearApiKey === true) {
      await fs.rm(path.join(this.dir, 'api-key.dpapi'), { force: true }); this.key = ''; this.keySource = 'none';
    } else if (input.apiKey?.trim()) {
      const value = input.apiKey.trim();
      if (input.rememberApiKey === true) {
        if (process.platform !== 'win32') throw new AppError('当前系统仅支持内存保存密钥或环境变量。');
        await fs.writeFile(path.join(this.dir, 'api-key.dpapi'), await this.dpapi('Protect', value), { mode: 0o600 });
        this.keySource = 'windows-dpapi';
      } else {
        await fs.rm(path.join(this.dir, 'api-key.dpapi'), { force: true }); this.keySource = 'memory';
      }
      this.key = value;
    }
    await fs.writeFile(path.join(this.dir, 'config.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
    this.config = config;
    return config;
  }
}
