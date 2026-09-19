import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  PanResponder,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { GLView } from 'expo-gl';
import * as THREE from 'three';

function makeMat(color, extras = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.45,
    metalness: 0.15,
    ...extras,
  });
}

function box(w, h, d, material, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  return mesh;
}

function cyl(radius, height, material, x, y, z, rotX = 0) {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, height, 32),
    material
  );
  mesh.position.set(x, y, z);
  mesh.rotation.x = rotX;
  return mesh;
}

function sphere(radius, material, x, y, z) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 14, 12), material);
  mesh.position.set(x, y, z);
  return mesh;
}

function addRibbon(group, material, points) {
  const path = new THREE.CatmullRomCurve3(
    points.map(([x, y, z]) => new THREE.Vector3(x, y, z))
  );
  const shape = new THREE.Shape();
  const hw = 0.2;
  const ht = 0.012;
  shape.moveTo(-hw, -ht);
  shape.lineTo(hw, -ht);
  shape.lineTo(hw, ht);
  shape.lineTo(-hw, ht);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, {
    steps: 28,
    bevelEnabled: false,
    extrudePath: path,
  });
  group.add(new THREE.Mesh(geo, material));
  return path;
}

function addWire(group, material, points, radius = 0.032) {
  const path = new THREE.CatmullRomCurve3(
    points.map(([x, y, z]) => new THREE.Vector3(x, y, z))
  );
  group.add(
    new THREE.Mesh(new THREE.TubeGeometry(path, 24, radius, 8, false), material)
  );
}

