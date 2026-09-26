const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const benchmark = [
  { name: 'CAP-UDF', clean: [0.329, 6.592], noise03: [1.232, 9.329], noise08: [2.990, 19.492], outliers02: [0.407, 7.101], outliers05: [0.452, 7.886] },
  { name: 'GeoUDF', clean: [0.206, 5.253], noise03: [1.691, 7.628], noise08: [2.968, 11.888], outliers02: [0.241, 5.757], outliers05: [0.243, 5.832] },
  { name: 'DUDF', clean: [0.395, 7.818], noise03: [2.836, 18.463], noise08: [2.047, 10.802], outliers02: [0.628, 9.381], outliers05: [0.639, 10.956] },
  { name: 'DEUDF', clean: [0.465, 15.079], noise03: [2.358, 15.999], noise08: [4.634, 24.952], outliers02: [0.615, 19.658], outliers05: [0.671, 21.009] },
  { name: 'VAD', clean: [0.133, 7.195], noise03: [1.199, 8.495], noise08: [2.311, 10.491], outliers02: [1.089, 14.194], outliers05: [1.050, 13.331] },
  { name: 'Ours', ours: true, clean: [0.123, 7.166], noise03: [1.179, 8.377], noise08: [2.199, 10.172], outliers02: [0.194, 6.707], outliers05: [0.150, 11.269] },
];

function renderBenchmark() {
  const condition = $('#condition-select').value;
  const minimumCD = Math.min(...benchmark.map(row => row[condition][0]));
  const minimumHD = Math.min(...benchmark.map(row => row[condition][1]));
  const max = Math.max(...benchmark.map(row => row[condition][0]));
  $('#results-table').replaceChildren();
  $('#results-chart').replaceChildren();
  benchmark.forEach(row => {
    const [cd, hd] = row[condition];
    const tr = document.createElement('tr');
    tr.className = row.ours ? 'ours' : '';
    [row.name, cd.toFixed(3), hd.toFixed(3)].forEach((value, index) => {
      const td = document.createElement('td');
      td.textContent = value;
      if ((index === 1 && cd === minimumCD) || (index === 2 && hd === minimumHD)) td.className = 'best';
      tr.append(td);
    });
    $('#results-table').append(tr);
    const bar = document.createElement('div');
    bar.className = `bar-row${row.ours ? ' ours' : ''}`;
    const label = document.createElement('span');
    label.textContent = row.name;
    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('div');
    fill.className = 'bar-fill';
    fill.style.width = `${cd / max * 100}%`;
    track.append(fill);
    const value = document.createElement('span');
    value.className = 'bar-value';
    value.textContent = cd.toFixed(3);
    bar.append(label, track, value);
    $('#results-chart').append(bar);
  });
}
$('#condition-select').addEventListener('change', renderBenchmark);
renderBenchmark();

const megabytes = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const MAX_PANELS = 6;
const defaultStatus = 'Local imports stay in your browser. Supported: PLY · OBJ · STL · self-contained GLB.';

