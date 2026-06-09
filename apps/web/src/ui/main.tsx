// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { theme } from './theme';
import './styles/theme.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found.');
}

// One client for the whole SPA. Reads are explicit and short-lived (the BFF is
// authoritative), so we disable focus refetching and retries for predictable UX.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
});

createRoot(container).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <QueryClientProvider client={queryClient}>
        <Notifications position="top-right" />
        <App />
      </QueryClientProvider>
    </MantineProvider>
  </StrictMode>,
);
