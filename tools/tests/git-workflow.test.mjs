import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { checkReleaseGit } from '../git-preflight.mjs';

const run = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, '../..');
const evidenceRoot = path.join(projectRoot, 'work/git-setup-20261006');
const version = '9.9.9';
const git = (cwd, ...args) => run('git', args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
async function write(root, name, text) {
  await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await fs.writeFile(path.join(root, name), text);
}
async function fixture() {
  await fs.mkdir(evidenceRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(evidenceRoot, 'fixture-'));
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.name', 'Git workflow fixture');
  await git(root, 'config', 'user.email', 'fixture@example.invalid');
  await git(root, 'config', 'core.autocrlf', 'false');
  await write(root, '.gitignore', '/outputs/*.zip\n/outputs/*.rar\n/outputs/Chrome插件-YouTube中文字幕/\n/work/*\n!/work/package-release.mjs\n!/work/package-release.py\n**/.env\n');
  await write(root, 'outputs/youtube-zh-assistant/package.json', JSON.stringify({ version }));
  await write(root, 'outputs/youtube-zh-assistant/extension/manifest.json', JSON.stringify({ version }));
  await write(root, 'outputs/youtube-zh-assistant/extension/popup.js', "$('version').textContent=chrome.runtime.getManifest().version;");
  await write(root, 'outputs/youtube-zh-assistant/extension/popup.html', '<span id="version" class="version"></span>');
  await write(root, 'outputs/youtube-zh-assistant/server/app.mjs', `version: '${version}'; version: '${version}';`);
  await write(root, 'outputs/youtube-zh-assistant/verification/package-report.json', '{"fixture":true}');
  await write(root, `outputs/youtube-zh-assistant/开发记录/v${version}.md`, `v${version}\n${'已验证的夹具开发记录。'.repeat(60)}\n## 版本信息\n## 改动内容\n## 验证结果\n## 交付文件\n## 回退方式\n`);
  for (const name of ['tools/git-preflight.mjs', 'tools/new-task.ps1', 'tools/backup-git.ps1', 'work/package-release.mjs', 'work/package-release.py']) {
    await write(root, name, await fs.readFile(path.join(projectRoot, name), 'utf8'));
  }
  await git(root, 'add', '.');
  await git(root, 'commit', '-q', '-m', 'fixture baseline');
  return root;
}
const preflight = root => checkReleaseGit({ repoRoot: root, version });
const powershell = (root, script, ...args) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'tools', script), ...args], { cwd: root, windowsHide: true });

test('干净 main 通过发布检查，返回真实提交', async () => {
  const root = await fixture();
  const report = await preflight(root);
  assert.equal(report.sourceCommit, (await git(root, 'rev-parse', 'HEAD')).stdout.trim());
  assert.equal(report.sourceBranch, 'main');
  assert.equal(report.expectedTag, 'v9.9.9');
});

test('未提交、未跟踪和 ignored 交付文件均被拦截', async () => {
  const root = await fixture();
  await write(root, 'outputs/youtube-zh-assistant/package.json', JSON.stringify({ version, changed: true }));
  await assert.rejects(preflight(root), /未提交修改/);
  await git(root, 'restore', '--', 'outputs/youtube-zh-assistant/package.json');
  await write(root, 'unknown.txt', 'fixture');
  await assert.rejects(preflight(root), /未提交修改/);
  await fs.unlink(path.join(root, 'unknown.txt'));
  await write(root, 'outputs/youtube-zh-assistant/.env', 'FIXTURE=never-package');
  await assert.rejects(preflight(root), /未纳入 Git/);
});

test('任务分支和 detached HEAD 不能发布', async () => {
  const root = await fixture();
  await git(root, 'switch', '-c', 'fix/fixture');
  await assert.rejects(preflight(root), /只能从 main/);
  await git(root, 'switch', '--detach');
  await assert.rejects(preflight(root), /只能从 main/);
});

