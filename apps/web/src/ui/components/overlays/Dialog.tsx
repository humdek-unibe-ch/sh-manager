// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import type { ReactNode } from 'react';
import { Modal } from '@mantine/core';

export interface DialogProps {
  opened: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Pinned footer area — typically the action buttons. */
  footer?: ReactNode;
  /** Mantine modal size token or explicit width. */
  size?: number | string;
  /** Close when clicking the overlay (default true). */
  closeOnClickOutside?: boolean;
  /**
   * When `true` (default) the body itself is the single scroll region — the
   * standard shell. Set `false` when the content needs to PIN something at the
   * top (e.g. filter controls) and scroll only a sub-region: the body then
   * becomes a non-scrolling flex column and the child owns the one scrollbar.
   */
  scrollBody?: boolean;
  children: ReactNode;
}

/**
 * Standard manager modal shell: a sticky header, a SINGLE scrollable body, and
 * an optional sticky footer — the same header / body / footer split the CMS
 * frontend uses. The body is the only scroll region, so a dialog never shows a
 * second (inner) scrollbar. Content placed inside must therefore NOT add its
 * own `ScrollArea` — unless it opts out with `scrollBody={false}` to pin a
 * header and scroll just a sub-region (then it provides exactly one inner
 * scroll, never two).
 */
export function Dialog({
  opened,
  onClose,
  title,
  footer,
  size = 'lg',
  closeOnClickOutside = true,
  scrollBody = true,
  children,
}: DialogProps): JSX.Element {
  return (
    <Modal.Root opened={opened} onClose={onClose} size={size} centered closeOnClickOutside={closeOnClickOutside}>
      <Modal.Overlay />
      {/* Flex column + capped height so the header/footer stay put and only the
          body scrolls (one scrollbar for the whole dialog). */}
      <Modal.Content style={{ display: 'flex', flexDirection: 'column', maxHeight: 'min(85vh, 760px)' }}>
        <Modal.Header>
          <Modal.Title>{title}</Modal.Title>
          <Modal.CloseButton />
        </Modal.Header>
        <Modal.Body
          style={
            scrollBody
              ? { flex: 1, minHeight: 0, overflowY: 'auto' }
              : // Non-scrolling flex column: the child pins its header and owns
                // the single inner scroll region (no nested/double scrollbar).
                { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }
          }
        >
          {children}
        </Modal.Body>
        {footer ? (
          <div
            style={{
              flexShrink: 0,
              borderTop: '1px solid var(--mantine-color-default-border)',
              padding: 'var(--mantine-spacing-md)',
            }}
          >
            {footer}
          </div>
        ) : null}
      </Modal.Content>
    </Modal.Root>
  );
}
