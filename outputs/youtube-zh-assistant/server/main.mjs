import fs from 'node:fs/promises';
import path from 'node:path';
import { Storage } from './storage.mjs';
import { Providers, findCodex, codexLoginStatus } from './providers.mjs';
import { createApp } from './app.mjs';
import { LocalASR } from './local-asr.mjs';

const root = path.resolve(import.meta.dirname, '..');
const runtimeBase = path.basename(path.dirname(root)) === 'outputs' ? path.resolve(root, '../..') : root;
const runtimeDir = process.env.YTZH_RUNTIME_DIR || path.join(runtimeBase, 'work/youtube-zh-assistant');
const port = 17865;
try {
  const storage = await new Storage(runtimeDir).init();
  const codexBin = await findCodex();
  const providers = new Providers({ runtimeDir, codexBin });
  let loginCache = null, loginTime = 0;
  const getLogin = async () => {
    if (!loginCache || Date.now() - loginTime > 30000) { loginCache = await codexLoginStatus(codexBin, root); loginTime = Date.now(); }
    return loginCache;
  };
  const localAsr = new LocalASR();
  const { server } = createApp({ storage, providers, getLogin, localAsr, webDir: path.join(root, 'web'), allowedPort: port });
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? '17865 端口已被占用。若助手已经运行，可直接打开本机设置页。' : '服务启动失败。'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', async () => {
    await fs.writeFile(path.join(runtimeDir, 'server.pid'), String(process.pid));
    console.log(`YouTube 中文字幕助手已启动：http://127.0.0.1:${port}`);
    console.log('从 start.ps1 打开设置页，复制配对码到扩展。服务仅在本机监听。');
  });
  const stop = async () => { server.close(); await localAsr.stop(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
} catch (error) { console.error(error.message || '初始化失败。'); process.exitCode = 1; }
