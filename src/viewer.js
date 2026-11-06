import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';

const BASELINE_COLORS = [0x9aa7b1, 0x7e8d99, 0x6b7c8a, 0x5a6c7b, 0x8b98a4];
const OURS_COLOR = 0x436781;
const INPUT_COLOR = 0xc3ccd3;
const OURS_BACKGROUND = 0xeef4f8;
const NEUTRAL_BACKGROUND = 0xf8fafb;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const MAX_VERTICES = 2_000_000;
const number = value => new Intl.NumberFormat('en-US').format(value);

function colorFor(spec, baselineIndex) {
  if (spec.points) return INPUT_COLOR;
  if (spec.ours) return OURS_COLOR;
  return BASELINE_COLORS[baselineIndex % BASELINE_COLORS.length];
}

export function disposeObject(root) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  root.traverse(node => {
    if (node.geometry) geometries.add(node.geometry);
    for (const material of [node.material].flat().filter(Boolean)) {
      materials.add(material);
      Object.values(material).forEach(value => { if (value?.isTexture) textures.add(value); });
    }
  });
  geometries.forEach(value => value.dispose());
  materials.forEach(value => value.dispose());
  textures.forEach(value => { value.dispose(); value.source?.data?.close?.(); });
}

export async function parseModel(buffer, filename) {
  if (buffer.byteLength > MAX_FILE_SIZE) throw new Error('File exceeds 50 MB. Please provide a lighter web export.');
  const extension = filename.split('.').pop().toLowerCase();
  let root;
  if (extension === 'glb') {
    const manager = new THREE.LoadingManager();
    manager.setURLModifier(url => {
      if (url.startsWith('blob:') || url.startsWith('data:')) return url;
      throw new Error('External GLB resources are disabled. Export a self-contained, uncompressed GLB.');
    });
    root = (await new GLTFLoader(manager).parseAsync(buffer, '')).scene;
  } else if (extension === 'obj') {
    root = new OBJLoader().parse(new TextDecoder().decode(buffer));
  } else if (extension === 'ply' || extension === 'stl') {
    const geometry = extension === 'ply' ? new PLYLoader().parse(buffer) : new STLLoader().parse(buffer);
    root = extension === 'ply' && !geometry.index
      ? new THREE.Points(geometry, new THREE.PointsMaterial())
      : new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  } else {
    throw new Error('Unsupported format. Use PLY, OBJ, STL, or self-contained GLB.');
  }
  try {
    let vertices = 0;
    root.traverse(node => {
      if (!node.isMesh && !node.isPoints) return;
      if (node.isSkinnedMesh || Object.keys(node.geometry.morphAttributes).length) throw new Error('Animated or deformable meshes are not supported. Export a static mesh.');
      const position = node.geometry.getAttribute('position');
      if (!position) return;
      vertices += position.count;
      if (vertices > MAX_VERTICES) throw new Error('Model exceeds 2 million vertices. Please decimate the web copy.');
      for (let i = 0; i < position.count; i++) {
        if (![position.getX(i), position.getY(i), position.getZ(i)].every(Number.isFinite)) throw new Error('Model contains invalid coordinates.');
      }
      const index = node.geometry.index;
      if (index) {
        for (let i = 0; i < index.count; i++) {
          if (index.getX(i) >= position.count || index.getX(i) < 0) throw new Error('Model contains invalid face indices.');
        }
      }
    });
    if (!vertices) throw new Error('No mesh or point-cloud geometry was found in this file.');
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty() || ![...box.min, ...box.max].every(Number.isFinite)) throw new Error('Model has an invalid bounding box.');
    return root;
  } catch (error) {
    disposeObject(root);
    throw error;
  }
}

export class ComparisonViewer {
  constructor(gridElement, onStats, onError) {
    this.grid = gridElement;
    this.slots = [];
    this.onStats = onStats;
    this.onError = onError;
    this.synced = true;
    this.sharedCoordinates = true;
    this.mode = 'surface';
    this.pointSize = 0.018;
    this.autoRotate = false;
    this.clipping = false;
    this.clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
    this.needsRender = true;
    this.synchronizing = false;
    this.observer = new ResizeObserver(() => this.resize());
    this.intersection = new IntersectionObserver(entries => {
      entries.forEach(entry => { const slot = this.slots.find(item => item.container === entry.target); if (slot) slot.visible = entry.isIntersecting; });
      this.invalidate();
    }, { rootMargin: '150px' });
    this.loop = this.loop.bind(this);
    this.frame = requestAnimationFrame(this.loop);
  }