async function initializeExplorer(region, cases) {
  const $ = selector => region.querySelector(selector.replace(/^#([\w-]+)$/, '[data-role="$1"]'));
  const $$ = selector => [...region.querySelectorAll(selector)];
  const status = (message, isError = false) => {
    $('#viewer-status').textContent = message;
    $('#viewer-status').classList.toggle('error', isError);
  };
  const { ComparisonViewer, parseModel, disposeObject } = await import('./viewer.js');
  const viewer = new ComparisonViewer($('#viewer-grid'), null, message => status(message, true));
  let generation = 0;
  let currentCase = null;
  let activeKeys = new Set();
  let captureNote = '';
  let pendingRequest = null;
  let loading = false;
  const importVersions = new Map();
  const fail = error => {
    pendingRequest?.abort();
    viewer.dispose();
    const message = document.createElement('p');
    message.className = 'error-message';
    message.textContent = '3D unavailable. Please enable WebGL 2 and hardware acceleration. The descriptions and figures remain available below.';
    $('#viewer-grid').replaceChildren(message);
    $$('button, input').forEach(control => { control.disabled = true; });
    status(error.message, true);
  };

  function setBadge(text, real = false) {
    $('#data-badge').textContent = text;
    $('#data-badge').classList.toggle('real', real);
  }

  function setActiveCase(id) {
    $$('.case-tab').forEach(button => {
      const selected = button.dataset.case === id;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
  }

  async function applyPanels(specs, { preserveCamera = false } = {}) {
    const current = ++generation;
    pendingRequest?.abort();
    const request = new AbortController();
    pendingRequest = request;
    loading = true;
    region.setAttribute('aria-busy', 'true');
    $('#capture').disabled = true;
    const camera = preserveCamera ? viewer.snapshotCamera() : null;
    viewer.setSlots(specs);
    if (camera) viewer.restoreCamera(camera);
    else viewer.reset();
    const failures = [];
    let done = 0;
    const totalBytes = specs.reduce((sum, spec) => sum + (spec.bytes ?? 0), 0);
    status(`Loading ${specs.length} models · ${megabytes(totalBytes)}…`);
    const queue = [...specs];
    const worker = async () => {
      while (queue.length && current === generation) {
        const spec = queue.shift();
        try {
          const model = await spec.load(request.signal);
          if (current !== generation) { disposeObject(model); return; }
          viewer.replaceModel(spec.key, model);
        } catch (error) {
          if (current !== generation) return;
          const slot = viewer.slotByKey(spec.key);
          if (slot) slot.stats.textContent = `Failed: ${error.message}`;
          failures.push(`${spec.label}: ${error.message}`);
        }
        done++;
        if (current === generation) status(`Loaded ${done} of ${specs.length} models…`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, specs.length) }, worker));
    if (current !== generation) return false;
    loading = false;
    region.setAttribute('aria-busy', 'false');
    $('#capture').disabled = !viewer.slots.some(slot => slot.root);
    viewer.fitModels();
    if (failures.length) {
      setBadge('PARTIAL LOAD');
      status(`Some models could not be loaded: ${failures.join(' ')} Select the shape again to retry.`, true);
      return false;
    }
    return true;
  }

  function selectCase(item) {
    currentCase = item;
    const defaults = item.models.filter(model => model.default).slice(0, MAX_PANELS);
    activeKeys = new Set((defaults.length >= 2 ? defaults : item.models.slice(0, 3)).map(model => model.key));
    setActiveCase(item.id);
    renderCase(false).catch(fail);
  }

  function renderChips() {
    const container = $('#method-chips');
    container.replaceChildren();
    if (!currentCase) { $('#method-bar').hidden = true; return; }
    $('#method-bar').hidden = false;
    currentCase.models.forEach(model => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `method-chip${model.ours ? ' chip-ours' : ''}`;
      chip.dataset.key = model.key;
      const active = activeKeys.has(model.key);
      chip.classList.toggle('selected', active);
      chip.setAttribute('aria-pressed', String(active));
      chip.textContent = model.label;
      const size = document.createElement('span');
      size.className = 'chip-size';
      size.textContent = megabytes(model.bytes);
      chip.append(size);
      if (model.note) chip.title = model.note;
      if (!active && activeKeys.size >= MAX_PANELS) {
        chip.disabled = true;
        chip.title = `At most ${MAX_PANELS} panels at once. Switch one off first.`;
      }
      chip.addEventListener('click', () => toggleMethod(model.key));
      container.append(chip);
    });
    const bytes = currentCase.models.filter(model => activeKeys.has(model.key)).reduce((sum, model) => sum + model.bytes, 0);
    $('#method-hint').textContent = `${activeKeys.size} of ${currentCase.models.length} shown · ${megabytes(bytes)}${activeKeys.size >= MAX_PANELS ? ` · maximum ${MAX_PANELS}` : ''}`;
  }

  async function renderCase(preserveCamera = true) {
    if (!currentCase) return;
    const item = currentCase;
    setBadge('LOADING MODELS');
    $('#case-description').textContent = item.description;
    captureNote = `${item.title} — author-provided files. Display only; no reconstruction is run in the browser.`;
    const specs = item.models
      .filter(model => activeKeys.has(model.key))
      .map(model => ({
        key: model.key,
        label: model.label,
        ours: Boolean(model.ours),
        points: Boolean(model.points),
        bytes: model.bytes,
        load: async signal => {
          const url = new URL(model.src, document.baseURI);
          const modelsRoot = new URL('./assets/models/', document.baseURI);
          if (url.origin !== modelsRoot.origin || !url.pathname.startsWith(modelsRoot.pathname)) throw new Error('Model paths must stay inside assets/models/.');
          const response = await fetch(url, { signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          if (Number(response.headers.get('content-length')) > 50 * 1024 * 1024) throw new Error('file exceeds 50 MB');
          return parseModel(await response.arrayBuffer(), url.pathname);
        },
      }));
    renderChips();
    const ok = await applyPanels(specs, { preserveCamera });
    if (!ok || currentCase !== item) return;
    setBadge('AUTHOR-PROVIDED MODELS', true);
    const notes = item.models.filter(model => activeKeys.has(model.key) && model.note);
    const vertices = viewer.totalVertices();
    status(`Showing ${activeKeys.size} models · ${(vertices / 1e6).toFixed(2)} M vertices. No registration is applied.`
      + (notes.length ? ` Check: ${notes.map(model => `${model.label} (${model.note})`).join(' ')}` : ''));
  }

  function toggleMethod(key) {
    if (!currentCase) return;
    if (activeKeys.has(key)) {
      if (activeKeys.size <= 2) { status('At least two models are needed for a comparison.', true); return; }
      activeKeys.delete(key);
    } else {
      if (activeKeys.size >= MAX_PANELS) { status(`At most ${MAX_PANELS} panels at once. Switch one off first.`, true); return; }
      activeKeys.add(key);
    }
    renderCase().catch(fail);
  }

  async function importFile(file, key) {
    if (!file) return;
    if (loading) { status('Please wait for this comparison to finish loading before importing a file.', true); return; }
    const slot = viewer.slotByKey(key);
    if (!slot) return;
    const current = generation;
    const version = (importVersions.get(key) ?? 0) + 1;
    importVersions.set(key, version);
    let model;
    try {
      if (file.size > 50 * 1024 * 1024) throw new Error('File exceeds 50 MB. Please export a lighter model.');
      status(`Reading ${file.name} locally…`);
      model = await parseModel(await file.arrayBuffer(), file.name);
      if (current !== generation || importVersions.get(key) !== version) { disposeObject(model); return; }
      viewer.replaceModel(key, model);
      model = null;
      slot.spec.label = file.name;
      slot.card.querySelector('.viewer-card-heading strong').textContent = file.name;
      setBadge('MIXED SOURCES');
      captureNote = 'Mixed sources: an imported local model replaces one panel. Method labels and alignment have not been verified.';
      $('#case-description').textContent = captureNote;
      status(`Loaded ${file.name}. No file was uploaded. ${defaultStatus}`);
    } catch (error) {
      if (model) disposeObject(model);
      if (current === generation && importVersions.get(key) === version) status(`Could not import ${file.name}: ${error.message} The previous model is unchanged.`, true);
    }
  }

  $('#viewer-grid').addEventListener('change', event => {
    const input = event.target.closest('input[type=file]');
    if (!input) return;
    importFile(input.files[0], input.dataset.key);
    input.value = '';
  });
  $('#viewer-grid').addEventListener('drop', event => {
    const card = event.target.closest('.viewer-card');
    if (!card) return;
    event.preventDefault();
    card.classList.remove('drag-over');
    if (event.dataTransfer.files.length !== 1) { status('Drop one model file onto a panel.', true); return; }
    importFile(event.dataTransfer.files[0], card.dataset.key);
  });
  $$('[data-mode]').forEach(button => button.addEventListener('click', () => {
    viewer.mode = button.dataset.mode;
    viewer.applyMode();
    $$('[data-mode]').forEach(item => {
      item.classList.toggle('selected', item === button);
      item.setAttribute('aria-pressed', String(item === button));
    });
  }));
  $('#sync-toggle').addEventListener('click', event => {
    viewer.setSynced(!viewer.synced);
    event.currentTarget.classList.toggle('selected', viewer.synced);
    event.currentTarget.setAttribute('aria-pressed', String(viewer.synced));
  });
  $('#rotate-toggle').addEventListener('click', event => {
    viewer.autoRotate = !viewer.autoRotate;
    event.currentTarget.classList.toggle('selected', viewer.autoRotate);
    event.currentTarget.setAttribute('aria-pressed', String(viewer.autoRotate));
  });
  $('#reset-view').addEventListener('click', () => viewer.reset());
  $('#clip-toggle').addEventListener('change', event => { viewer.clipping = event.target.checked; viewer.applyClipping(); });
  $('#clip-position').addEventListener('input', event => { viewer.clipPlane.constant = Number(event.target.value); viewer.invalidate(); });
  $('#point-size').addEventListener('input', event => { viewer.pointSize = Number(event.target.value); viewer.applyMode(); });
  $('#alignment-toggle').addEventListener('change', event => {
    viewer.sharedCoordinates = event.target.checked;
    viewer.fitModels();
    status(event.target.checked ? 'Shared coordinates: one scale and translation are applied to all models. No registration is performed.' : 'Independent fit: each panel is centered and scaled separately. Not suitable for a scale-accurate comparison.');
  });
  $('#capture').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const alignment = viewer.sharedCoordinates ? ' Shared coordinates.' : ' Independent fit: scales are not comparable.';
      const title = `${currentCase.title} · ${viewer.slots.map(slot => slot.spec.label).join(' / ')}`;
      const blob = await viewer.capture(title, captureNote + alignment);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'geometry-comparison.png';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      status('Comparison image saved with source and alignment information.');
    } catch (error) { status(error.message, true); }
    finally { button.disabled = false; }
  });

  cases.forEach(item => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'case-tab';
    button.dataset.case = item.id;
    button.textContent = item.title;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => selectCase(item));
    $('#case-tabs').append(button);
  });
  selectCase(cases[0]);
  window.addEventListener('pagehide', event => {
    if (!event.persisted) { generation++; pendingRequest?.abort(); viewer.dispose(); }
  }, { once: true });
}

