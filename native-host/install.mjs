import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NATIVE_HOST_NAME, resolveDataFilePath } from './host.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const SOURCE_HOST_PATH = path.join(SCRIPT_DIR, 'host.mjs');
const SOURCE_MANIFEST_PATH = path.join(REPO_ROOT, 'manifest.json');

export function deriveExtensionIdFromPublicKey(base64PublicKey) {
  const normalizedKey = String(base64PublicKey ?? '').replace(/\s+/g, '');
  if (!normalizedKey) {
    throw new Error('manifest.json 缺少有效的 key 字段，无法推导固定的扩展 ID。');
  }
  const der = Buffer.from(normalizedKey, 'base64');
  if (der.length === 0) {
    throw new Error('manifest.json 中的 key 不是有效的 Base64 公钥。');
  }
  const digest = crypto.createHash('sha256').update(der).digest();
  let id = '';
  for (let index = 0; index < 16; index += 1) {
    id += String.fromCharCode(97 + (digest[index] >> 4));
    id += String.fromCharCode(97 + (digest[index] & 0x0f));
  }
  return id;
}

export function resolveInstallDir({
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
  installDir
} = {}) {
  if (installDir) return path.resolve(installDir);
  if (platform === 'win32') {
    const localAppData = String(env.LOCALAPPDATA ?? '').trim() || path.join(homeDir, 'AppData', 'Local');
    return path.join(localAppData, 'miaoji', 'native-host');
  }
  const configRoot = String(env.XDG_CONFIG_HOME ?? '').trim() || path.join(homeDir, '.config');
  return path.join(configRoot, 'miaoji', 'native-host');
}

export function getBrowserNativeHostTargets({
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir()
} = {}) {
  if (platform === 'darwin') {
    const support = path.join(homeDir, 'Library', 'Application Support');
    return [
      { label: 'Google Chrome', browserDir: path.join(support, 'Google', 'Chrome') },
      { label: 'Google Chrome Canary', browserDir: path.join(support, 'Google', 'Chrome Canary') },
      { label: 'Chromium', browserDir: path.join(support, 'Chromium') },
      { label: 'Microsoft Edge', browserDir: path.join(support, 'Microsoft Edge') },
      { label: 'Brave', browserDir: path.join(support, 'BraveSoftware', 'Brave-Browser') },
      { label: 'Arc', browserDir: path.join(support, 'Arc', 'User Data') }
    ].map((target) => ({
      ...target,
      manifestDir: path.join(target.browserDir, 'NativeMessagingHosts'),
      manifestPath: path.join(target.browserDir, 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`)
    }));
  }

  if (platform === 'linux') {
    const config = String(env.XDG_CONFIG_HOME ?? '').trim() || path.join(homeDir, '.config');
    return [
      { label: 'Google Chrome', browserDir: path.join(config, 'google-chrome') },
      { label: 'Chromium', browserDir: path.join(config, 'chromium') },
      { label: 'Microsoft Edge', browserDir: path.join(config, 'microsoft-edge') },
      { label: 'Brave', browserDir: path.join(config, 'BraveSoftware', 'Brave-Browser') }
    ].map((target) => ({
      ...target,
      manifestDir: path.join(target.browserDir, 'NativeMessagingHosts'),
      manifestPath: path.join(target.browserDir, 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`)
    }));
  }

  if (platform === 'win32') {
    return [
      {
        label: 'Google Chrome',
        registryKey: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
      },
      {
        label: 'Microsoft Edge',
        registryKey: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
      },
      {
        label: 'Brave',
        registryKey: `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
      },
      {
        label: 'Chromium',
        registryKey: `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
      }
    ];
  }

  throw new Error(`暂不支持当前操作系统：${platform}`);
}

