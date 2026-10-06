import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

async function distributionFiles(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `源码交付目录不允许符号链接：${entry.name}`);
    if (entry.isDirectory()) files.push(...await distributionFiles(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

// 必须在复制插件、生成报告或写安装包之前调用。
export async function checkReleaseGit({ repoRoot, version, outputsRoot = path.join(repoRoot, 'outputs') }) {
  assert.match(version, /^\d+\.\d+\.\d+$/, '版本号必须为三段数字');
  const git = async args => (await run('git', args, { cwd: repoRoot, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })).stdout.trim();
  const top = await git(['rev-parse', '--show-toplevel']);
  assert.ok(samePath(top, repoRoot), '打包入口必须位于项目 Git 仓库根目录下');
  const branch = await git(['branch', '--show-current']);
  assert.equal(branch, 'main', '只能从 main 分支统一打包，任务分支不能发布');
  const status = await git(['status', '--porcelain=v1', '--untracked-files=all']);
  assert.equal(status, '', '仓库存在未提交修改或未跟踪文件，请先完成验证并提交，再打包');
  const sourceCommit = await git(['rev-parse', 'HEAD']);
  const tag = `v${version}`;
  assert.equal(await git(['tag', '--list', tag]), '', `版本标签 ${tag} 已存在，不能重新发布或覆盖旧版本`);
  for (const filename of [`youtube-zh-assistant-v${version}.zip`, `Chrome插件-YouTube中文字幕-v${version}.rar`]) {
    try { await fs.access(path.join(outputsRoot, filename)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error(`安装包 ${filename} 已存在，请使用新版本，不能覆盖旧安装包`);
  }
  const tracked = new Set((await git(['ls-files', '-z'])).split('\0').filter(Boolean));
  for (const absolute of await distributionFiles(path.join(outputsRoot, 'youtube-zh-assistant'))) {
    const relative = path.relative(repoRoot, absolute).split(path.sep).join('/');
    assert.ok(tracked.has(relative), `交付源码中存在未纳入 Git 的文件，不能打包：${relative}`);
  }
  return { sourceCommit, sourceBranch: branch, expectedTag: tag, workingTreeCleanBeforePackaging: true };
}
