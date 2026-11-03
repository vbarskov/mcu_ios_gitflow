import { access, readFile, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

async function json(root, relativePath) {
  try {
    return JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
  } catch (error) {
    throw new Error(`Не удалось прочитать ${relativePath}: ${error.message}`);
  }
}

async function containedPath(root, relativePath) {
  requireValue(typeof relativePath === 'string' && relativePath.startsWith('./'), `Путь должен начинаться с ./: ${relativePath}`);
  const rootPath = await realpath(root);
  const resolved = await realpath(path.resolve(rootPath, relativePath));
  const relative = path.relative(rootPath, resolved);
  requireValue(!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative), `Путь выходит из пакета: ${relativePath}`);
  return resolved;
}

export async function validatePackage(root = packageRoot) {
  const [manifest, compatibility, kimiManifest, portableMcp, legacyMcp, marketplace, pkg] = await Promise.all([
    json(root, 'plugin.json'),
    json(root, '.codex-plugin/plugin.json'),
    json(root, 'kimi.plugin.json'),
    json(root, 'mcp.json'),
    json(root, '.mcp.json'),
    json(root, '.agents/plugins/marketplace.json'),
    json(root, 'package.json'),
  ]);
  requireValue(manifest.$schema === 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', 'Неизвестная схема plugin.json');
  requireValue(manifest.name === 'mcu-ios-gitflow' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.name), 'Некорректный идентификатор плагина');
  requireValue(/^\d+\.\d+\.\d+$/.test(manifest.version), 'Версия должна иметь вид N.N.N');
  requireValue(Boolean(manifest.description?.trim()), 'Описание плагина обязательно');
  requireValue(manifest.name === compatibility.name && manifest.name === kimiManifest.name && manifest.name === pkg.name, 'Имена пакета и манифестов не совпадают');
  requireValue(manifest.version === compatibility.version && manifest.version === kimiManifest.version && manifest.version === pkg.version, 'Версии пакета и манифестов не совпадают');
  requireValue(manifest.author?.name === 'MCU iOS' && manifest.author.name === compatibility.author?.name && manifest.author.name === kimiManifest.author?.name, 'Не совпадают авторы манифестов');
  requireValue(compatibility.skills === './skills/' && compatibility.mcpServers === './.mcp.json', 'Некорректные ссылки совместимого манифеста');
  requireValue(kimiManifest.skills === './skills/', 'Некорректная ссылка навыков Kimi Code');
  const kimiServer = kimiManifest.mcpServers?.mcu_ios_gitflow;
  requireValue(kimiServer?.command === 'node' && kimiServer.cwd === './', 'Не настроен stdio MCP Kimi Code');
  requireValue(JSON.stringify(kimiServer.args) === JSON.stringify(['./scripts/mcp-server.mjs']), 'Некорректный путь MCP Kimi Code');
  await containedPath(root, kimiManifest.skills);
  await containedPath(root, compatibility.skills);
  await containedPath(root, compatibility.mcpServers);
  const onboarding = manifest.extensions?.['com.openai']?.onboardingSkill;
  requireValue(onboarding === './skills/setup/SKILL.md', 'Не указан навык настройки');
  await containedPath(root, onboarding);
  requireValue(portableMcp.$schema === 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', 'Неизвестная схема mcp.json');
  for (const key of Object.keys(portableMcp)) requireValue(['$schema', 'mcpServers'].includes(key), `Лишнее поле mcp.json: ${key}`);
  const portableServer = portableMcp.mcpServers?.mcu_ios_gitflow;
  const legacyServer = legacyMcp.mcpServers?.mcu_ios_gitflow;
  requireValue(portableServer?.type === 'stdio' && portableServer.command === 'node', 'Плагин должен запускать локальный stdio MCP через Node.js');
  requireValue(legacyServer?.command === 'node', 'Не настроен совместимый stdio MCP');
  requireValue(JSON.stringify(portableServer.args) === JSON.stringify(['${PLUGIN_ROOT}/scripts/mcp-server.mjs']), 'Некорректный переносимый путь MCP');
  requireValue(JSON.stringify(legacyServer.args) === JSON.stringify(['${CLAUDE_PLUGIN_ROOT}/scripts/mcp-server.mjs']), 'Некорректный совместимый путь MCP');
  await containedPath(root, './scripts/mcp-server.mjs');
  await containedPath(root, './scripts/cli.mjs');
  await containedPath(root, './scripts/setup.mjs');
  requireValue(marketplace.name === 'mcu-local', 'Некорректное имя локального каталога');
  const entry = marketplace.plugins?.find(item => item.name === manifest.name);
  requireValue(entry?.source?.source === 'local' && entry.source.path === './', 'Каталог должен ссылаться на корень этого пакета');
  requireValue(entry.policy?.installation === 'AVAILABLE' && entry.policy?.authentication === 'ON_INSTALL' && entry.category === 'Developer Tools', 'Не указана политика установки каталога');
  await containedPath(root, entry.source.path);
  requireValue(!pkg.dependencies && !pkg.devDependencies, 'Плагин должен работать без внешних npm-зависимостей');
  requireValue(pkg.type === 'module' && pkg.engines?.node === '>=22.13', 'Требуется Node.js 22.13+ и ESM');
  requireValue(pkg.dsh?.bundle?.patch === './dsh/cordis.patch.yml', 'Не указан DSH-слой пакета');
  const dshPatch = await readFile(await containedPath(root, pkg.dsh.bundle.patch), 'utf8');
  requireValue(dshPatch.includes(`id: ${pkg.name}`) && dshPatch.includes(`name: ${pkg.name}`), `DSH-патч должен подключать пакет ${pkg.name}`);
  const dshModule = await readFile(await containedPath(root, './dsh/lib/index.js'), 'utf8');
  await containedPath(root, './dsh/install-mcp.mjs');

  const skills = [];
  for (const entry of await readdir(path.join(root, 'skills'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillPath = `./skills/${entry.name}/SKILL.md`;
    const skill = await readFile(await containedPath(root, skillPath), 'utf8');
    const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    requireValue(Boolean(frontmatter), `Нет YAML-описания навыка: ${entry.name}`);
    requireValue(frontmatter.match(/^name:\s*(.+)$/m)?.[1] === entry.name, `Имя навыка не совпадает с каталогом: ${entry.name}`);
    requireValue(Boolean(frontmatter.match(/^description:\s*\S.+$/m)), `Нет описания навыка: ${entry.name}`);
    skills.push(entry.name);
  }
  for (const required of ['setup', 'implement-task', 'git-flow']) requireValue(skills.includes(required), `Нет навыка ${required}`);
  for (const skillName of skills) requireValue(dshModule.includes(`'${skillName}'`), `Навык ${skillName} не зарегистрирован в DSH-слое`);
  await access(path.join(root, 'README.md'));
  return { name: manifest.name, version: manifest.version, skills: skills.sort() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await validatePackage();
    process.stdout.write(`Пакет ${result.name} ${result.version}: манифесты, MCP и ${result.skills.length} навыка проверены.\n`);
  } catch (error) {
    process.stderr.write(`Ошибка пакета: ${error.message}\n`);
    process.exitCode = 1;
  }
}
