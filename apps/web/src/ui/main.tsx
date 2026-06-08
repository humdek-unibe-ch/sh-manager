// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/theme.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