test('既有版本标签与 ZIP/RAR 均不能覆盖', async () => {
  const root = await fixture();
  await git(root, 'tag', 'v9.9.9');
  await assert.rejects(preflight(root), /标签 v9.9.9 已存在/);
  await git(root, 'tag', '-d', 'v9.9.9');
  for (const name of ['youtube-zh-assistant-v9.9.9.zip', 'Chrome插件-YouTube中文字幕-v9.9.9.rar']) {
    await write(root, `outputs/${name}`, 'existing fixture archive');
    await assert.rejects(preflight(root), /不能覆盖旧安装包/);
    assert.equal(await fs.readFile(path.join(root, 'outputs', name), 'utf8'), 'existing fixture archive');
    await fs.unlink(path.join(root, 'outputs', name));
  }
});

test('打包入口 --check 通过且不写插件、报告或安装包；拒绝时也不写', async () => {
  const root = await fixture();
  const entry = path.join(root, 'work/package-release.mjs');
  const result = JSON.parse((await run(process.execPath, [entry, '--check'], { cwd: root, windowsHide: true })).stdout);
  assert.equal(result.workingTreeCleanBeforePackaging, true);
  assert.equal(result.sourceCommit, (await git(root, 'rev-parse', 'HEAD')).stdout.trim());
  await assert.rejects(fs.access(path.join(root, 'outputs/Chrome插件-YouTube中文字幕')));
  assert.equal(await fs.readFile(path.join(root, 'outputs/youtube-zh-assistant/verification/package-report.json'), 'utf8'), '{"fixture":true}');
  await git(root, 'tag', 'v9.9.9');
  await assert.rejects(run(process.execPath, [entry], { cwd: root, windowsHide: true }), error => /标签 v9.9.9 已存在/.test(error.stderr));
  await assert.rejects(fs.access(path.join(root, 'outputs/Chrome插件-YouTube中文字幕')));
  await assert.rejects(fs.access(path.join(root, 'outputs/youtube-zh-assistant-v9.9.9.zip')));
});

test('隔离夹具真实生成 ZIP/RAR 与 sourceCommit 报告，拒绝再次覆盖', async () => {
  const root = await fixture();
  const sourceCommit = (await git(root, 'rev-parse', 'HEAD')).stdout.trim();
  const entry = path.join(root, 'work/package-release.mjs');
  const report = JSON.parse((await run(process.execPath, [entry], { cwd: root, windowsHide: true })).stdout);
  assert.equal(report.sourceCommit, sourceCommit);
  assert.equal(report.folderHashesMatch, true);
  assert.equal(report.rarExtractedHashesMatch, true);
  assert.equal(report.zipVerified, true);
  assert.equal(report.workingTreeCleanBeforePackaging, true);
  const hash = async filename => createHash('sha256').update(await fs.readFile(filename)).digest('hex');
  const zipHash = await hash(report.zipFile);
  const rarHash = await hash(report.rarFile);
  await git(root, 'add', 'outputs/youtube-zh-assistant/verification/package-report.json');
  await git(root, 'commit', '-q', '-m', 'fixture release evidence');
  await assert.rejects(run(process.execPath, [entry], { cwd: root, windowsHide: true }), error => /不能覆盖旧安装包/.test(error.stderr));
  assert.equal(await hash(report.zipFile), zipHash);
  assert.equal(await hash(report.rarFile), rarHash);
});

test('原有开发记录和版本检查仍先于 Git/交付写入生效', async () => {
  const root = await fixture();
  const entry = path.join(root, 'work/package-release.mjs');
  const record = path.join(root, `outputs/youtube-zh-assistant/开发记录/v${version}.md`);
  const complete = await fs.readFile(record, 'utf8');
  for (const [content, expected] of [[null, /缺少开发记录/], ['v9.9.9\n未填写', /开发记录必须写明/], [complete + '待验证', /未完成事项/]]) {
    if (content === null) await fs.unlink(record);
    else await fs.writeFile(record, content);
    await assert.rejects(run(process.execPath, [entry], { cwd: root, windowsHide: true }), error => expected.test(error.stderr));
  }
  await fs.writeFile(record, complete);
  await write(root, 'outputs/youtube-zh-assistant/extension/manifest.json', JSON.stringify({ version: '9.9.8' }));
  await assert.rejects(run(process.execPath, [entry], { cwd: root, windowsHide: true }), error => /版本不一致/.test(error.stderr));
  await assert.rejects(fs.access(path.join(root, 'outputs/Chrome插件-YouTube中文字幕')));
});

