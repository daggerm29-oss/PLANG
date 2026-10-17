export type TrackKind = "aircraft" | "ship" | "satellite";

export interface EntityRef {
  kind: TrackKind;
  id: string;
}

/** Normalised live state fed to the cinematic 3D tracker. */
export interface FollowTarget {
  kind: TrackKind;
  id: string;
  modelUrl: string;
  lat?: number;
  lon?: number;
  /** Altitude above the ellipsoid in metres. */
  altM?: number;
  headingDeg?: number;
  /** Ground speed in m/s (used for dead reckoning between samples). */
  speedMs?: number;
}

export const FT_TO_M = 0.3048;
export const KTS_TO_MS = 0.514444;

export function altMetersFromBaro(alt: number | string | undefined): number {
  if (alt === undefined || alt === null) return 300;
  if (alt === "ground") return 0;
  const n = Number(alt);
  return Number.isNaN(n) ? 300 : n * FT_TO_M;
}

export function shipModel(base: string, category?: string): string {
  return `${base}/${category === "TANKER" ? "tanker.glb" : "ship.glb"}`;
}

export function satelliteModel(base: string, name: string): string {
  return `${base}/${/ISS|ZARYA/i.test(name) ? "iss.glb" : "satellite.glb"}`;
}

export function aircraftModel(base: string, military: boolean): string {
  return `${base}/${military ? "military-aircraft.glb" : "aeroplane.glb"}`;
}

/** Initial bearing (deg) from point 1 to point 2. */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x =
    Math.cos(lat1 * r) * Math.sin(lat2 * r) -
    Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return ((Math.atan2(y, x) / r) + 360) % 360;
}
