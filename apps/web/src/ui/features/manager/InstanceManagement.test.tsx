// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
/**
 * GUI instance management flows: list (incl. broken/busy states), detail with
 * health + backups + operation history, the dry-run-gated update, the typed
 * confirmations on restore and full delete, mode-aware clone + change-address,
 * and the multi-step create wizard with a live operation log. All flows run
 * against the in-memory fake ApiClient, which mirrors the BFF contract
 * (202 + operation journal) and runs the SAME shared validation as the server.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within, userEvent } from '../../test/render';
import { OperationsConsole } from './OperationsConsole';
import { InstanceDetail } from './InstanceDetail';
import { InstancesList } from './InstancesList';
import { OperationLog } from './OperationLog';
import { FAKE_DRY_RUN_PLAN, makeFakeClient, fakeInstance, fakeManifest, fakeOperation } from '../../test/fake-client';

describe('InstancesList', () => {
  it('lists instances with status and surfaces broken ones with a repair hint', async () => {
    const client = makeFakeClient({
      instances: [
        fakeInstance(),
        fakeInstance({
          instanceId: 'ghost',
          displayName: null,
          status: 'broken',
          version: null,
          brokenReason: 'Instance manifest missing or invalid. Run: sh-manager instance repair ghost',
        }),
      ],
    });
    render(<InstancesList client={client} onOpen={() => {}} onCreate={() => {}} />);

    expect(await screen.findByText('clinic-a')).toBeInTheDocument();
    expect(screen.getByText('ghost')).toBeInTheDocument();
    expect(screen.getByText('broken')).toBeInTheDocument();
    expect(screen.getByText('active')).toBeInTheDocument();
    // Security guidance is always visible on the instances overview.
    expect(screen.getByText(/SSH tunnel/i)).toBeInTheDocument();
  });

  it('marks instances locked by a running operation as busy', async () => {
    const client = makeFakeClient({
      instances: [
        fakeInstance({ busy: { operationId: 'op-7', acquiredAt: '2026-06-01T10:00:00.000Z' } }),
      ],
    });
    render(<InstancesList client={client} onOpen={() => {}} onCreate={() => {}} />);

    expect(await screen.findByText('busy')).toBeInTheDocument();
  });

  it('opens an instance through the row link', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<InstancesList client={makeFakeClient()} onOpen={onOpen} onCreate={() => {}} />);

    await user.click(await screen.findByRole('button', { name: 'clinic-a' }));
    expect(onOpen).toHaveBeenCalledWith('clinic-a');
  });
});

describe('InstanceDetail', () => {
  it('shows the overview, backups and operation history for an instance', async () => {
    const client = makeFakeClient({
      operations: [fakeOperation({ id: 'op-9', kind: 'instance_update', status: 'failed', error: 'Health gate failed.' })],
    });
    render(<InstanceDetail client={client} instanceId="clinic-a" />);

    expect(await screen.findByText('clinic-a')).toBeInTheDocument();
    expect(screen.getByText('clinic-a.example')).toBeInTheDocument();
    expect(screen.getByText('0.1.0')).toBeInTheDocument();
    // Backups card with manifest metadata.
    expect(await screen.findByText('bk-20260601-1000')).toBeInTheDocument();
    expect(screen.getByText(/db, uploads, config/)).toBeInTheDocument();
    expect(screen.getByText('12.0 MiB')).toBeInTheDocument();
    // Operation history shows the failed update.
    expect(screen.getByText('instance core update')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  it('paginates a long operation history (25 per page) and navigates pages', async () => {
    const user = userEvent.setup();
    const ops = Array.from({ length: 30 }, (_, i) =>
      fakeOperation({ id: `op-${i + 1}`, kind: 'instance_backup', status: 'succeeded' }),
    );
    render(<InstanceDetail client={makeFakeClient({ operations: ops })} instanceId="clinic-a" />);

    // Footer caption reflects the first page slice of 25 of 30.
    expect(await screen.findByText(/Showing 1.*of 30 operations/)).toBeInTheDocument();
    const page2 = screen.getByRole('button', { name: '2' });
    expect(page2).toBeInTheDocument();

    await user.click(page2);
    expect(await screen.findByText(/Showing 26.*of 30 operations/)).toBeInTheDocument();
  });

  it('renders per-container versions/images and installed plugins from the manifest', async () => {
    const client = makeFakeClient({ manifests: { 'clinic-a': fakeManifest() } });
    render(<InstanceDetail client={client} instanceId="clinic-a" />);

    // Components & versions card: a component row + its recorded version + image.
    expect(await screen.findByText('Components & versions')).toBeInTheDocument();
    expect(screen.getByText('Plugin API')).toBeInTheDocument();
    expect(screen.getByText('1.2.0')).toBeInTheDocument();
    expect(screen.getByText('mysql:8.4')).toBeInTheDocument();
    expect(screen.getByText('dunglas/mercure:v0.16')).toBeInTheDocument();

    // Installed plugins card lists each plugin id + version.
    expect(screen.getByText('Installed plugins')).toBeInTheDocument();
    expect(screen.getByText('sh-shp-llm')).toBeInTheDocument();
    expect(screen.getByText('1.1.0')).toBeInTheDocument();
  });

  it('shows an empty-state in the installed-plugins card when none are recorded', async () => {
    const client = makeFakeClient({ manifests: { 'clinic-a': fakeManifest({ installedPlugins: [] }) } });
    render(<InstanceDetail client={client} instanceId="clinic-a" />);

    expect(await screen.findByText('Installed plugins')).toBeInTheDocument();
    expect(screen.getByText('No plugins installed')).toBeInTheDocument();
  });

  it('runs a health check on demand and renders the per-service report', async () => {
    const user = userEvent.setup();
    render(<InstanceDetail client={makeFakeClient()} instanceId="clinic-a" />);

    await user.click(await screen.findByRole('button', { name: /run health check/i }));

    expect(await screen.findByText('healthy')).toBeInTheDocument();
    expect(screen.getByText('backend')).toBeInTheDocument();
    expect(screen.getByText(/redis/)).toBeInTheDocument();
  });

  it('exposes a refresh control and notifies when a started operation finishes', async () => {
    const user = userEvent.setup();
    render(<InstanceDetail client={makeFakeClient()} instanceId="clinic-a" />);

    // The operation history can be refreshed on demand.
    expect(await screen.findByRole('button', { name: /^Refresh$/i })).toBeInTheDocument();

    // Starting any action watches the journal; the fake op completes at once,
    // so the operator gets a completion toast and the view refreshes itself.
    await user.click(screen.getByRole('button', { name: /create backup/i }));
    expect(await screen.findByText('Operation finished')).toBeInTheDocument();
  });

  it('requires a dry-run and an explicit risk acknowledgement before an update can execute', async () => {
    const user = userEvent.setup();
    render(<InstanceDetail client={makeFakeClient()} instanceId="clinic-a" />);

    await user.click(await screen.findByRole('button', { name: /update…/i }));
    const dialog = await screen.findByRole('dialog');

    // The target version is a registry-driven dropdown, never free text.
    expect(within(dialog).getByLabelText(/target version/i, { selector: 'input' })).toBeInTheDocument();

    // Execute is locked until a dry-run produced a plan AND the risk box is ticked.
    const executeButton = within(dialog).getByRole('button', { name: /execute update/i });
    expect(executeButton).toBeDisabled();

    await user.click(within(dialog).getByRole('button', { name: /run dry-run/i }));
    // Plan line: current 0.1.0 → target 0.2.0 (0.2.0 also exists as a hidden
    // dropdown option, so assert on the unique current version + steps).
    expect(await within(dialog).findByText('0.1.0')).toBeInTheDocument();
    expect(within(dialog).getAllByText('0.2.0').length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/run migrations/)).toBeInTheDocument();
    expect(executeButton).toBeDisabled();

    await user.click(within(dialog).getByRole('checkbox', { name: /I understand the migration risk/i }));
    expect(executeButton).toBeEnabled();

    await user.click(executeButton);
    // The started operation surfaces with its journaled log.
    expect(await screen.findByText('Operation in progress')).toBeInTheDocument();
    expect(await screen.findByText(/instance_update finished/)).toBeInTheDocument();
  });

  it('offers the registry versions in the update dialog dropdown', async () => {
    const user = userEvent.setup();
    render(<InstanceDetail client={makeFakeClient({ availableVersions: ['0.9.1', '0.9.0'] })} instanceId="clinic-a" />);

    await user.click(await screen.findByRole('button', { name: /update…/i }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByLabelText(/target version/i, { selector: 'input' }));
    expect(await screen.findByRole('option', { name: /latest — newest verified release/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '0.9.1' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '0.9.0' })).toBeInTheDocument();
  });

  it('demands an explicit MySQL major-upgrade approval when the dry-run plan requires it', async () => {
    const user = userEvent.setup();
    const client = makeFakeClient({
      dryRunPlan: {
        ...FAKE_DRY_RUN_PLAN,
        mysqlMajor: { isMajorUpgrade: true, requiresApproval: true, fromMajor: 8, toMajor: 9 },
      },
    });
    const executeSpy = vi.spyOn(client, 'executeUpdate');
    render(<InstanceDetail client={client} instanceId="clinic-a" />);

    await user.click(await screen.findByRole('button', { name: /update…/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /run dry-run/i }));

    // The one-way warning names the major jump from the plan.
    expect(await within(dialog).findByText(/MySQL major upgrade — one-way/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/8 → 9/)).toBeInTheDocument();

    // Migration risk alone is NOT enough: the MySQL approval is a second gate.
    const executeButton = within(dialog).getByRole('button', { name: /execute update/i });
    await user.click(within(dialog).getByRole('checkbox', { name: /I understand the migration risk/i }));
    expect(executeButton).toBeDisabled();

    await user.click(within(dialog).getByRole('checkbox', { name: /approve the one-way mysql major upgrade/i }));
    expect(executeButton).toBeEnabled();

    await user.click(executeButton);
    expect(executeSpy).toHaveBeenCalledWith(
      'clinic-a',
      expect.objectContaining({ approveMysqlMajor: true, acceptMigrationRisk: true }),
    );
  });

  it('requires typing the exact confirmation before a restore starts (with auto pre-restore backup note)', async () => {
    const user = userEvent.setup();
    render(<InstanceDetail client={makeFakeClient()} instanceId="clinic-a" />);

    await user.click(await screen.findByRole('button', { name: /restore…/i }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText(/pre-restore backup/i)).toBeInTheDocument();
    const restoreButton = within(dialog).getByRole('button', { name: /restore this backup/i });
    expect(restoreButton).toBeDisabled();

    await user.type(within(dialog).getByLabelText(/type the confirmation/i), 'restore bk-20260601-1000');
    expect(restoreButton).toBeEnabled();

    await user.click(restoreButton);
    expect(await screen.findByText(/instance_restore finished/)).toBeInTheDocument();
  });

  it('full delete demands the typed "delete <id>" confirmation; disable does not', async () => {
    const user = userEvent.setup();
    render(<InstanceDetail client={makeFakeClient()} instanceId="clinic-a" />);

    await user.click(await screen.findByRole('button', { name: /remove…/i }));
    const dialog = await screen.findByRole('dialog');

    // Default mode (disable) needs no typed confirmation.
    expect(within(dialog).getByRole('button', { name: /disable instance/i })).toBeEnabled();

    await user.click(within(dialog).getByRole('radio', { name: /full delete/i }));
    const deleteButton = within(dialog).getByRole('button', { name: /delete instance/i });
    expect(deleteButton).toBeDisabled();

    await user.type(within(dialog).getByLabelText(/type the confirmation/i), 'delete clinic-a');
    expect(deleteButton).toBeEnabled();

    await user.click(deleteButton);
    expect(await screen.findByText(/instance_remove finished/)).toBeInTheDocument();
  });

  it('clones a production instance onto a new domain (fresh secrets announced, id validated)', async () => {
    const user = userEvent.setup();
    render(<InstanceDetail client={makeFakeClient()} instanceId="clinic-a" />);

    await user.click(await screen.findByRole('button', { name: /clone…/i }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText(/fresh secrets/i)).toBeInTheDocument();
    // Production source → the clone asks for a DOMAIN, not a port.
    expect(within(dialog).queryByLabelText(/local port/i)).not.toBeInTheDocument();
    const cloneButton = within(dialog).getByRole('button', { name: /clone instance/i });
    expect(cloneButton).toBeDisabled();

    // Same id as the source is rejected.
    await user.type(within(dialog).getByLabelText(/new instance id/i), 'clinic-a');
    await user.type(within(dialog).getByLabelText(/new domain/i), 'staging.example.org');
    expect(await within(dialog).findByText(/different instance id/i)).toBeInTheDocument();
    expect(cloneButton).toBeDisabled();

    await user.clear(within(dialog).getByLabelText(/new instance id/i));
    await user.type(within(dialog).getByLabelText(/new instance id/i), 'clinic-b');
    expect(cloneButton).toBeEnabled();

    await user.click(cloneButton);
    expect(await screen.findByText(/instance_clone finished/)).toBeInTheDocument();
  });

  it('clones a LOCAL instance onto a new port — no domain asked', async () => {
    const user = userEvent.setup();
    const client = makeFakeClient({
      instances: [fakeInstance({ instanceId: 'local-1', mode: 'local', domain: 'localhost:9123' })],
    });
    render(<InstanceDetail client={client} instanceId="local-1" />);

    await user.click(await screen.findByRole('button', { name: /clone…/i }));
    const dialog = await screen.findByRole('dialog');

    // Local source → the clone asks for a PORT, not a domain.
    expect(within(dialog).queryByLabelText(/new domain/i)).not.toBeInTheDocument();
    const cloneButton = within(dialog).getByRole('button', { name: /clone instance/i });

    await user.type(within(dialog).getByLabelText(/new instance id/i), 'local-2');
    await user.type(within(dialog).getByLabelText(/new local port/i), '9124');
    expect(cloneButton).toBeEnabled();

    await user.click(cloneButton);
    expect(await screen.findByText(/instance_clone finished/)).toBeInTheDocument();
  });

  it('changes a production domain from the manager and announces the automatic restart', async () => {
    const user = userEvent.setup();
    render(<InstanceDetail client={makeFakeClient()} instanceId="clinic-a" />);

    await user.click(await screen.findByRole('button', { name: /change address…/i }));
    const dialog = await screen.findByRole('dialog');

    // The dialog explains the restart and the DNS prerequisite.
    expect(within(dialog).getByText(/restarts automatically/i)).toBeInTheDocument();
    expect(within(dialog).getAllByText(/DNS/i).length).toBeGreaterThan(0);

    const domainInput = within(dialog).getByLabelText(/new domain/i);
    // Prefilled with the current address for easy editing.
    expect(domainInput).toHaveValue('clinic-a.example');

    await user.clear(domainInput);
    await user.type(domainInput, 'clinic-b.example');
    await user.click(within(dialog).getByRole('button', { name: /apply & restart/i }));

    expect(await screen.findByText(/instance_set_address finished/)).toBeInTheDocument();
  });

  it('changes a local port from the manager', async () => {
    const user = userEvent.setup();
    const client = makeFakeClient({
      instances: [fakeInstance({ instanceId: 'local-1', mode: 'local', domain: 'localhost:9123' })],
    });
    render(<InstanceDetail client={client} instanceId="local-1" />);

    await user.click(await screen.findByRole('button', { name: /change address…/i }));
    const dialog = await screen.findByRole('dialog');

    const portInput = within(dialog).getByLabelText(/new local port/i);
    expect(portInput).toHaveValue('9123');

    await user.clear(portInput);
    await user.type(portInput, '9200');
    await user.click(within(dialog).getByRole('button', { name: /apply & restart/i }));

    expect(await screen.findByText(/instance_set_address finished/)).toBeInTheDocument();
  });
});

describe('OperationLog', () => {
  it('renders the journaled log lines and the failure message', async () => {
    const client = makeFakeClient({
      operations: [
        fakeOperation({
          id: 'op-fail',
          kind: 'instance_update',
          status: 'failed',
          log: ['backup: ok', 'migrate: error'],
          error: 'Migration Version123 failed; instance rolled back.',
          result: null,
        }),
      ],
    });
    render(<OperationLog client={client} operationId="op-fail" />);

    expect(await screen.findByText(/backup: ok/)).toBeInTheDocument();
    expect(screen.getByText(/migrate: error/)).toBeInTheDocument();
    expect(screen.getByText('Operation failed')).toBeInTheDocument();
    expect(screen.getByText(/rolled back/i)).toBeInTheDocument();
    // The per-kind step checklist renders alongside the raw log.
    expect(screen.getByText('Resolve & plan update')).toBeInTheDocument();
    expect(screen.getByText('Run database migrations')).toBeInTheDocument();
  });
});

describe('OperationsConsole instance flows', () => {
  it('navigates between the dashboard and an instance through the sidebar', async () => {
    const user = userEvent.setup();
    render(<OperationsConsole client={makeFakeClient()} />);

    // Instances are listed in the left sidebar with their domain.
    const instanceLink = await screen.findByRole('button', { name: 'Instance clinic-a' });
    expect(instanceLink).toHaveTextContent('clinic-a.example');

    await user.click(instanceLink);
    expect(await screen.findByText('Operation history')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Dashboard' }));
    expect(await screen.findByText('Server operations')).toBeInTheDocument();
  });

  /** Drive the full-page wizard past Welcome + Preflight (auto-run, all green). */
  async function passWelcomeAndPreflight(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    // Welcome step.
    expect(await screen.findByText(/checks the environment/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /continue/i }));
    // Preflight runs automatically; all four checks come back green.
    expect(await screen.findByText('Docker engine & Compose')).toBeInTheDocument();
    const cont = screen.getByRole('button', { name: /continue/i });
    await waitFor(() => expect(cont).toBeEnabled());
    await user.click(cont);
  }

  it('creates an instance through the full-page wizard and watches the live install log', async () => {
    const user = userEvent.setup();
    render(<OperationsConsole client={makeFakeClient()} />);

    await screen.findByText('Server operations');
    await user.click(screen.getAllByRole('button', { name: /new instance/i })[0]!);

    expect(await screen.findByText('Create a new instance')).toBeInTheDocument();
    await passWelcomeAndPreflight(user);

    // Basics. The admin password is explicitly NOT shown in the browser; the
    // operator reads the restricted server-side file. The optional mailer DSN
    // lives here too.
    expect(await screen.findByText(/never shown in the browser/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/outbound email/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/display name/i), 'Website One');
    const idInput = screen.getByLabelText(/instance id/i);
    expect(idInput).toHaveValue('website-one'); // auto-suggested from the name
    await user.clear(idInput);
    await user.type(idInput, 'website1');
    await user.type(screen.getByLabelText(/admin email/i), 'admin@example.org');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // Address (production is preselected, needs a domain).
    await user.type(await screen.findByLabelText(/^domain/i), 'site.example.org');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // Release: version comes from the registry dropdown ("latest" default).
    const versionInput = await screen.findByLabelText(/selfhelp version/i, { selector: 'input' });
    expect(versionInput).toHaveValue('latest — newest verified release');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    // Review shows the collected plan, then installs.
    expect(await screen.findByText('site.example.org', { exact: false })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /install instance/i }));

    // The install screen shows the guided phase checklist (driven by the
    // journaled operation phase) plus the raw log. The fake's operation
    // completes instantly, so every row is already ticked.
    expect(await screen.findByText('Resolve & verify release')).toBeInTheDocument();
    expect(screen.getByText('Run database migrations')).toBeInTheDocument();
    expect(screen.getByText('Run health checks')).toBeInTheDocument();

    // The journaled install log streams inside the wizard.
    expect(await screen.findByText(/instance_create finished/)).toBeInTheDocument();
    expect(await screen.findByText(/is installed/i)).toBeInTheDocument();

    // Open the new instance straight from the wizard.
    await user.click(screen.getByRole('button', { name: /open instance/i }));
    expect(await screen.findByText('Operation history')).toBeInTheDocument();
    // The sidebar now lists the new instance too.
    expect(screen.getByRole('button', { name: 'Instance website1' })).toBeInTheDocument();
  });

  it('rejects invalid wizard input with the SAME validation the server runs', async () => {
    const user = userEvent.setup();
    render(<OperationsConsole client={makeFakeClient()} />);

    await screen.findByText('Server operations');
    await user.click(screen.getAllByRole('button', { name: /new instance/i })[0]!);
    await passWelcomeAndPreflight(user);

    await screen.findByText(/never shown in the browser/i);
    await user.type(screen.getByLabelText(/display name/i), 'Bad Instance');
    const idInput = screen.getByLabelText(/instance id/i);
    await user.clear(idInput);
    await user.type(idInput, '-bad-id');
    expect(await screen.findByText(/lowercase letters, digits and dashes/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/admin email/i), 'not-an-email');
    expect(await screen.findByText(/valid email/i)).toBeInTheDocument();

    // A malformed mailer DSN locks the step too (same shared rule as the BFF).
    await user.type(screen.getByLabelText(/outbound email/i), 'mail.example.org');
    expect(await screen.findByText(/smtp:\/\/user:pass@mail\.example\.org/i)).toBeInTheDocument();

    // Continue stays locked while the basics are invalid.
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });
});
