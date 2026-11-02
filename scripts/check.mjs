import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { packageRoot, validatePackage } from './validate-package.mjs';

async function javascriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.mcu-ios-gitflow') continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await javascriptFiles(entryPath));
    else if (entry.isFile() && /\.(?:mjs|cjs|js)$/.test(entry.name)) files.push(entryPath);
  }
  return files.sort();
}

try {
  await validatePackage();
  const files = await javascriptFiles(packageRoot);
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${path.relative(packageRoot, file)}: ${(result.stderr || result.stdout).trim()}`);
  }
  process.stdout.write(`Манифесты и синтаксис ${files.length} JavaScript-файлов проверены. Сборка приложения не запускалась.\n`);
} catch (error) {
  process.stderr.write(`Проверка не пройдена: ${error.message}\n`);
  process.exitCode = 1;
}
