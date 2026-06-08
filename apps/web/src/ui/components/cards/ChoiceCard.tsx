// SPDX-FileCopyrightText: 2026 Humdek, University of Bern
// SPDX-License-Identifier: MPL-2.0
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
    <button type="button" className="shm-choice" aria-pressed={selected} onClick={onSelect}>
      {selected ? (
        <span className="shm-choice__check" aria-hidden="true">
          ✓
        </span>
      ) : recommended ? (
        <span className="shm-choice__rec">Recommended</span>
      ) : null}
      {icon ? (
        <span className="shm-choice__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="shm-choice__title">{title}</span>
      <span className="shm-choice__desc">{description}</span>
      {bullets && bullets.length > 0 ? (
        <ul className="shm-choice__list">
          {bullets.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      ) : null}
    </button>
  );
}
