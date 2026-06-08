// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { describe, it, expect } from 'vitest';
import { instanceDir, publicUrlPreview, redactSecrets, slugify, splitDetail } from './formatting';

describe('slugify', () => {
  it('produces a valid instance id suggestion', () => {
    expect(slugify('Clinic A')).toBe('clinic-a');
    expect(slugify('  Düsseldorf Study!! ')).toBe('dusseldorf-study');
    expect(slugify('123 leading digits')).toBe('leading-digits');
  });

  it('caps length and trims trailing hyphens', () => {
    const long = slugify('x'.repeat(60));
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith('-')).toBe(false);
  });
});

describe('publicUrlPreview', () => {
  it('builds an https URL for production', () => {
    expect(publicUrlPreview({ mode: 'production', domain: 'app.uni.edu' })).toBe('https://app.uni.edu');
  });
  it('builds a localhost URL for local mode', () => {
    expect(publicUrlPreview({ mode: 'local', localPort: 8081 })).toBe('http://localhost:8081');
    expect(publicUrlPreview({ mode: 'local' })).toBe('http://localhost:8080');
  });
});

describe('instanceDir', () => {
  it('joins root and instance id, normalising trailing slashes', () => {
    expect(instanceDir('/opt/selfhelp/', 'clinic-a')).toBe('/opt/selfhelp/instances/clinic-a');
    expect(instanceDir('', '')).toBe('/opt/selfhelp/instances/instance');
  });
});

describe('splitDetail', () => {
  it('splits a joined summary into trimmed lines', () => {
    expect(splitDetail('Disk OK. RAM low. Ports free.')).toEqual(['Disk OK.', 'RAM low.', 'Ports free.']);
    expect(splitDetail(undefined)).toEqual([]);
  });
});

describe('redactSecrets', () => {
  it('masks secret-looking values but keeps surrounding text', () => {
    expect(redactSecrets('token=supersecret123')).toBe('token=••••••');
    expect(redactSecrets('db password: hunter2')).toBe('db password: ••••••');
    expect(redactSecrets('All services healthy.')).toBe('All services healthy.');
  });
});
