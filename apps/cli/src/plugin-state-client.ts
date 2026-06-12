// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Transport for the manager's plugin-operator role on managed-mode instances.
 *
 * The backend parks managed-mode plugin operations in `plugin_operations`
 * (status `running`, log stage `managed-runbook`) after it has verified the
 * plugin signature and staged the artifacts — the runbook carries the exact
 * composer command + repository the operator must run. This client reads
 * those parked operations and the durable `plugins` rows via
 * `docker compose exec -T backend php -r …` (PDO over the container's own
 * DATABASE_URL), so nothing is exposed on the host network and no extra
 * credential exists: the manager only uses what it already has (the socket).
 */
import type { ComposeRunner } from '@shm/docker';
import type {
  InstalledPluginRecord,
  PendingPluginOperation,
  PluginExecDeps,
  SymfonyService,
} from '@shm/core';

export interface PluginStateClient {
  /** Managed-mode operations parked by the backend and waiting for the operator. */
  listPendingOperations(): Promise<PendingPluginOperation[]>;
  /** Durable installed-plugin rows (survive container recreates). */
  listInstalledPlugins(): Promise<InstalledPluginRecord[]>;
}

/**
 * PHP one-liner executed inside the backend container. Mode comes from argv
 * (never interpolated into code); connects with PDO over the container's own
 * DATABASE_URL and prints a JSON array. `pending` filters to operations that
 * carry a managed-runbook log entry — operations the backend has verified,
 * staged, and explicitly handed to the operator. Anything else (still being
 * processed by the worker, or non-managed modes) is left alone.
 */
const PLUGIN_STATE_PHP = [
  '$mode=$argv[1];',
  "$u=parse_url(getenv('DATABASE_URL')?:'');",
  "$pdo=new PDO('mysql:host='.($u['host']??'mysql').';port='.($u['port']??3306).';dbname='.ltrim($u['path']??'','/').';charset=utf8mb4',",
  "urldecode($u['user']??''),urldecode($u['pass']??''),[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);",
  "if($mode==='pending'){",
  '$rows=$pdo->query("SELECT id,plugin_id,type,logs_json FROM plugin_operations WHERE status=\'running\' ORDER BY id")->fetchAll(PDO::FETCH_ASSOC);',
  '$out=[];foreach($rows as $r){',
  "$logs=json_decode($r['logs_json']?:'[]',true)?:[];$rb=null;",
  "foreach($logs as $l){if(is_array($l)&&($l['stage']??'')==='managed-runbook'&&is_array($l['runbook']??null)){$rb=$l['runbook'];}}",
  'if($rb===null)continue;',
  "$out[]=['operationId'=>(int)$r['id'],'pluginId'=>$r['plugin_id'],'type'=>$r['type'],",
  "'command'=>(string)($rb['command']??''),'repository'=>$rb['repository']??null,",
  "'archiveBackendDir'=>$rb['archiveBackendDir']??null,'archiveStagingDir'=>$rb['archiveStagingDir']??null];",
  '}echo json_encode($out);',
  '}else{',
  '$rows=$pdo->query("SELECT plugin_id,version,enabled,backend_package,manifest_json FROM plugins ORDER BY plugin_id")->fetchAll(PDO::FETCH_ASSOC);',
  '$out=[];foreach($rows as $r){',
  "$m=json_decode($r['manifest_json']?:'null',true);$c=is_array($m)?($m['backend']['composer']??null):null;",
  "$out[]=['pluginId'=>$r['plugin_id'],'version'=>$r['version'],'enabled'=>(bool)$r['enabled'],",
  "'package'=>($r['backend_package']?:(is_array($c)?($c['package']??null):null)),",
  "'composerVersion'=>is_array($c)?($c['version']??null):null,",
  "'repository'=>is_array($c)?($c['repository']??null):null];",
  '}echo json_encode($out);',
  '}',
].join('');

interface PendingRowDto {
  operationId: number;
  pluginId: string;
  type: string;
  command: string;
  repository: { type?: string; url?: string } | null;
  archiveBackendDir: string | null;
  archiveStagingDir: string | null;
}