export function buildHostManifest({ extensionId, launcherPath }) {
  return {
    name: NATIVE_HOST_NAME,
    description: 'Miaoji local persistence host',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`]
  };
}

export function installNativeHost({
  manifestPath = SOURCE_MANIFEST_PATH,
  sourceHostPath = SOURCE_HOST_PATH,
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
  nodeExecPath = process.execPath,
  installDir,
  targetManifestDirs,
  runRegCommand = defaultRunRegCommand
} = {}) {
  const extensionManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const extensionId = deriveExtensionIdFromPublicKey(extensionManifest.key);
  const resolvedInstallDir = resolveInstallDir({ env, platform, homeDir, installDir });
  const installedHostPath = path.join(resolvedInstallDir, 'host.mjs');
  const launcherPath = path.join(
    resolvedInstallDir,
    platform === 'win32' ? 'run-host.cmd' : 'run-host.sh'
  );

  mkdirSync(resolvedInstallDir, { recursive: true, mode: 0o700 });
  copyFileSync(sourceHostPath, installedHostPath);

  if (platform === 'win32') {
    const script = `@echo off\r\n"${nodeExecPath}" "${installedHostPath}" %*\r\n`;
    writeFileSync(launcherPath, script, 'utf8');
  } else {
    const script = `#!/bin/sh\nexec ${quotePosixArg(nodeExecPath)} ${quotePosixArg(installedHostPath)} "$@"\n`;
    writeFileSync(launcherPath, script, { encoding: 'utf8', mode: 0o755 });
    chmodSync(launcherPath, 0o755);
  }

  const hostManifest = buildHostManifest({ extensionId, launcherPath });
  const hostManifestJson = `${JSON.stringify(hostManifest, null, 2)}\n`;
  const registered = [];

  if (platform === 'win32') {
    const manifestFile = path.join(resolvedInstallDir, `${NATIVE_HOST_NAME}.json`);
    writeFileSync(manifestFile, hostManifestJson, 'utf8');
    for (const target of getBrowserNativeHostTargets({ env, platform, homeDir })) {
      runRegCommand(['add', target.registryKey, '/ve', '/t', 'REG_SZ', '/d', manifestFile, '/f']);
      registered.push({ label: target.label, target: target.registryKey, manifestPath: manifestFile });
    }
  } else {
    const targets = Array.isArray(targetManifestDirs) && targetManifestDirs.length > 0
      ? targetManifestDirs.map((dir) => ({
          label: dir,
          manifestDir: path.resolve(dir),
          manifestPath: path.join(path.resolve(dir), `${NATIVE_HOST_NAME}.json`)
        }))
      : selectPosixTargets(getBrowserNativeHostTargets({ env, platform, homeDir }));

    for (const target of targets) {
      mkdirSync(target.manifestDir, { recursive: true });
      writeFileSync(target.manifestPath, hostManifestJson, 'utf8');
      registered.push({ label: target.label, manifestPath: target.manifestPath });
    }
  }

  return {
    extensionId,
    hostName: NATIVE_HOST_NAME,
    installDir: resolvedInstallDir,
    launcherPath,
    dataFilePath: resolveDataFilePath({ env, platform, homeDir }),
    registered
  };
}

export function uninstallNativeHost({
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
  installDir,
  targetManifestDirs,
  runRegCommand = defaultRunRegCommand
} = {}) {
  const resolvedInstallDir = resolveInstallDir({ env, platform, homeDir, installDir });
  const removed = [];

  if (platform === 'win32') {
    for (const target of getBrowserNativeHostTargets({ env, platform, homeDir })) {
      try {
        runRegCommand(['delete', target.registryKey, '/f']);
        removed.push(target.registryKey);
      } catch {
        // Ignore browsers that were never registered.
      }
    }
  } else {
    const targets = Array.isArray(targetManifestDirs) && targetManifestDirs.length > 0
      ? targetManifestDirs.map((dir) => path.join(path.resolve(dir), `${NATIVE_HOST_NAME}.json`))
      : getBrowserNativeHostTargets({ env, platform, homeDir }).map((target) => target.manifestPath);

    for (const manifestPath of targets) {
      if (existsSync(manifestPath)) {
        rmSync(manifestPath, { force: true });
        removed.push(manifestPath);
      }
    }
  }

  if (existsSync(resolvedInstallDir)) {
    rmSync(resolvedInstallDir, { recursive: true, force: true });
    removed.push(resolvedInstallDir);
  }

  return {
    hostName: NATIVE_HOST_NAME,
    installDir: resolvedInstallDir,
    dataFilePath: resolveDataFilePath({ env, platform, homeDir }),
    removed
  };
}

function selectPosixTargets(allTargets) {
  const detected = allTargets.filter((target) => existsSync(target.browserDir));
  return detected.length > 0 ? detected : [allTargets[0]];
}

function quotePosixArg(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function defaultRunRegCommand(args) {
  execFileSync('reg', args, { stdio: 'ignore' });
}

function runCli(argv) {
  const uninstall = argv.includes('--uninstall');
  if (uninstall) {
    const result = uninstallNativeHost();
    console.log(`已移除本机同步服务注册（${result.hostName}）。`);
    console.log(`原有数据文件已保留：${result.dataFilePath}`);
    return;
  }

  const result = installNativeHost();
  console.log(`已安装喵迹本机同步服务（${result.hostName}）`);
  console.log(`固定扩展 ID：${result.extensionId}`);
  console.log(`本机数据文件：${result.dataFilePath}`);
  console.log(`服务安装目录：${result.installDir}`);
  console.log('已注册浏览器：');
  for (const item of result.registered) {
    console.log(`  - ${item.label}: ${item.manifestPath}`);
  }
  console.log('请在 chrome://extensions 中重新加载「喵迹」扩展以立即启用。');
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(process.argv[1]));
  } catch {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
  }
}

if (isMainModule()) {
  runCli(process.argv.slice(2));
}
