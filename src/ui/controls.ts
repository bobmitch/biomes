/** Minimal declarative control panel. No framework; it is a tech sandbox. */

export interface SliderSpec {
  kind: 'slider';
  label: string;
  min: number;
  max: number;
  step: number;
  get: () => number;
  set: (v: number) => void;
  /** Display transform, e.g. frequency -> wavelength in metres. */
  format?: (v: number) => string;
  /** True if changing this invalidates the baked atlas. */
  bake?: boolean;
}

export interface ToggleSpec {
  kind: 'toggle';
  label: string;
  get: () => boolean;
  set: (v: boolean) => void;
  bake?: boolean;
}

export interface SelectSpec {
  kind: 'select';
  label: string;
  options: Array<{ value: string; label: string }>;
  get: () => string;
  set: (v: string) => void;
  bake?: boolean;
}

export interface TextSpec {
  kind: 'text';
  label: string;
  get: () => string;
  set: (v: string) => void;
  bake?: boolean;
}

export type ControlSpec = SliderSpec | ToggleSpec | SelectSpec | TextSpec;

export interface SectionSpec {
  title: string;
  collapsed?: boolean;
  controls: ControlSpec[];
}

export interface PanelHandle {
  /** Re-read every control's current value from the model. */
  sync: () => void;
}

export function buildPanel(
  host: HTMLElement,
  sections: SectionSpec[],
  onChange: (needsBake: boolean) => void,
): PanelHandle {
  host.innerHTML = '';
  const syncs: Array<() => void> = [];

  for (const section of sections) {
    const el = document.createElement('div');
    el.className = 'section' + (section.collapsed ? ' collapsed' : '');

    const head = document.createElement('h2');
    head.innerHTML = `<span>${section.title}</span><span>&#9662;</span>`;
    head.addEventListener('click', () => el.classList.toggle('collapsed'));
    el.appendChild(head);

    const body = document.createElement('div');
    body.className = 'body';
    el.appendChild(body);

    for (const c of section.controls) syncs.push(addControl(body, c, onChange));
    host.appendChild(el);
  }

  return {
    sync: () => { for (const s of syncs) s(); },
  };
}

function addControl(
  body: HTMLElement,
  c: ControlSpec,
  onChange: (needsBake: boolean) => void,
): () => void {
  switch (c.kind) {
    case 'slider': {
      const wrap = document.createElement('div');
      wrap.className = 'slider-wrap';
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('label');
      label.textContent = c.label;
      const val = document.createElement('span');
      val.className = 'val';
      row.appendChild(label);
      row.appendChild(val);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(c.min);
      input.max = String(c.max);
      input.step = String(c.step);
      wrap.appendChild(row);
      wrap.appendChild(input);
      body.appendChild(wrap);

      const show = (v: number): void => {
        val.textContent = c.format ? c.format(v) : formatNumber(v, c.step);
      };
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        c.set(v);
        show(v);
        onChange(c.bake === true);
      });
      return () => {
        const v = c.get();
        input.value = String(v);
        show(v);
      };
    }

    case 'toggle': {
      const label = document.createElement('label');
      label.className = 'check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      const span = document.createElement('span');
      span.textContent = c.label;
      label.appendChild(input);
      label.appendChild(span);
      body.appendChild(label);
      input.addEventListener('change', () => {
        c.set(input.checked);
        onChange(c.bake === true);
      });
      return () => { input.checked = c.get(); };
    }

    case 'select': {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('label');
      label.textContent = c.label;
      const sel = document.createElement('select');
      sel.style.flex = '0 0 150px';
      for (const o of c.options) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        sel.appendChild(opt);
      }
      row.appendChild(label);
      row.appendChild(sel);
      body.appendChild(row);
      sel.addEventListener('change', () => {
        c.set(sel.value);
        onChange(c.bake === true);
      });
      return () => { sel.value = c.get(); };
    }

    case 'text': {
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('label');
      label.textContent = c.label;
      label.style.flex = '0 0 60px';
      const input = document.createElement('input');
      input.type = 'text';
      row.appendChild(label);
      row.appendChild(input);
      body.appendChild(row);
      input.addEventListener('change', () => {
        c.set(input.value);
        onChange(c.bake === true);
      });
      return () => { input.value = c.get(); };
    }
  }
}

function formatNumber(v: number, step: number): string {
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  return v.toFixed(decimals);
}