/** XIAO ESP32-S3 + Sense camera folded onto the board + patch antenna. */
function createEsp32Sense() {
  const group = new THREE.Group();

  const pcb = makeMat(0x161616, { roughness: 0.72, metalness: 0.08 });
  const gold = makeMat(0xd4af67, { roughness: 0.28, metalness: 0.85 });
  const flexGold = makeMat(0xc9a227, { roughness: 0.4, metalness: 0.7 });
  const silver = makeMat(0xc5c8cc, { roughness: 0.32, metalness: 0.7 });
  const shield = makeMat(0xf4f1ea, { roughness: 0.55, metalness: 0.15 });
  const zif = makeMat(0xf3efe6, { roughness: 0.65 });
  const lens = makeMat(0x111111, { roughness: 0.22, metalness: 0.35 });
  const glass = makeMat(0x1d4a38, {
    roughness: 0.08,
    metalness: 0.25,
    transparent: true,
    opacity: 0.88,
  });
  const coral = makeMat(0xff493d, { roughness: 0.4, emissive: 0xff493d, emissiveIntensity: 0.3 });
  const cream = makeMat(0xf3f0dc, { roughness: 0.7 });
  const solder = makeMat(0xc0b8a0, { roughness: 0.22, metalness: 0.9 });
  const pack = makeMat(0x2c2c2c, { roughness: 0.55, metalness: 0.12 });
  const antennaMat = makeMat(0x1a1a1a, { roughness: 0.7, metalness: 0.08 });
  const wireW = makeMat(0xf5f5f5, { roughness: 0.55 });
  const wireB = makeMat(0x111111, { roughness: 0.55 });

  // XIAO ESP32-S3
  group.add(box(1.78, 0.12, 2.05, pcb, 0, 0, 0.15));
  for (let i = 0; i < 7; i += 1) {
    const z = -0.72 + i * 0.29;
    group.add(box(0.1, 0.13, 0.15, gold, -0.9, 0, z));
    group.add(box(0.1, 0.13, 0.15, gold, 0.9, 0, z));
  }
  group.add(box(0.86, 0.22, 0.32, silver, 0, 0.08, 1.08));
  group.add(box(0.62, 0.1, 0.18, makeMat(0x111111), 0, 0.08, 1.16));
  group.add(box(1.18, 0.06, 1.18, shield, 0, 0.1, 0.08));
  group.add(cyl(0.07, 0.05, cream, -0.55, 0.1, 0.78));
  group.add(cyl(0.07, 0.05, coral, 0.55, 0.1, 0.78));

  // Sense board on the camera end, white ZIF along that edge
  group.add(box(1.7, 0.1, 1.2, pcb, 0, 0.04, -0.95));
  group.add(box(1.22, 0.18, 0.32, zif, 0, 0.18, -1.42));

  // Gold flex folds BACK over the board (not away from it)
  addRibbon(group, flexGold, [
    [0, 0.2, -1.28],
    [0, 0.22, -1.52],
    [0, 0.48, -1.48],
    [0, 0.52, -1.05],
    [0, 0.4, -0.55],
  ]);

  // Flat camera sitting on the board, lens facing up
  group.add(box(0.72, 0.12, 0.72, pcb, 0, 0.38, -0.35));
  group.add(cyl(0.26, 0.08, lens, 0, 0.48, -0.35));
  group.add(cyl(0.1, 0.04, glass, 0, 0.53, -0.35));

  // U.FL next to the camera, coax out to the patch antenna
  group.add(cyl(0.08, 0.07, gold, -0.58, 0.16, -0.32));
  group.add(cyl(0.05, 0.04, silver, -0.58, 0.21, -0.32));
  addWire(
    group,
    wireB,
    [
      [-0.58, 0.2, -0.32],
      [-1.15, 0.12, -0.15],
      [-1.9, 0.08, 0.35],
      [-2.45, 0.14, 0.55],
    ],
    0.045
  );
  group.add(box(1.85, 0.05, 1.15, antennaMat, -3.15, 0.06, 0.55));
  group.add(cyl(0.07, 0.08, gold, -2.55, 0.12, 0.55));
  group.add(cyl(0.04, 0.05, silver, -2.55, 0.17, 0.55));

  // Battery is a separate pack; both leads solder to the underside
  group.add(box(1.15, 0.32, 1.85, pack, 2.05, -0.12, 0.05));
  group.add(box(0.95, 0.02, 1.65, silver, 2.05, -0.28, 0.05));
  group.add(box(0.22, 0.03, 0.18, gold, -0.28, -0.09, 0.78));
  group.add(box(0.22, 0.03, 0.18, gold, 0.28, -0.09, 0.78));
  group.add(sphere(0.07, solder, -0.28, -0.13, 0.78));
  group.add(sphere(0.07, solder, 0.28, -0.13, 0.78));
  addWire(group, wireW, [
    [1.48, -0.18, 0.42],
    [0.95, -0.3, 0.6],
    [0.5, -0.22, 0.72],
    [0.28, -0.13, 0.78],
  ]);
  addWire(group, wireB, [
    [1.48, -0.18, -0.22],
    [0.7, -0.34, 0.18],
    [0.05, -0.24, 0.55],
    [-0.28, -0.13, 0.78],
  ]);

  const pinMat = makeMat(0xff493d, { roughness: 0.35, emissive: 0xff493d, emissiveIntensity: 0.25 });
  const anchors = {
    camera: new THREE.Vector3(0, 0.78, -0.35),
    antenna: new THREE.Vector3(-3.15, 0.38, 0.55),
    sense: new THREE.Vector3(0, 0.42, -1.15),
    battery: new THREE.Vector3(2.05, 0.28, 0.05),
  };
  Object.values(anchors).forEach((pos) => {
    group.add(sphere(0.09, pinMat, pos.x, pos.y, pos.z));
  });

  return { group, anchors };
}

const PARTS = [
  {
    id: 'camera',
    n: '1',
    title: 'Camera',
    body: 'OV2640 JPEG bursts over BLE every ~5s for on-device vision — not a live stream, and no frames leave the laptop.',
  },
  {
    id: 'antenna',
    n: '2',
    title: 'Antenna',
    body: 'External 2.4 GHz patch antenna extends BLE range up to 330 ft.',
  },
  {
    id: 'sense',
    n: '3',
    title: 'Sense board',
    body: 'Seeed XIAO ESP32-S3 Sense with dual wireless: Wi-Fi and Bluetooth 5 LE.',
  },
  {
    id: 'battery',
    n: '4',
    title: 'Battery',
    body: 'LiPo pack with hand-soldered leads so the glasses run untethered.',
  },
];