interface InstalledRowDto {
  pluginId: string;
  version: string;
  enabled: boolean;
  package: string | null;
  composerVersion: string | null;
  repository: { type?: string; url?: string } | null;
}

/**
 * Extract composer coordinates from the runbook's literal command — the
 * backend formats `composer require <pkg>:<ver> …` / `composer remove <pkg> …`,
 * and the command string is the operator contract, so it is the safest source.
 */
export function parseRunbookCommand(command: string): { package: string | null; version: string | null } {
  const requireMatch = /^composer require (\S+?):(\S+)(?:\s|$)/.exec(command);
  if (requireMatch) return { package: requireMatch[1] ?? null, version: requireMatch[2] ?? null };
  const removeMatch = /^composer remove (\S+)(?:\s|$)/.exec(command);
  if (removeMatch) return { package: removeMatch[1] ?? null, version: null };
  return { package: null, version: null };
}

function toPendingOperation(dto: PendingRowDto): PendingPluginOperation {
  const { package: pkg, version } = parseRunbookCommand(dto.command);
  // Standalone archives have no upstream repo: the backend staged the package
  // under a durable path and the operator registers it as a composer path repo.
  const repository =
    dto.repository ?? (dto.archiveBackendDir ? { type: 'path', url: dto.archiveBackendDir } : null);
  const type: PendingPluginOperation['type'] =
    dto.type === 'uninstall' ? 'uninstall' : dto.type === 'update' ? 'update' : 'install';
  return {
    operationId: dto.operationId,
    pluginId: dto.pluginId,
    type,
    package: pkg,
    version,
    repository,
    archiveStagingDir: dto.archiveStagingDir ?? null,
  };
}

export interface ComposeExecPluginStateClientOptions {
  runner: ComposeRunner;
  /** Instance directory containing the compose project. */
  instanceDir: string;
}

export class ComposeExecPluginStateClient implements PluginStateClient {
  private readonly runner: ComposeRunner;
  private readonly instanceDir: string;

  constructor(opts: ComposeExecPluginStateClientOptions) {
    this.runner = opts.runner;
    this.instanceDir = opts.instanceDir;
  }

  private async query<T>(mode: 'pending' | 'installed'): Promise<T[]> {
    const { stdout } = await this.runner.run(this.instanceDir, [
      'exec', '-T', 'backend', 'php', '-r', PLUGIN_STATE_PHP, '--', mode,
    ]);
    const text = stdout.trim();
    try {
      const parsed = JSON.parse(text === '' ? '[]' : text) as T[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      throw new Error(`Backend returned a non-JSON plugin-state response (${mode}): ${text.slice(0, 200)}`);
    }
  }

  async listPendingOperations(): Promise<PendingPluginOperation[]> {
    const rows = await this.query<PendingRowDto>('pending');
    return rows.map(toPendingOperation);
  }

  async listInstalledPlugins(): Promise<InstalledPluginRecord[]> {
    const rows = await this.query<InstalledRowDto>('installed');
    return rows.map((r) => ({
      pluginId: r.pluginId,
      version: r.composerVersion ?? r.version,
      enabled: r.enabled,
      package: r.package,
      repository: r.repository,
    }));
  }
}

/**
 * {@link PluginExecDeps} implementation over the instance's compose project:
 * `exec` runs inside the named Symfony service, `restart` restarts the listed
 * services in one invocation. Used by the plugin-state orchestration in
 * @shm/core for drains, post-update reinstalls, and recreate restores.
 */
export function composePluginExecDeps(
  runner: ComposeRunner,
  instanceDir: string,
  log?: (line: string) => void | Promise<void>,
): PluginExecDeps {
  return {
    exec: async (service: SymfonyService, cmd: string[], opts?: { user?: string; env?: Record<string, string> }) => {
      const args = ['exec', '-T'];
      if (opts?.user) args.push('--user', opts.user);
      for (const [key, value] of Object.entries(opts?.env ?? {})) args.push('-e', `${key}=${value}`);
      args.push(service, ...cmd);
      const { stdout } = await runner.run(instanceDir, args);
      return stdout;
    },
    restart: async (services: readonly SymfonyService[]) => {
      await runner.run(instanceDir, ['restart', ...services]);
    },
    ...(log ? { log } : {}),
  };
}
