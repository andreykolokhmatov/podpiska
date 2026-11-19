'use client';

import { Avatar, ButtonCell, Cell, Multiselectable, Section } from '@telegram-apps/telegram-ui';
import type { ReactNode } from 'react';

import { initials } from '../env';
import { t } from '../texts';

/** One row of a pick list; the list does not know where the items came from. */
export interface PickerItem {
  key: string;
  title: string;
  subtitle?: string;
  avatarUrl?: string | null;
  /** Why the row is the way it is («Уже в подписке», «Бот»); null for a plain row. */
  status: string | null;
  selectable: boolean;
  selected: boolean;
}

interface CandidateListProps {
  items: readonly PickerItem[];
  header: ReactNode;
  footer?: ReactNode | undefined;
  onToggle: (key: string) => void;
  /** Omitted: no «Выбрать все / Снять выбор» row (e.g. while checking). */
  onSelectAll?: ((selected: boolean) => void) | undefined;
  disabled?: boolean;
}

export function CandidateList({
  items,
  header,
  footer,
  onToggle,
  onSelectAll,
  disabled = false,
}: CandidateListProps) {
  const selectable = items.filter((i) => i.selectable);
  const allSelected = selectable.length > 0 && selectable.every((i) => i.selected);

  return (
    <Section header={header} footer={footer}>
      {onSelectAll && selectable.length > 1 && (
        <ButtonCell
          className="pd-button-cell"
          disabled={disabled}
          onClick={() => onSelectAll(!allSelected)}
        >
          {allSelected ? t.bulk.selectNone : t.bulk.selectAll}
        </ButtonCell>
      )}
      {items.map((item) => (
        <PickerRow key={item.key} item={item} onToggle={onToggle} disabled={disabled} />
      ))}
    </Section>
  );
}

interface PickerRowProps {
  item: PickerItem;
  onToggle: (key: string) => void;
  disabled: boolean;
}

function PickerRow({ item, onToggle, disabled }: PickerRowProps) {
  const subtitle = [item.subtitle, item.status].filter(Boolean).join(' · ');
  const inactive = !item.selectable || disabled;
  return (
    <Cell
      Component="label"
      className={item.selectable ? 'pd-pick' : 'pd-pick pd-pick--off'}
      before={
        <span className="pd-pick__before">
          <Multiselectable
            checked={item.selectable && item.selected}
            disabled={inactive}
            onChange={() => onToggle(item.key)}
            aria-label={item.title}
          />
          <Avatar
            size={40}
            src={item.avatarUrl ?? undefined}
            referrerPolicy="no-referrer"
            acronym={initials(item.title.replace(/^@/, ''))}
          />
        </span>
      }
      subtitle={subtitle ? <span className="pd-pick__text">{subtitle}</span> : undefined}
    >
      <span className="pd-pick__text">{item.title}</span>
    </Cell>
  );
}
