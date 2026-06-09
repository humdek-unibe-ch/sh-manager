// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
import { Badge, Group, List, Text, UnstyledButton } from '@mantine/core';

export interface ChoiceCardProps {
  icon?: string;
  title: string;
  description: string;
  bullets?: string[];
  selected: boolean;
  recommended?: boolean;
  onSelect: () => void;
}

export function ChoiceCard({
  icon,
  title,
  description,
  bullets,
  selected,
  recommended,
  onSelect,
}: ChoiceCardProps): JSX.Element {
  return (
    <UnstyledButton
      onClick={onSelect}
      aria-pressed={selected}
      p="md"
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        borderRadius: 'var(--mantine-radius-md)',
        border: `2px solid ${selected ? 'var(--mantine-primary-color-filled)' : 'var(--mantine-color-default-border)'}`,
        background: selected ? 'var(--mantine-primary-color-light)' : 'transparent',
      }}
    >
      <Group justify="space-between" wrap="nowrap">
        {icon ? (
          <Text fz={24} aria-hidden="true">
            {icon}
          </Text>
        ) : (
          <span />
        )}
        {selected ? (
          <Badge color="blue">Selected</Badge>
        ) : recommended ? (
          <Badge variant="light">Recommended</Badge>
        ) : null}
      </Group>
      <Text fw={600} mt="xs">
        {title}
      </Text>
      <Text size="sm" c="dimmed">
        {description}
      </Text>
      {bullets && bullets.length > 0 ? (
        <List size="sm" mt="xs" c="dimmed">
          {bullets.map((b) => (
            <List.Item key={b}>{b}</List.Item>
          ))}
        </List>
      ) : null}
    </UnstyledButton>
  );
}
