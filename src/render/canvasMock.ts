/**
 * Recording CanvasRenderingContext2D mock for tests (jsdom has no canvas implementation).
 * Every method call is recorded as {name, args}; property sets are recorded too.
 */
import type { CanvasLike } from './types';

export interface RecordedCall {
  name: string;
  args: unknown[];
}

export interface MockContext {
  /**
   * Every method call in order. Property assignments are recorded here too, as
   * `{ name: 'set:globalAlpha', args: [value] }`, so a test can tell which alpha / composite mode
   * was in force for a given draw call.
   */
  calls: RecordedCall[];
  props: Record<string, unknown>;
  /** Number of calls with this method name. */
  count(name: string): number;
  /** Distinct method names called. */
  names(): Set<string>;
  /** Value of `set:<prop>` most recently assigned before call index `i` (undefined if never). */
  propBefore(i: number, prop: string): unknown;
  reset(): void;
}

export interface MockCanvas extends CanvasLike {
  clientWidth: number;
  clientHeight: number;
  ctx: MockContext;
}

export function createMockContext(canvas: CanvasLike): MockContext & CanvasRenderingContext2D {
  const calls: RecordedCall[] = [];
  const props: Record<string, unknown> = {
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    miterLimit: 10,
    lineDashOffset: 0,
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    direction: 'ltr',
    shadowBlur: 0,
    shadowColor: 'rgba(0, 0, 0, 0)',
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'low',
    filter: 'none',
  };
  const gradient = { addColorStop: () => undefined };
  const api: MockContext = {
    calls,
    props,
    count: (name) => calls.reduce((n, c) => (c.name === name ? n + 1 : n), 0),
    names: () => new Set(calls.map((c) => c.name)),
    propBefore: (i, prop) => {
      const key = `set:${prop}`;
      for (let j = Math.min(i, calls.length) - 1; j >= 0; j--) if (calls[j].name === key) return calls[j].args[0];
      return undefined;
    },
    reset: () => {
      calls.length = 0;
    },
  };
  const special: Record<string, unknown> = {
    canvas,
    measureText: (text: string) => {
      calls.push({ name: 'measureText', args: [text] });
      return { width: String(text).length * 8, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 };
    },
    createLinearGradient: (...args: unknown[]) => {
      calls.push({ name: 'createLinearGradient', args });
      return gradient;
    },
    createRadialGradient: (...args: unknown[]) => {
      calls.push({ name: 'createRadialGradient', args });
      return gradient;
    },
    createPattern: () => null,
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    isPointInPath: () => false,
  };
  const proxy = new Proxy(api as unknown as Record<string, unknown>, {
    get(target, key: string | symbol) {
      if (typeof key === 'symbol') return undefined;
      if (key in target) return (target as Record<string, unknown>)[key];
      if (key in special) return special[key];
      if (key in props) return props[key];
      // Any other member is a recorded no-op method.
      return (...args: unknown[]) => {
        calls.push({ name: key, args });
        return undefined;
      };
    },
    set(_target, key: string | symbol, value) {
      if (typeof key === 'string') {
        props[key] = value;
        calls.push({ name: `set:${key}`, args: [value] });
      }
      return true;
    },
  });
  return proxy as unknown as MockContext & CanvasRenderingContext2D;
}

export function createMockCanvas(width = 1280, height = 720): MockCanvas {
  const canvas = {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
  } as MockCanvas;
  const ctx = createMockContext(canvas);
  canvas.ctx = ctx;
  canvas.getContext = () => ctx;
  return canvas;
}

/** Canvas factory for Highway/SpriteCache/TextCache that hands out fresh mock canvases. */
export function mockCanvasFactory(created: MockCanvas[] = []): (w: number, h: number) => CanvasLike {
  return (w, h) => {
    const c = createMockCanvas(w, h);
    c.clientWidth = 0;
    c.clientHeight = 0;
    created.push(c);
    return c;
  };
}
