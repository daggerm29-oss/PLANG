import { useEffect, useRef, useState } from "react";
import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import type { TrackKind, FollowTarget } from "../lib/tracked-entity";

const ION_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI0YjdkMmFmMS04ZmU2LTQ4NDYtYTIwMS1hOTg5NGM2NzEzNGYiLCJpZCI6Mzk3MjQyLCJpYXQiOjE3NzI1Mzk5NDV9.sQ4V9RmCN2-xnXW2WZDxSAgaZTZFn9pohwFD9YzmWoU";

Cesium.Ion.defaultAccessToken = ION_TOKEN;

const EARTH_R = 6378137;
const INTRO_RANGE = 3_000_000;
const EXIT_MS = 1500;

const KIND_CONFIG: Record<
  TrackKind,
  {
    range: number;
    pitch: number;
    scale: number;
    minPixel: number;
    maxScale: number;
    smoothTau: number;
    minRange: number;
    maxRange: number;
    showGlobe: boolean;
  }
> = {
  aircraft: { range: 190, pitch: -0.42, scale: 2.2, minPixel: 96, maxScale: 500, smoothTau: 0.45, minRange: 30, maxRange: 8_000_000, showGlobe: false },
  ship: { range: 420, pitch: -0.5, scale: 60, minPixel: 110, maxScale: 400, smoothTau: 0.45, minRange: 60, maxRange: 8_000_000, showGlobe: true },
  satellite: { range: 90, pitch: -0.35, scale: 6, minPixel: 110, maxScale: 60, smoothTau: 0.2, minRange: 15, maxRange: 20_000_000, showGlobe: true },
};

// Cesium Ion serves Google Photorealistic 3D Tiles under its own licence, so it
// works without a billed Google Cloud project. A direct Google key is only a fallback.
async function loadGoogleTileset(): Promise<Cesium.Cesium3DTileset> {
  try {
    return await Cesium.createGooglePhotorealistic3DTileset();
  } catch (e) {
    console.error("Cesium Ion Google tiles failed, trying direct Google key", e);
  }
  const res = await fetch("/api/config/google-tiles");
  if (!res.ok) throw new Error("No Google tiles key configured");
  const { key } = (await res.json()) as { key: string };
  return Cesium.Cesium3DTileset.fromUrl(
    `https://tile.googleapis.com/v1/3dtiles/root.json?key=${encodeURIComponent(key)}`,
    { showCreditsOnScreen: true },
  );
}

// Tints Google 3D tiles into a dark blue/cyan night-vision look.
const TILESET_NIGHT_SHADER = new Cesium.CustomShader({
  lightingModel: Cesium.LightingModel.UNLIT,
  fragmentShaderText: `
    void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
      vec3 c = material.diffuse;
      float gray = dot(c, vec3(0.299, 0.587, 0.114));
      gray = pow(gray, 1.6) * 0.55;
      material.diffuse = vec3(gray * 0.18, gray * 0.78, gray * 1.0);
      material.alpha = 1.0;
    }
  `,
});

interface Props {
  target: FollowTarget;
  exiting?: boolean;
  onExited?: () => void;
}

interface Display {
  lon: number;
  lat: number;
  alt: number;
  heading: number;
}