const regions = $$('[data-explorer]');
const template = $('#explorer-template');
regions.forEach(region => region.querySelector('.explorer-host').append(template.content.cloneNode(true)));

function unavailable(region, error) {
  const message = region.querySelector('[data-role="viewer-status"]');
  message.textContent = `Models unavailable: ${error.message}. The descriptions and figures remain available below.`;
  message.classList.add('error');
  region.querySelectorAll('button, input').forEach(control => { control.disabled = true; });
}

async function initializePage() {
  const response = await fetch('./assets/examples.json');
  if (!response.ok) throw new Error(`Examples manifest: HTTP ${response.status}`);
  const manifest = await response.json();
  if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.cases)) throw new Error('Unsupported examples manifest.');
  const ids = new Set();
  manifest.cases.forEach(item => {
    if (!item?.id || ids.has(item.id) || typeof item.title !== 'string' || typeof item.description !== 'string'
      || !Array.isArray(item.models) || item.models.length < 2
      || new Set(item.models.map(model => model.key)).size !== item.models.length
      || item.models.some(model => !model.key || typeof model.label !== 'string' || typeof model.src !== 'string')) {
      throw new Error('Invalid or duplicate model case.');
    }
    ids.add(item.id);
  });
  await Promise.all(regions.map(async region => {
    try {
      const cases = manifest.cases.filter(item => item.group === region.dataset.explorer);
      if (!cases.length) throw new Error('No cases configured for this section.');
      await initializeExplorer(region, cases);
    } catch (error) { unavailable(region, error); }
  }));
}

initializePage().catch(error => regions.forEach(region => unavailable(region, error)));
