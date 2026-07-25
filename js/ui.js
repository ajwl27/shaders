/**
 * Declarative control panel. Pieces describe the controls they want; the shell
 * owns the DOM and tears it all down on piece change.
 */
export function createUI(root) {
  const owned = [];

  function add(el) {
    root.appendChild(el);
    owned.push(el);
    return el;
  }

  function wrap(className = 'ctl') {
    const d = document.createElement('div');
    d.className = className;
    return d;
  }

  return {
    /** Section heading. */
    group(title) {
      const d = wrap('ctl-group');
      d.textContent = title;
      add(d);
    },

    /**
     * Slider. `format` turns the raw value into display text.
     * Returns a handle so the piece can drive the value programmatically.
     */
    slider(label, { min, max, value, step = 0.001, format = (v) => v.toFixed(2) }, onChange) {
      const d = wrap();
      const lab = document.createElement('div');
      lab.className = 'ctl-label';
      const name = document.createElement('span');
      name.textContent = label;
      const val = document.createElement('span');
      val.className = 'ctl-value';
      val.textContent = format(value);
      lab.append(name, val);

      const input = document.createElement('input');
      input.type = 'range';
      input.min = min;
      input.max = max;
      input.step = step;
      input.value = value;
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        val.textContent = format(v);
        onChange(v);
      });

      d.append(lab, input);
      add(d);

      return {
        set(v) {
          input.value = v;
          val.textContent = format(v);
        },
        get() { return parseFloat(input.value); },
      };
    },

    button(label, onClick) {
      const d = wrap();
      const b = document.createElement('button');
      b.className = 'ctl-btn';
      b.textContent = label;
      b.addEventListener('click', onClick);
      d.append(b);
      add(d);
      return b;
    },

    /** Two or more buttons on one row. */
    buttons(items) {
      const d = wrap();
      const row = document.createElement('div');
      row.className = 'ctl-row';
      for (const [label, onClick] of items) {
        const b = document.createElement('button');
        b.className = 'ctl-btn';
        b.textContent = label;
        b.addEventListener('click', onClick);
        row.append(b);
      }
      d.append(row);
      add(d);
    },

    toggle(label, value, onChange) {
      const d = wrap();
      const t = document.createElement('div');
      t.className = 'toggle' + (value ? ' on' : '');
      const name = document.createElement('span');
      name.textContent = label;
      const box = document.createElement('span');
      box.className = 'box';
      t.append(name, box);
      let on = value;
      t.addEventListener('click', () => {
        on = !on;
        t.classList.toggle('on', on);
        onChange(on);
      });
      d.append(t);
      add(d);
      return { set(v) { on = v; t.classList.toggle('on', on); } };
    },

    /** Live numeric display. */
    readout(label, initial = '—') {
      const d = wrap('readout');
      const name = document.createElement('span');
      name.textContent = label;
      const val = document.createElement('b');
      val.textContent = initial;
      d.append(name, val);
      add(d);
      return { set(v) { val.textContent = v; } };
    },

    note(text) {
      const d = wrap('note');
      d.textContent = text;
      add(d);
    },

    /** Escape hatch for pieces that need bespoke DOM. */
    custom(el) {
      add(el);
      return el;
    },

    clear() {
      for (const el of owned) el.remove();
      owned.length = 0;
    },
  };
}