export function CinematicTracker({ target, exiting = false, onExited }: Props) {
  const kind = target.kind;
  const cfg = KIND_CONFIG[kind];
  const containerRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<FollowTarget>(target);
  const sampleTimeRef = useRef<number>(performance.now());
  const displayRef = useRef<Display | null>(null);
  const camRef = useRef({
    heading: 0,
    yaw: 0,
    pitch: cfg.pitch,
    logRange: Math.log(INTRO_RANGE),
    logTarget: Math.log(cfg.range),
  });
  const [visible, setVisible] = useState(false);
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;

  // Latest sample → ref (dead reckoning restarts from the new sample).
  useEffect(() => {
    targetRef.current = target;
    sampleTimeRef.current = performance.now();
    if (displayRef.current === null && target.lat !== undefined && target.lon !== undefined) {
      displayRef.current = {
        lon: target.lon,
        lat: target.lat,
        alt: target.altM ?? 0,
        heading: target.headingDeg ?? 0,
      };
    }
  }, [target]);

  // Fade in once mounted.
  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Graceful exit: pull the camera back up, fade, then notify the parent.
  useEffect(() => {
    if (!exiting) return;
    camRef.current.logTarget = Math.log(INTRO_RANGE);
    const fade = setTimeout(() => setVisible(false), EXIT_MS * 0.45);
    const done = setTimeout(() => onExitedRef.current?.(), EXIT_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(done);
    };
  }, [exiting]);

  const exitingRef = useRef(exiting);
  exitingRef.current = exiting;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let viewer: Cesium.Viewer | null = null;
    const cleanups: Array<() => void> = [];

    (async () => {
      try {
        viewer = new Cesium.Viewer(container, {
          animation: false,
          baseLayerPicker: false,
          fullscreenButton: false,
          geocoder: false,
          homeButton: false,
          infoBox: false,
          sceneModePicker: false,
          selectionIndicator: false,
          timeline: false,
          navigationHelpButton: false,
          navigationInstructionsInitiallyVisible: false,
          baseLayer: false,
        });
        if (cancelled) {
          viewer.destroy();
          return;
        }

        const v = viewer;
        const scene = v.scene;
        scene.backgroundColor = Cesium.Color.BLACK;
        scene.globe.show = cfg.showGlobe;
        scene.globe.baseColor = Cesium.Color.fromCssColorString("#031626");
        scene.fog.enabled = false;
        if (scene.sun) scene.sun.show = true;
        if (scene.moon) scene.moon.show = true;
        if (scene.skyAtmosphere) scene.skyAtmosphere.show = kind === "satellite";
        scene.screenSpaceCameraController.enableInputs = false;

        const fixedTime = Cesium.JulianDate.fromIso8601("2024-06-15T22:30:00Z");
        v.clock.startTime = fixedTime.clone();
        v.clock.currentTime = fixedTime.clone();
        v.clock.stopTime = fixedTime.clone();
        v.clock.clockRange = Cesium.ClockRange.CLAMPED;
        v.clock.shouldAnimate = false;
        v.clock.multiplier = 0;

        if (cfg.showGlobe) {
          try {
            const layer = v.imageryLayers.addImageryProvider(
              new Cesium.OpenStreetMapImageryProvider({ url: "https://tile.openstreetmap.org/" }),
            );
            layer.brightness = 0.45;
            layer.saturation = 0.5;
          } catch (e) {
            console.error("Failed to add imagery", e);
          }
        }

        let photorealTilesLoaded = false;
        if (kind === "aircraft" || kind === "ship") {
          try {
            const tileset = await loadGoogleTileset();
            if (cancelled) return;
            if (kind === "aircraft") tileset.customShader = TILESET_NIGHT_SHADER;
            scene.primitives.add(tileset);
            // Google tiles include the sea surface; hide the globe to avoid z-fighting.
            scene.globe.show = false;
            photorealTilesLoaded = true;
          } catch (e) {
            console.error("Failed to load Google 3D tileset", e);
          }
        }

        const updateLight = () => {
          if (v.isDestroyed()) return;
          scene.light = new Cesium.DirectionalLight({
            direction: Cesium.Cartesian3.clone(scene.camera.directionWC),
            color: Cesium.Color.WHITE,
            intensity: 2.5,
          });
        };
        updateLight();

        const computePosition = (): Cesium.Cartesian3 => {
          const d = displayRef.current;
          if (!d) return Cesium.Cartesian3.fromDegrees(0, 0, 0);
          return Cesium.Cartesian3.fromDegrees(d.lon, d.lat, d.alt);
        };

        const entity = v.entities.add({
          position: new Cesium.CallbackProperty(computePosition, false) as unknown as Cesium.PositionProperty,
          orientation: new Cesium.CallbackProperty(() => {
            const hpr = new Cesium.HeadingPitchRoll(
              Cesium.Math.toRadians((displayRef.current?.heading ?? 0) - 90),
              0,
              0,
            );
            return Cesium.Transforms.headingPitchRollQuaternion(computePosition(), hpr);
          }, false) as unknown as Cesium.Property,
          model: {
            uri: targetRef.current.modelUrl,
            minimumPixelSize: cfg.minPixel,
            maximumScale: cfg.maxScale,
            scale: cfg.scale,
            shadows: Cesium.ShadowMode.DISABLED,
            imageBasedLightingFactor: new Cesium.Cartesian2(1.0, 1.0),
            color: Cesium.Color.WHITE,
          },
        });

        // Entity-based sea fallback for when the photorealistic tiles are unavailable.
        if (kind === "ship" && !photorealTilesLoaded) {
          v.entities.add({
            position: new Cesium.CallbackProperty(() => {
              const d = displayRef.current;
              return Cesium.Cartesian3.fromDegrees(d?.lon ?? 0, d?.lat ?? 0, -1);
            }, false) as unknown as Cesium.PositionProperty,
            ellipse: {
              semiMajorAxis: 60_000,
              semiMinorAxis: 60_000,
              height: 0,
              material: new Cesium.GridMaterialProperty({
                color: Cesium.Color.fromCssColorString("#0e7fa8").withAlpha(0.5),
                cellAlpha: 0.35,
                lineCount: new Cesium.Cartesian2(600, 600),
                lineThickness: new Cesium.Cartesian2(1.5, 1.5),
              }),
            },
          });
        }

        // Wingtip / strobe lights for aircraft only.
        if (kind === "aircraft") {
          const lights: { offset: [number, number, number]; color: Cesium.Color; size: number; strobe?: boolean }[] = [
            { offset: [0, -28, 0], color: Cesium.Color.RED, size: 14 },
            { offset: [0, 28, 0], color: Cesium.Color.LIME, size: 14 },
            { offset: [-22, 0, 4], color: Cesium.Color.WHITE, size: 14, strobe: true },
            { offset: [0, 0, -3], color: Cesium.Color.RED, size: 12, strobe: true },
          ];
          for (const l of lights) {
            const [fwd, rt, up] = l.offset;
            v.entities.add({
              position: new Cesium.CallbackProperty(() => {
                const pos = computePosition();
                const h = Cesium.Math.toRadians(displayRef.current?.heading ?? 0);
                const enu = new Cesium.Cartesian3(
                  fwd * Math.sin(h) + rt * Math.cos(h),
                  fwd * Math.cos(h) - rt * Math.sin(h),
                  up,
                );
                return Cesium.Matrix4.multiplyByPoint(
                  Cesium.Transforms.eastNorthUpToFixedFrame(pos),
                  enu,
                  new Cesium.Cartesian3(),
                );
              }, false) as unknown as Cesium.PositionProperty,
              point: {
                pixelSize: l.size,
                color: new Cesium.CallbackProperty(() => {
                  if (!l.strobe) return l.color;
                  return l.color.withAlpha(performance.now() % 850 < 110 ? 1 : 0.05);
                }, false) as unknown as Cesium.Property,
                outlineColor: Cesium.Color.TRANSPARENT,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                scaleByDistance: new Cesium.NearFarScalar(50, 1.4, 5000, 0.4),
              },
            });
          }
        }

        // Fading trail behind the object.
        const trail: Cesium.Cartesian3[] = [];
        let lastTrailMs = 0;
        v.entities.add({
          polyline: {
            positions: new Cesium.CallbackProperty(() => trail.slice(), false),
            width: kind === "satellite" ? 2 : 3,
            material: new Cesium.PolylineGlowMaterialProperty({
              glowPower: 0.25,
              color: Cesium.Color.CYAN.withAlpha(0.7),
            }),
          },
        });

        // ---- Per-frame update: dead reckoning, smoothing, camera follow ----
        let lastFrameMs = performance.now();

        scene.preRender.addEventListener(() => {
          if (v.isDestroyed()) return;
          updateLight();
          const now = performance.now();
          const dt = Math.min((now - lastFrameMs) / 1000, 0.1);
          lastFrameMs = now;
          const t = targetRef.current;
          const d = displayRef.current;
          if (!d || t.lat === undefined || t.lon === undefined) return;

          const elapsed = Math.min((now - sampleTimeRef.current) / 1000, 30);
          const dist = (t.speedMs ?? 0) * elapsed;
          const hdgRad = Cesium.Math.toRadians(t.headingDeg ?? d.heading);
          const tLat = t.lat + ((dist * Math.cos(hdgRad)) / EARTH_R) * (180 / Math.PI);
          const tLon =
            t.lon +
            ((dist * Math.sin(hdgRad)) / (EARTH_R * Math.max(Math.cos(Cesium.Math.toRadians(t.lat)), 0.01))) *
              (180 / Math.PI);

          const k = 1 - Math.exp(-dt / cfg.smoothTau);
          d.lon += (tLon - d.lon) * k;
          d.lat += (tLat - d.lat) * k;
          d.alt += ((t.altM ?? 0) - d.alt) * k;
          const dh = ((((t.headingDeg ?? d.heading) - d.heading + 540) % 360) - 180);
          d.heading += dh * k;

          const pos = computePosition();
          if (now - lastTrailMs > 250) {
            lastTrailMs = now;
            trail.push(pos);
            if (trail.length > 120) trail.shift();
          }

          const cam = camRef.current;
          cam.heading = Cesium.Math.toRadians(d.heading) + cam.yaw;
          const rk = 1 - Math.exp(-dt / (exitingRef.current ? 0.45 : 0.6));
          cam.logRange += (cam.logTarget - cam.logRange) * rk;
          scene.camera.lookAt(
            pos,
            new Cesium.HeadingPitchRange(cam.heading, cam.pitch, Math.exp(cam.logRange)),
          );
        });

        // ---- Orbit / zoom input ----
        let dragging = false;
        let lastX = 0;
        let lastY = 0;
        const onDown = (e: PointerEvent) => {
          dragging = true;
          lastX = e.clientX;
          lastY = e.clientY;
          container.setPointerCapture?.(e.pointerId);
        };
        const onMove = (e: PointerEvent) => {
          if (!dragging || exitingRef.current) return;
          const cam = camRef.current;
          cam.yaw -= (e.clientX - lastX) * 0.005;
          cam.pitch = Math.max(-1.5, Math.min(0.25, cam.pitch - (e.clientY - lastY) * 0.004));
          lastX = e.clientX;
          lastY = e.clientY;
        };
        const onUp = () => {
          dragging = false;
        };
        const onWheel = (e: WheelEvent) => {
          if (exitingRef.current) return;
          e.preventDefault();
          const cam = camRef.current;
          cam.logTarget = Math.max(
            Math.log(cfg.minRange),
            Math.min(Math.log(cfg.maxRange), cam.logTarget + e.deltaY * 0.001),
          );
        };
        container.addEventListener("pointerdown", onDown);
        container.addEventListener("pointermove", onMove);
        container.addEventListener("pointerup", onUp);
        container.addEventListener("pointercancel", onUp);
        container.addEventListener("wheel", onWheel, { passive: false });
        cleanups.push(() => {
          container.removeEventListener("pointerdown", onDown);
          container.removeEventListener("pointermove", onMove);
          container.removeEventListener("pointerup", onUp);
          container.removeEventListener("pointercancel", onUp);
          container.removeEventListener("wheel", onWheel);
        });

        void entity;
      } catch (e) {
        console.error("Cesium viewer init failed", e);
      }
    })();

    return () => {
      cancelled = true;
      cleanups.forEach((fn) => fn());
      try {
        if (viewer && !viewer.isDestroyed()) viewer.destroy();
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.modelUrl, kind]);

  return (
    <div
      ref={containerRef}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 5,
        background: "#000005",
        opacity: visible ? 1 : 0,
        transition: "opacity 0.7s ease",
        touchAction: "none",
        cursor: "grab",
      }}
    />
  );
}
