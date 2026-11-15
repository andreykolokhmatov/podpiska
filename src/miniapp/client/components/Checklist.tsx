'use client';

import { Cell, Section } from '@telegram-apps/telegram-ui';
import { Check, ChevronRight } from 'lucide-react';

import type { ChecklistStep, ChecklistStepId } from '../build';
import { t } from '../texts';

interface ChecklistProps {
  steps: ChecklistStep[];
  onStep: (id: ChecklistStepId) => void;
}

export function Checklist({ steps, onStep }: ChecklistProps) {
  return (
    <Section header={t.hub.checklistHeader} className="pd-checklist">
      {steps.map((step, i) => {
        const copy = t.hub.steps[step.id];
        const actionable = step.id !== 'issue' && step.state !== 'done';
        return (
          <Cell
            key={step.id}
            before={
              <span
                className={`pd-step pd-step--${step.state}`}
                data-last={i === steps.length - 1}
                aria-label={step.state === 'done' ? 'Готово' : `Шаг ${step.index}`}
              >
                {step.state === 'done' ? <Check size={16} strokeWidth={3} /> : step.index}
              </span>
            }
            after={actionable ? <ChevronRight className="pd-chevron" size={20} /> : undefined}
            subtitle={copy.subtitle}
            className={step.state === 'done' ? 'pd-step-cell--done' : undefined}
            {...(actionable ? { onClick: () => onStep(step.id) } : {})}
          >
            {copy.title}
          </Cell>
        );
      })}
    </Section>
  );
}