function createRenderer(gl) {
  const { drawingBufferWidth: width, drawingBufferHeight: height } = gl;
  const canvas = {
    width,
    height,
    style: {},
    addEventListener() {},
    removeEventListener() {},
    clientWidth: width,
    clientHeight: height,
    getContext(type) {
      // Three r163+ throws if a context is passed that instanceof WebGLRenderingContext.
      // Expo's WebGL2 context inherits from WebGLRenderingContext (spec-correct), so
      // we let Three request webgl2 instead of passing `context: gl`.
      return type === 'webgl2' ? gl : null;
    },
  };
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: false,
  });
  renderer.setSize(width, height);
  renderer.setClearColor(0xf3f0dc, 1);
  return renderer;
}

export default function Esp32SenseViewer() {
  const aliveRef = useRef(true);
  const frameRef = useRef(null);
  const rotRef = useRef({ x: 0.22, y: 0.85 });
  const dragRef = useRef({
    active: false,
    lastX: 0,
    lastY: 0,
    idleAt: 0,
  });
  const cameraRef = useRef(null);
  const boardRef = useRef(null);
  const anchorsRef = useRef(null);
  const layoutRef = useRef({ width: 1, height: 1 });
  const scratchRef = useRef(new THREE.Vector3());
  const badgeAnims = useRef(
    Object.fromEntries(
      PARTS.map((part) => [
        part.id,
        {
          x: new Animated.Value(-80),
          y: new Animated.Value(-80),
          o: new Animated.Value(0),
        },
      ])
    )
  ).current;
  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, []);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: () => {
        dragRef.current.active = true;
        dragRef.current.lastX = 0;
        dragRef.current.lastY = 0;
      },
      onPanResponderMove: (_, gesture) => {
        rotRef.current.y += (gesture.dx - dragRef.current.lastX) * 0.012;
        rotRef.current.x += (gesture.dy - dragRef.current.lastY) * 0.01;
        rotRef.current.x = Math.max(-1.35, Math.min(1.25, rotRef.current.x));
        dragRef.current.lastX = gesture.dx;
        dragRef.current.lastY = gesture.dy;
      },
      onPanResponderRelease: () => {
        dragRef.current.active = false;
        dragRef.current.idleAt = Date.now();
      },
      onPanResponderTerminate: () => {
        dragRef.current.active = false;
        dragRef.current.idleAt = Date.now();
      },
    })
  ).current;

  const onContextCreate = (gl) => {
    if (!gl.getShaderPrecisionFormat) {
      gl.getShaderPrecisionFormat = () => ({
        rangeMin: 1,
        rangeMax: 1,
        precision: 1,
      });
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf3f0dc);

    const camera = new THREE.PerspectiveCamera(
      38,
      gl.drawingBufferWidth / Math.max(1, gl.drawingBufferHeight),
      0.1,
      80
    );
    camera.position.set(5.6, 3.2, 5.0);
    camera.lookAt(-0.4, 0.2, -0.1);
    cameraRef.current = camera;

    const renderer = createRenderer(gl);

    scene.add(new THREE.AmbientLight(0xfff6e8, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(3, 5, 4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x91cfdd, 0.4);
    fill.position.set(-3, 2, -2);
    scene.add(fill);
    const under = new THREE.DirectionalLight(0xfff1d6, 0.7);
    under.position.set(0, -4, 1.5);
    scene.add(under);

    const { group, anchors } = createEsp32Sense();
    boardRef.current = group;
    anchorsRef.current = anchors;
    scene.add(group);

    const render = () => {
      if (!aliveRef.current) {
        return;
      }
      frameRef.current = requestAnimationFrame(render);
      if (!dragRef.current.active && Date.now() - dragRef.current.idleAt > 500) {
        rotRef.current.y += 0.007;
      }
      group.rotation.x = rotRef.current.x;
      group.rotation.y = rotRef.current.y;
      renderer.render(scene, camera);
      gl.endFrameEXP();

      const anchors = anchorsRef.current;
      const { width, height } = layoutRef.current;
      if (anchors && width > 8) {
        group.updateMatrixWorld(true);
        const v = scratchRef.current;
        PARTS.forEach((part) => {
          const local = anchors[part.id];
          const anim = badgeAnims[part.id];
          if (!local || !anim) {
            return;
          }
          v.copy(local);
          group.localToWorld(v);
          v.project(camera);
          const behind =
            v.z > 1 || v.x < -1.2 || v.x > 1.2 || v.y < -1.2 || v.y > 1.2;
          anim.x.setValue((v.x * 0.5 + 0.5) * width - 16);
          anim.y.setValue((-v.y * 0.5 + 0.5) * height - 16);
          anim.o.setValue(behind ? 0 : 1);
        });
      }
    };
    render();
  };

  const selected = PARTS.find((part) => part.id === selectedId);

  return (
    <View style={styles.wrap}>
      <Text style={styles.kicker}>HARDWARE</Text>
      <View
        style={styles.stage}
        onLayout={(event) => {
          layoutRef.current = event.nativeEvent.layout;
        }}
      >
        <View
          {...panResponder.panHandlers}
          style={StyleSheet.absoluteFill}
          pointerEvents="box-only"
        >
          <GLView
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
            onContextCreate={onContextCreate}
          />
        </View>
        {PARTS.map((part) => {
          const active = selectedId === part.id;
          const anim = badgeAnims[part.id];
          return (
            <Animated.View
              key={part.id}
              pointerEvents="box-none"
              style={[
                styles.badge,
                {
                  transform: [
                    { translateX: anim.x },
                    { translateY: anim.y },
                  ],
                  opacity: anim.o,
                },
                active && styles.badgeActive,
              ]}
            >
              <TouchableOpacity
                onPress={() =>
                  setSelectedId((current) =>
                    current === part.id ? null : part.id
                  )
                }
                style={styles.badgeHit}
              >
                <Text
                  style={[styles.badgeText, active && styles.badgeTextActive]}
                >
                  {part.n}
                </Text>
              </TouchableOpacity>
            </Animated.View>
          );
        })}
      </View>
      <View style={styles.chipRow}>
        {PARTS.map((part) => {
          const active = selectedId === part.id;
          return (
            <TouchableOpacity
              key={part.id}
              onPress={() =>
                setSelectedId((current) => (current === part.id ? null : part.id))
              }
              style={[styles.chip, active && styles.chipActive]}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {part.n}  {part.title}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
      {selected ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{selected.title}</Text>
          <Text style={styles.cardBody}>{selected.body}</Text>
        </View>
      ) : (
        <Text style={styles.hint}>Tap 1–4 for specs · drag to rotate</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginBottom: 22,
  },
  kicker: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 11,
    letterSpacing: 1.4,
    color: '#746f61',
    marginBottom: 10,
  },
  stage: {
    height: 320,
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(23, 21, 15, 0.14)',
    backgroundColor: '#f3f0dc',
  },
  hint: {
    fontFamily: 'Outfit_400Regular',
    fontSize: 12,
    color: '#48443a',
    marginTop: 8,
  },
  badge: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255, 255, 245, 0.92)',
    borderWidth: 1,
    borderColor: 'rgba(23, 21, 15, 0.18)',
    zIndex: 4,
  },
  badgeHit: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeActive: {
    backgroundColor: '#17150f',
  },
  badgeText: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 13,
    color: '#14130f',
  },
  badgeTextActive: {
    color: '#f8f1e3',
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 10,
  },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 245, 0.55)',
    borderWidth: 1,
    borderColor: 'rgba(23, 21, 15, 0.14)',
  },
  chipActive: {
    backgroundColor: '#17150f',
  },
  chipText: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 11,
    color: '#14130f',
  },
  chipTextActive: {
    color: '#f8f1e3',
  },
  card: {
    marginTop: 10,
    padding: 14,
    borderRadius: 16,
    backgroundColor: 'rgba(255, 255, 245, 0.72)',
    borderWidth: 1,
    borderColor: 'rgba(23, 21, 15, 0.14)',
  },
  cardTitle: {
    fontFamily: 'Outfit_600SemiBold',
    fontSize: 14,
    color: '#14130f',
    marginBottom: 4,
  },
  cardBody: {
    fontFamily: 'Outfit_400Regular',
    fontSize: 13,
    lineHeight: 18,
    color: '#48443a',
  },
});
