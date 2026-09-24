import { TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { describe, expect, it, vi } from 'vitest';
import { DialogSiScaleResetsComponent } from './dialog-si-scale-resets.component';
import type { ISiScaleReset } from '../../interfaces/app-settings.interfaces';

const RESETS: ISiScaleReset[] = [
  { dashboard: 'Helm', widget: 'Engine RPM', type: 'widget-gauge-ng-radial', options: ['displayScale.lower', 'displayScale.upper'] },
  { dashboard: 'Nav', widget: 'widget-data-graph', type: 'widget-data-graph', options: ['yScaleMin'] },
  { dashboard: 'Helm', widget: 'Coolant', type: 'widget-numeric', options: ['yScaleMax'] }
];

function render() {
  const dialogRef = { close: vi.fn() };
  TestBed.configureTestingModule({
    imports: [DialogSiScaleResetsComponent],
    providers: [
      { provide: MAT_DIALOG_DATA, useValue: RESETS },
      { provide: MatDialogRef, useValue: dialogRef }
    ]
  });
  const fixture = TestBed.createComponent(DialogSiScaleResetsComponent);
  fixture.detectChanges();
  return { el: fixture.nativeElement as HTMLElement, dialogRef };
}

function button(el: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(el.querySelectorAll('button')).find(b => b.textContent?.trim() === label);
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

describe('DialogSiScaleResetsComponent', () => {
  it('lists the reset widgets under their dashboards, each dashboard once', () => {
    const { el } = render();
    const groups = Array.from(el.querySelectorAll('.reset-dashboard')).map(g => ({
      dashboard: g.querySelector('.reset-dashboard-name')?.textContent?.trim(),
      widgets: Array.from(g.querySelectorAll('li')).map(li => li.textContent?.trim())
    }));
    expect(groups).toEqual([
      { dashboard: 'Helm', widgets: ['Engine RPM', 'Coolant'] },
      { dashboard: 'Nav', widgets: ['widget-data-graph'] }
    ]);
  });

  it('closes with true on Dismiss and false on Later', () => {
    const { el, dialogRef } = render();
    button(el, 'Dismiss').click();
    expect(dialogRef.close).toHaveBeenLastCalledWith(true);
    button(el, 'Later').click();
    expect(dialogRef.close).toHaveBeenLastCalledWith(false);
  });
});