test('PowerShell 创建独立任务，拒绝重复/脏 main/错误分支', async () => {
  const root = await fixture();
  const before = (await git(root, 'rev-parse', 'HEAD')).stdout.trim();
  const report = JSON.parse((await powershell(root, 'new-task.ps1', '-Name', 'subtitle-layout', '-Type', 'fix')).stdout);
  assert.equal(report.branch, 'fix/subtitle-layout');
  assert.equal(report.baseCommit, before);
  assert.equal(path.resolve(report.workspace), path.resolve(root + '-worktrees', 'subtitle-layout'));
  assert.equal((await git(report.workspace, 'branch', '--show-current')).stdout.trim(), report.branch);
  assert.equal((await git(root, 'branch', '--show-current')).stdout.trim(), 'main');
  await write(report.workspace, 'task-only.txt', 'isolated change');
  await assert.rejects(fs.access(path.join(root, 'task-only.txt')));
  assert.equal((await git(root, 'status', '--porcelain')).stdout.trim(), '');
  await assert.rejects(powershell(root, 'new-task.ps1', '-Name', 'subtitle-layout'), error => /已存在/.test(error.stderr));
  await write(root, 'main-uncommitted.txt', 'must not lose');
  await assert.rejects(powershell(root, 'new-task.ps1', '-Name', 'second-task'), error => /未提交内容/.test(error.stderr));
  assert.equal(await fs.readFile(path.join(root, 'main-uncommitted.txt'), 'utf8'), 'must not lose');
  await fs.unlink(path.join(root, 'main-uncommitted.txt'));
  await git(root, 'switch', '-c', 'chore/fixture');
  await assert.rejects(powershell(root, 'new-task.ps1', '-Name', 'second-task'), error => /main 主工作目录/.test(error.stderr));
});

test('bundle 实际恢复 main、任务分支、标签且不包含未提交文件', async () => {
  const root = await fixture();
  await git(root, 'switch', '-c', 'fix/saved-task');
  await write(root, 'committed-task.txt', 'recover this task');
  await git(root, 'add', 'committed-task.txt');
  await git(root, 'commit', '-q', '-m', 'save task');
  const taskCommit = (await git(root, 'rev-parse', 'HEAD')).stdout.trim();
  await git(root, 'switch', 'main');
  await git(root, 'tag', 'v9.9.9');
  await write(root, 'not-committed.txt', 'not backed up');
  const backupRoot = root + '-backups';
  const backup = JSON.parse((await powershell(root, 'backup-git.ps1', '-Destination', backupRoot)).stdout.replace(/^[^{]*/, ''));
  assert.equal(backup.sha256.length, 64);
  assert.equal(backup.head, (await git(root, 'rev-parse', 'HEAD')).stdout.trim());
  const restored = root + '-restored';
  await git(root, 'clone', '-b', 'main', backup.bundle, restored);
  await git(restored, 'fsck', '--full');
  assert.equal((await git(restored, 'rev-parse', 'HEAD')).stdout.trim(), backup.head);
  assert.equal((await git(restored, 'rev-parse', 'refs/remotes/origin/fix/saved-task')).stdout.trim(), taskCommit);
  assert.equal((await git(restored, 'tag', '--list', 'v9.9.9')).stdout.trim(), 'v9.9.9');
  await assert.rejects(fs.access(path.join(restored, 'not-committed.txt')));
  const second = JSON.parse((await powershell(root, 'backup-git.ps1', '-Destination', backupRoot)).stdout.replace(/^[^{]*/, ''));
  assert.notEqual(second.bundle, backup.bundle);
  await fs.access(backup.bundle);
});
