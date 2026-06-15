// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Test render helper. Wraps the unit-under-test in the same providers the SPA
 * mounts at runtime (`MantineProvider` + `QueryClientProvider` + notifications)
 * so component tests exercise Mantine and react-query exactly like production.
 *
 * Import `render`, `screen`, `userEvent`, etc. from here instead of
 * `@testing-library/react` in any `.tsx` test.
 */
import type { ReactElement, ReactNode } from 'react';
import {
  render as rtlRender,
  type RenderOptions,
  type RenderResult,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { theme } from '../theme';

/** A throwaway QueryClient with retries/cache off — deterministic per test. */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

export interface TestRenderOptions extends Omit<RenderOptions, 'wrapper'> {
  /**
   * Initial router history. The SPA mounts a `BrowserRouter` in `main.tsx`, so
   * components like the operations console depend on a router context; tests
   * get an in-memory one. Defaults to the root path (the dashboard).
   */
  initialEntries?: string[];
}

export function render(ui: ReactElement, options?: TestRenderOptions): RenderResult {
  const { initialEntries = ['/'], ...rtlOptions } = options ?? {};
  const client = createTestQueryClient();
  function Wrapper({ children }: { children: ReactNode }): JSX.Element {
    return (
      // `env="test"` switches Mantine transitions/portals to their synchronous
      // test-mode path — without it, dropdowns never become visible in jsdom.
      <MemoryRouter initialEntries={initialEntries}>
        <MantineProvider theme={theme} env="test">
          <QueryClientProvider client={client}>
            <Notifications />
            {children}
          </QueryClientProvider>
        </MantineProvider>
      </MemoryRouter>
    );
  }
  return rtlRender(ui, { wrapper: Wrapper, ...rtlOptions });
}

// Re-export the RTL surface tests need (explicitly, NOT via `export *`, so the
// wrapped `render` above is the only `render` exported from this module).
export {
  screen,
  within,
  waitFor,
  waitForElementToBeRemoved,
  fireEvent,
  act,
  cleanup,
  renderHook,
} from '@testing-library/react';
export { default as userEvent } from '@testing-library/user-event';
