// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * View model that maps the server's granular wizard steps onto a small set of
 * operator-friendly phases (the top stepper) and supplies the human copy for
 * each step. The server's step order remains the single source of truth — we
 * never reorder it here, we only group it for presentation.
 */
import type { WizardStepId } from './types';

export interface WizardPhase {
  id: string;
  label: string;
  /** Server steps that belong to this phase. */
  steps: WizardStepId[];
}

export const WIZARD_PHASES: WizardPhase[] = [
  { id: 'welcome', label: 'Welcome', steps: ['welcome'] },
  { id: 'preflight', label: 'Preflight', steps: ['docker', 'internet', 'registry'] },
  { id: 'resources', label: 'Resources', steps: ['install_root', 'resources'] },
  { id: 'configure', label: 'Configure', steps: ['mode', 'domain', 'proxy', 'instance', 'admin'] },
  { id: 'review', label: 'Review', steps: ['install'] },
  { id: 'install', label: 'Install', steps: ['health'] },
  { id: 'done', label: 'Done', steps: ['done'] },
];

export function phaseIndexForStep(step: WizardStepId): number {
  const idx = WIZARD_PHASES.findIndex((p) => p.steps.includes(step));
  return idx < 0 ? 0 : idx;
}

/** The phase to highlight, accounting for the in-session install/success UI. */
export function activePhaseIndex(step: WizardStepId, installing: boolean, installed: boolean): number {
  if (installed || step === 'done') return WIZARD_PHASES.length - 1;
  if (installing) return WIZARD_PHASES.findIndex((p) => p.id === 'install');
  return phaseIndexForStep(step);
}

export interface CheckMeta {
  title: string;
  description: string;
  /** Shown when the check fails — a concrete, non-scary next action. */
  fix: string;
}

export const CHECK_META: Record<string, CheckMeta> = {
  docker: {
    title: 'Docker engine & Compose',
    description: 'SelfHelp runs as isolated Docker containers managed with Compose v2.',
    fix: 'Install Docker Engine and the Compose v2 plugin, then start the Docker service.',
  },
  internet: {
    title: 'Outbound internet access',
    description: 'Required to download verified container images and the release registry.',
    fix: 'Allow outbound HTTPS (443) from this server, or configure a proxy.',
  },
  registry: {
    title: 'Official registry & signatures',
    description: 'Releases are verified against the official SelfHelp signing keys before install.',
    fix: 'Check the registry URL is reachable and that the trusted-keys file is present.',
  },
  resources: {
    title: 'System resources',
    description: 'Disk, memory and required ports are checked before anything is created.',
    fix: 'Free up disk/RAM, or release the required ports, then run the check again.',
  },
};

export interface StepCopy {
  eyebrow: string;
  title: string;
  lead: string;
}

export const STEP_COPY: Partial<Record<WizardStepId, StepCopy>> = {
  install_root: {
    eyebrow: 'Location',
    title: 'Where should SelfHelp live?',
    lead: 'All instances, secrets, proxy config and backups are stored under this root directory.',
  },
  mode: {
    eyebrow: 'Installation mode',
    title: 'How will this server be used?',
    lead: 'Pick the mode that matches your environment. You can run more instances later.',
  },
  domain: {
    eyebrow: 'Public address',
    title: 'Where will people reach this instance?',
    lead: 'This determines the public URL and how TLS and routing are configured.',
  },
  proxy: {
    eyebrow: 'Networking',
    title: 'Shared reverse proxy',
    lead: 'A single Traefik proxy routes every instance on this server and manages certificates.',
  },
  instance: {
    eyebrow: 'First instance',
    title: 'Configure your first SelfHelp instance',
    lead: 'Give it a name and an id. The id is used for folders, containers and routing.',
  },
  admin: {
    eyebrow: 'Administrator',
    title: 'First administrator (optional)',
    lead: 'Optionally pre-fill the first admin. The password is generated securely and shown once after install — never here.',
  },
};

/** Presentational steps shown on the install-progress screen. */
export interface InstallStepView {
  id: string;
  label: string;
  note?: string;
}

export const INSTALL_STEPS: InstallStepView[] = [
  { id: 'folder', label: 'Create instance folder' },
  { id: 'secrets', label: 'Generate secrets', note: 'Stored in restricted files — never shown.' },
  { id: 'compose', label: 'Generate compose & environment files' },
  { id: 'pull', label: 'Pull verified images' },
  { id: 'start', label: 'Start services' },
  { id: 'db', label: 'Wait for the database' },
  { id: 'migrate', label: 'Run database migrations' },
  { id: 'admin', label: 'Create first admin / setup token' },
  { id: 'plugins', label: 'Install initial plugins' },
  { id: 'health', label: 'Run health checks' },
  { id: 'manifest', label: 'Write manifest & lock file' },
  { id: 'inventory', label: 'Update server inventory' },
  { id: 'readme', label: 'Generate operator README' },
];