  invalidate() { this.needsRender = true; }

  setSlots(specs) {
    this.clearSlots();
    let baselineIndex = 0;
    specs.forEach((spec, index) => {
      if (!spec.ours && !spec.points) baselineIndex++;
      const color = colorFor(spec, Math.max(baselineIndex - 1, 0));
      const card = document.createElement('article');
      card.className = `viewer-card${spec.ours ? ' accent-card' : ''}`;
      card.dataset.key = spec.key;
      const heading = document.createElement('div');
      heading.className = 'viewer-card-heading';
      heading.innerHTML = '<span></span><span class="panel-number"></span>';
      const nameWrap = heading.firstElementChild;
      const dot = document.createElement('i');
      dot.className = 'panel-dot';
      dot.style.background = `#${color.toString(16).padStart(6, '0')}`;
      const name = document.createElement('strong');
      name.textContent = spec.label;
      nameWrap.append(dot, name);
      heading.lastElementChild.textContent = String(index + 1).padStart(2, '0');
      const container = document.createElement('div');
      container.className = 'viewport';
      container.setAttribute('role', 'img');
      container.setAttribute('aria-label', `Interactive view of ${spec.label}`);
      const footer = document.createElement('div');
      footer.className = 'viewer-card-footer';
      const stats = document.createElement('span');
      stats.textContent = 'Queued…';
      const importLabel = document.createElement('label');
      importLabel.className = 'import-button';
      importLabel.tabIndex = 0;
      importLabel.setAttribute('role', 'button');
      importLabel.setAttribute('aria-label', `Import a model into the ${spec.label} panel`);
      importLabel.innerHTML = 'Import<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 13V3m-4 4 4-4 4 4M4 15v2h12v-2"/></svg>';
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.ply,.obj,.stl,.glb';
      input.hidden = true;
      input.dataset.key = spec.key;
      importLabel.append(input);
      importLabel.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.click(); }
      });
      importLabel.addEventListener('click', event => {
        if (event.target !== input) { event.preventDefault(); input.click(); }
      });
      footer.append(stats, importLabel);
      card.append(heading, container, footer);
      card.addEventListener('dragover', event => { event.preventDefault(); card.classList.add('drag-over'); });
      card.addEventListener('dragleave', event => { if (!card.contains(event.relatedTarget)) card.classList.remove('drag-over'); });
      this.grid.append(card);
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
      renderer.setClearColor(spec.ours ? OURS_BACKGROUND : NEUTRAL_BACKGROUND);
      renderer.localClippingEnabled = true;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.4;
      container.append(renderer.domElement);
      renderer.domElement.addEventListener('webglcontextlost', event => {
        event.preventDefault();
        if (container.isConnected) this.onError('3D graphics context was lost. Reload the page or show fewer models at once.');
      });
      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xffffff, 0x7b7869, 3));
      const key = new THREE.DirectionalLight(0xfff7ed, 4.5);
      key.position.set(3, 5, 4);
      scene.add(key);
      const fill = new THREE.DirectionalLight(0xffffff, 1.8);
      fill.position.set(-3, 1, -2);
      scene.add(fill);
      const camera = new THREE.PerspectiveCamera(36, 1, 0.01, 200);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = false;
      controls.minDistance = 0.25;
      controls.maxDistance = 25;
      controls.autoRotateSpeed = 0.7;
      controls.addEventListener('change', () => {
        if (this.synced && !this.synchronizing) this.syncFrom(spec.key);
        this.invalidate();
      });
      const grid = new THREE.GridHelper(10, 30, 0xdde5ec, 0xe8eff4);
      grid.position.y = -1.58;
      grid.material.transparent = true;
      grid.material.opacity = 0.4;
      scene.add(grid);
      this.slots.push({ key: spec.key, spec, color, renderer, scene, camera, controls, container, card, stats, root: null, index, visible: true });
      this.observer.observe(container);
      this.intersection.observe(container);
    });
    this.grid.dataset.columns = String(this.columns(specs.length));
    this.resize();
  }

  columns(count) {
    if (count <= 3) return count;
    if (count === 4) return 2;
    return 3;
  }

  clearSlots() {
    this.slots.forEach(slot => {
      this.observer.unobserve(slot.container);
      this.intersection.unobserve(slot.container);
      slot.controls.dispose();
      disposeObject(slot.scene);
      slot.renderer.dispose();
      slot.renderer.forceContextLoss?.();
      slot.card.remove();
    });
    this.slots = [];
    this.grid.replaceChildren();
  }

  slotByKey(key) { return this.slots.find(slot => slot.key === key); }

  syncFrom(key) {
    const source = this.slotByKey(key);
    if (!source) return;
    this.synchronizing = true;
    this.slots.forEach(slot => {
      if (slot === source) return;
      slot.camera.position.copy(source.camera.position);
      slot.camera.quaternion.copy(source.camera.quaternion);
      slot.camera.zoom = source.camera.zoom;
      slot.camera.updateProjectionMatrix();
      slot.controls.target.copy(source.controls.target);
      slot.controls.update();
    });
    this.synchronizing = false;
  }

  setSynced(value) {
    this.synced = value;
    if (value && this.slots.length) this.syncFrom(this.slots[0].key);
    this.invalidate();
  }

  replaceModel(key, source) {
    const slot = this.slotByKey(key);
    if (!slot) { disposeObject(source); return; }
    const root = new THREE.Group();
    const surfaces = new THREE.Group();
    const vertices = new THREE.Group();
    const nativePoints = new THREE.Group();
    let pointCount = 0;
    let faceCount = 0;
    source.updateMatrixWorld(true);
    source.traverse(node => {
      if ((!node.isMesh && !node.isPoints) || !node.geometry.getAttribute('position')) return;
      const geometry = node.geometry.clone().applyMatrix4(node.matrixWorld);
      const count = geometry.getAttribute('position').count;
      pointCount += count;
      const useInputColors = slot.key === 'input' && geometry.hasAttribute('color');
      const pointMaterial = new THREE.PointsMaterial({
        color: useInputColors ? 0xffffff : slot.color,
        vertexColors: useInputColors,
        size: this.pointSize,
        sizeAttenuation: true,
        toneMapped: !useInputColors,
      });
      if (node.isPoints) {
        nativePoints.add(new THREE.Points(geometry, pointMaterial));
      } else {
        if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
        const material = new THREE.MeshStandardMaterial({ color: slot.color, roughness: 0.62, metalness: 0.03, side: THREE.DoubleSide });
        surfaces.add(new THREE.Mesh(geometry, material));
        vertices.add(new THREE.Points(geometry, pointMaterial));
        faceCount += Math.floor((geometry.index?.count ?? count) / 3);
      }
    });
    disposeObject(source);
    root.add(surfaces, vertices, nativePoints);
    const bounds = new THREE.Box3().setFromObject(root);
    if (slot.root) { slot.scene.remove(slot.root); disposeObject(slot.root); }
    Object.assign(slot, { root, surfaces, vertices, nativePoints, bounds, pointCount, faceCount });
    slot.scene.add(root);
    slot.stats.textContent = `${number(pointCount)} ${faceCount ? 'vertices' : 'points'}${faceCount ? ` · ${number(faceCount)} faces` : ''}`;
    this.onStats?.(slot);
    this.applyMode();
    this.applyClipping();
    this.fitModels();
  }

  totalVertices() {
    return this.slots.reduce((sum, slot) => sum + (slot.pointCount ?? 0), 0);
  }

  fitModels() {
    const sharedBox = new THREE.Box3();
    this.slots.forEach(slot => { if (slot.bounds) sharedBox.union(slot.bounds); });
    this.slots.forEach(slot => {
      if (!slot.root) return;
      const bounds = this.sharedCoordinates ? sharedBox : slot.bounds;
      const center = bounds.getCenter(new THREE.Vector3());
      const size = bounds.getSize(new THREE.Vector3());
      const scale = 2.75 / Math.max(size.x, size.y, size.z, 1e-6);
      slot.root.scale.setScalar(scale);
      slot.root.position.copy(center).multiplyScalar(-scale);
    });
    this.invalidate();
  }

  snapshotCamera() {
    const slot = this.slots[0];
    if (!slot) return null;
    return { position: slot.camera.position.clone(), quaternion: slot.camera.quaternion.clone(), target: slot.controls.target.clone(), zoom: slot.camera.zoom };
  }

  restoreCamera(state) {
    if (!state) return;
    this.synchronizing = true;
    this.slots.forEach(slot => {
      slot.camera.position.copy(state.position);
      slot.camera.quaternion.copy(state.quaternion);
      slot.camera.zoom = state.zoom;
      slot.camera.updateProjectionMatrix();
      slot.controls.target.copy(state.target);
      slot.controls.update();
    });
    this.synchronizing = false;
    this.invalidate();
  }

  reset() {
    this.synchronizing = true;
    this.slots.forEach(slot => {
      slot.camera.position.set(3.45, 2.65, 4.65);
      slot.camera.zoom = 1;
      slot.camera.updateProjectionMatrix();
      slot.controls.target.set(0, 0, 0);
      slot.controls.update();
    });
    this.synchronizing = false;
    this.invalidate();
  }

  applyMode() {
    this.slots.forEach(slot => {
      if (!slot.root) return;
      slot.surfaces.visible = this.mode !== 'points';
      slot.vertices.visible = this.mode === 'points';
      slot.surfaces.children.forEach(mesh => { mesh.material.wireframe = this.mode === 'wireframe'; });
      slot.root.traverse(node => { if (node.isPoints) node.material.size = this.pointSize; });
    });
    this.invalidate();
  }

  applyClipping() {
    this.slots.forEach(slot => slot.root?.traverse(node => {
      if (!node.material) return;
      node.material.clippingPlanes = this.clipping ? [this.clipPlane] : [];
      node.material.needsUpdate = true;
    }));
    this.invalidate();
  }

  resize() {
    this.slots.forEach(slot => {
      const width = Math.max(slot.container.clientWidth, 1);
      const height = Math.max(slot.container.clientHeight, 1);
      slot.camera.aspect = width / height;
      slot.camera.updateProjectionMatrix();
      slot.renderer.setSize(width, height, false);
    });
    this.invalidate();
  }

  loop(timestamp) {
    const delta = this.lastFrame ? Math.min((timestamp - this.lastFrame) / 1000, 0.05) : 0;
    this.lastFrame = timestamp;
    const visible = !document.hidden && this.slots.some(slot => slot.visible);
    if (visible && this.autoRotate) {
      this.slots.forEach((slot, index) => {
        slot.controls.autoRotate = !this.synced || index === 0;
        if (slot.controls.autoRotate) slot.controls.update(delta);
      });
      this.needsRender = true;
    } else {
      this.slots.forEach(slot => { slot.controls.autoRotate = false; });
    }
    if (visible && this.needsRender) {
      this.slots.forEach(slot => { if (slot.visible) slot.renderer.render(slot.scene, slot.camera); });
      this.needsRender = false;
    }
    this.frame = requestAnimationFrame(this.loop);
  }

  async capture(title, note) {
    const count = Math.max(this.slots.length, 1);
    const columns = Math.min(count, 3);
    const rows = Math.ceil(count / columns);
    const cellWidth = 700;
    const cellHeight = 630;
    const canvas = document.createElement('canvas');
    canvas.width = cellWidth * columns;
    canvas.height = cellHeight * rows + 115;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    this.slots.forEach((slot, index) => {
      slot.renderer.render(slot.scene, slot.camera);
      const image = slot.renderer.domElement;
      const column = index % columns;
      const row = Math.floor(index / columns);
      const fit = Math.min((cellWidth - 24) / image.width, (cellHeight - 70) / image.height);
      const imageWidth = image.width * fit;
      const imageHeight = image.height * fit;
      context.drawImage(image, column * cellWidth + (cellWidth - imageWidth) / 2, row * cellHeight + 60 + (cellHeight - 70 - imageHeight) / 2, imageWidth, imageHeight);
      context.fillStyle = '#383838';
      context.font = '600 20px "Segoe UI", Arial, sans-serif';
      context.fillText(slot.spec.label, column * cellWidth + 24, row * cellHeight + 34, cellWidth - 48);
    });
    context.fillStyle = '#436781';
    context.font = '600 19px "Segoe UI", Arial, sans-serif';
    context.fillText(`Anonymous comparison · ${title}`, 24, cellHeight * rows + 35);
    context.fillStyle = '#707070';
    context.font = '17px "Segoe UI", Arial, sans-serif';
    context.fillText(note, 24, cellHeight * rows + 70, canvas.width - 48);
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Image export failed.')), 'image/png'));
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.clearSlots();
    this.observer.disconnect();
    this.intersection.disconnect();
  }
}
