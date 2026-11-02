import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as core from '../lib/core/flow.mjs';

const localGit = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

test('Git запрещает SSH, подмену HTTPS через insteadOf и другие помощники протоколов', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcu-git-policy-'));
  try {
    const repo = join(dir, 'repo');
    await mkdir(repo);
    localGit(repo, 'init', '--initial-branch=release');
    const marker = join(dir, 'ssh-used');
    const ssh = join(dir, 'ssh-mock');
    await writeFile(ssh, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o700 });
    localGit(repo, 'config', 'core.sshCommand', ssh);
    localGit(repo, 'config', 'url.ssh://git@git.example.test/.insteadOf', 'https://git.example.test/');
    await assert.rejects(core.git(repo, 'ls-remote', 'https://git.example.test/repo.git'), /transport 'ssh' not allowed/);
    await assert.rejects(access(marker), { code: 'ENOENT' });
    await assert.rejects(core.git(repo, 'ls-remote', 'ext::echo unsafe'), /transport 'ext' not allowed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Разрешение SSH существует только в текущем асинхронном вызове', async () => {
  assert.equal(typeof core.withGitPermissions, 'function');
  const dir = await mkdtemp(join(tmpdir(), 'mcu-git-context-'));
  try {
    const repo = join(dir, 'repo');
    await mkdir(repo);
    localGit(repo, 'init', '--initial-branch=release');
    const marker = join(dir, 'ssh-used');
    const ssh = join(dir, 'ssh-mock');
    await writeFile(ssh, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o700 });
    localGit(repo, 'config', 'core.sshCommand', ssh);
    await Promise.all([
      core.withGitPermissions({ allowSsh: true }, async () => {
        await assert.rejects(core.git(repo, 'ls-remote', 'ssh://git@git.example.test/repo.git'), error => !error.message.includes("transport 'ssh' not allowed"));
      }),
      assert.rejects(core.git(repo, 'ls-remote', 'ssh://git@git.example.test/repo.git'), /transport 'ssh' not allowed/),
    ]);
    await access(marker);
    await assert.rejects(core.git(repo, 'ls-remote', 'ssh://git@git.example.test/repo.git'), /transport 'ssh' not allowed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
