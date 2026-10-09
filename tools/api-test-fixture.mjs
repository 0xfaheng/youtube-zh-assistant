import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { apiFixture } from '../outputs/youtube-zh-assistant/server/tests/helpers/api-fixture.mjs';

if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const output=process.argv[2];if (!output) throw new Error('指定当前 worktree 下的输出 JSON 路径');
  const fixture=await apiFixture();
  await fs.mkdir(path.dirname(path.resolve(output)),{recursive:true});
  await fs.writeFile(output,JSON.stringify({url:fixture.url,baseUrl:fixture.baseUrl,token:fixture.storage.token}));
  console.log('隔离 API 测试服务已启动；仅允许本机模拟上游。');
  const stop=async()=>{await fixture.close();process.exit(0);};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
