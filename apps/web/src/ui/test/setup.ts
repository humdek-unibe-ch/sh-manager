// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
/**
 * Global Vitest setup. Adds the jest-dom matchers (`toBeInTheDocument`, …) to
 * `expect`, plus the small set of jsdom polyfills Mantine relies on. Importing
 * this in node-environment package tests is harmless: the polyfills are guarded
 * by a `window` check and the matchers only extend the matcher table.
 */
import '@testing-library/jest-dom/vitest';

// --- jsdom polyfills Mantine relies on (mirrors the frontend setup) ---------
if (typeof window !== 'undefined') {
  if (!window.matchMedia) {
    window.matchMedia = (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList;
  }

  // Mantine ScrollArea / overlays call these; jsdom does not implement them.
  if (!window.HTMLElement.prototype.scrollIntoView) {
    window.HTMLElement.prototype.scrollIntoView = () => {};
  }
}

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;
