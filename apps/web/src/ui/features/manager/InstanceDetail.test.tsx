// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
/**
 * Instance detail page: component / plugin / health cards, update dry-run + execute gating and restore / clone confirmation.
 *
 * Split out of the original `InstanceManagement.test.tsx`; renders through the
 * shared Mantine-aware `../../test/render` and the in-memory
 * `../../test/fake-client`. The test bodies are unchanged.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within, userEvent } from '../../test/render';
import { InstanceDetail } from './InstanceDetail';
import { FAKE_DRY_RUN_PLAN, makeFakeClient, fakeInstance, fakeManifest, fakeOperation } from '../../test/fake-client';

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

  it('full delete demands the typed "delete <id>" confirmation; remove-containers does not', async () => {
    const user = userEvent.setup();
    render(<InstanceDetail client={makeFakeClient()} instanceId="clinic-a" />);

    await user.click(await screen.findByRole('button', { name: /remove…/i }));
    const dialog = await screen.findByRole('dialog');

    // Disable now lives on its own toggle button, NOT inside the Remove dialog.
    expect(within(dialog).queryByRole('radio', { name: /^disable/i })).not.toBeInTheDocument();

    // Default mode (remove containers, keep data) needs no typed confirmation.
    expect(within(dialog).getByRole('button', { name: /remove containers/i })).toBeEnabled();

    await user.click(within(dialog).getByRole('radio', { name: /full delete/i }));
    const deleteButton = within(dialog).getByRole('button', { name: /delete instance/i });
    expect(deleteButton).toBeDisabled();

    await user.type(within(dialog).getByLabelText(/type the confirmation/i), 'delete clinic-a');
    expect(deleteButton).toBeEnabled();

    await user.click(deleteButton);
    expect(await screen.findByText(/instance_remove finished/)).toBeInTheDocument();
  });

  it('shows a Disable toggle for an active instance and confirms the reversible stop', async () => {
    const user = userEvent.setup();
    const client = makeFakeClient();
    const disableSpy = vi.spyOn(client, 'disableInstance');
    render(<InstanceDetail client={client} instanceId="clinic-a" />);

    // An active instance offers Disable… and NOT Enable.
    const disableButton = await screen.findByRole('button', { name: /^disable…$/i });
    expect(screen.queryByRole('button', { name: /^enable$/i })).not.toBeInTheDocument();

    await user.click(disableButton);
    const dialog = await screen.findByRole('dialog');
    // It is explicit that data is kept and the action is reversible.
    expect(within(dialog).getByText(/fully reversible/i)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /disable instance/i }));
    expect(disableSpy).toHaveBeenCalledWith('clinic-a');
    expect(await screen.findByText(/instance_disable finished/)).toBeInTheDocument();
  });

  it('shows an Enable toggle for a disabled instance and brings it back online', async () => {
    const user = userEvent.setup();
    const client = makeFakeClient({ instances: [fakeInstance({ status: 'disabled' })] });
    const enableSpy = vi.spyOn(client, 'enableInstance');
    render(<InstanceDetail client={client} instanceId="clinic-a" />);

    // A disabled instance offers Enable and NOT Disable… (the whole point of
    // the request: there was previously no way back from "disabled").
    const enableButton = await screen.findByRole('button', { name: /^enable$/i });
    expect(screen.queryByRole('button', { name: /^disable…$/i })).not.toBeInTheDocument();

    await user.click(enableButton);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/comes back exactly as it was/i)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /enable instance/i }));
    expect(enableSpy).toHaveBeenCalledWith('clinic-a');
    expect(await screen.findByText(/instance_enable finished/)).toBeInTheDocument();
  });

  it('toggles safe mode from the GUI with explicit enable AND disable options', async () => {
    const user = userEvent.setup();
    const client = makeFakeClient();
    const safeModeSpy = vi.spyOn(client, 'setSafeMode');
    render(<InstanceDetail client={client} instanceId="clinic-a" />);

    await user.click(await screen.findByRole('button', { name: /^safe mode…$/i }));
    const dialog = await screen.findByRole('dialog');

    // Both directions are offered so the operator chooses (enable to stop a
    // crash loop, disable to bring plugins back).
    expect(within(dialog).getByRole('button', { name: /enable safe mode/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /disable safe mode/i })).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /enable safe mode/i }));
    expect(safeModeSpy).toHaveBeenCalledWith('clinic-a', { enable: true });
    expect(await screen.findByText(/instance_safe_mode finished/)).toBeInTheDocument();
  });

  it('disables safe mode from the GUI', async () => {
    const user = userEvent.setup();
    const client = makeFakeClient();
    const safeModeSpy = vi.spyOn(client, 'setSafeMode');
    render(<InstanceDetail client={client} instanceId="clinic-a" />);

    await user.click(await screen.findByRole('button', { name: /^safe mode…$/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /disable safe mode/i }));

    expect(safeModeSpy).toHaveBeenCalledWith('clinic-a', { enable: false });
    expect(await screen.findByText(/instance_safe_mode finished/)).toBeInTheDocument();
  });

  it('runs plugin recovery from the GUI and watches the live operation log', async () => {
    const user = userEvent.setup();
    const client = makeFakeClient();
    const recoverSpy = vi.spyOn(client, 'pluginRecover');
    render(<InstanceDetail client={client} instanceId="clinic-a" />);

    await user.click(await screen.findByRole('button', { name: /^plugin recover…$/i }));
    const dialog = await screen.findByRole('dialog');
    // The dialog explains the crash-loop it fixes and that no data is deleted.
    expect(within(dialog).getByText(/not found/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/no data is deleted/i)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /recover plugins/i }));
    expect(recoverSpy).toHaveBeenCalledWith('clinic-a');
    expect(await screen.findByText(/instance_plugin_recover finished/)).toBeInTheDocument();
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
