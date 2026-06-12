// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Registry-driven version picker. Every place that asks for a SelfHelp
 * version (create wizard, update dialog) uses this dropdown so operators pick
 * from the verified release registry instead of typing versions by hand. The
 * list is a display aid only — the server re-resolves and signature-verifies
 * the selected version when the operation actually runs.
 *
 * Free-text entry only appears as a fallback when the registry cannot be
 * reached (offline server), mirroring the bootstrap wizard's behaviour.
 */
import { useQuery } from '@tanstack/react-query';
import { SelectField, TextField } from '../../components';
import type { ApiClient } from '../../lib/api-client';

export interface VersionSelectProps {
  client: ApiClient;
  /** Release channel previewed in the dropdown (server default when omitted). */
  channel?: string;
  /** Current selection: `latest` or a pinned version. */
  value: string;
  onChange: (value: string) => void;
  label?: string;
  help?: string;
}

export function VersionSelect({
  client,
  channel,
  value,
  onChange,
  label = 'SelfHelp version',
  help = 'Pick "latest" for the newest verified release, or pin an exact version from the registry.',
}: VersionSelectProps): JSX.Element {
  const versionsQuery = useQuery({
    queryKey: ['manager', 'registry-versions', channel ?? 'default'],
    queryFn: () => client.listVersions(channel),
    staleTime: 60_000,
    retry: false,
  });

  const versions = versionsQuery.data?.versions ?? [];
  const listUsable = !versionsQuery.isError && !(versionsQuery.isSuccess && versions.length === 0);

  if (!listUsable) {
    return (
      <TextField
        label={label}
        value={value}
        onChange={onChange}
        placeholder="latest"
        help='Could not load the version list from the registry — use "latest" or type an exact version.'
      />
    );
  }

  const options = [
    { value: 'latest', label: 'latest — newest verified release' },
    ...versions.map((v) => ({ value: v, label: v })),
    // Keep a pinned value selectable even when the fetched list misses it.
    ...(value !== 'latest' && value !== '' && !versions.includes(value) ? [{ value, label: value }] : []),
  ];

  return (
    <SelectField
      label={label}
      value={value === '' ? 'latest' : value}
      options={options}
      onChange={onChange}
      help={versionsQuery.isPending ? 'Loading versions from the registry…' : help}
    />
  );
}
